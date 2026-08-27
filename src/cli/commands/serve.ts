import { createRunId, shortId } from '../../util/ids.ts';
import { RelayError } from '../../util/errors.ts';
import { listRuns, RunStore } from '../../storage/runs.ts';
import { loadConfig } from '../../storage/config.ts';
import { createRunState } from '../../workflow/state.ts';
import { waitForAdmission } from '../../workflow/admission.ts';
import { formatCost } from '../../workflow/usage.ts';
import { assertUnattendedReady } from '../../unattended/policy.ts';
import { STOP_FILE } from '../../unattended/killSwitch.ts';
import { serve, type ServeEvent, type ServeOutcome, type ServeStart } from '../../unattended/serve.ts';
import { createCliContext, type CliContext } from '../context.ts';
import { EXIT } from '../exit.ts';
import { emitJsonLine } from '../json.ts';
import { executeRun } from './run.ts';
import { bullet, command, dim, failure, hint, out, rows, section, success, warning } from '../output.ts';

export interface ServeOptions {
  once?: boolean;
  /** `--issue <ref>`: consider only this one. What the GitHub Action passes. */
  issue?: string;
  label?: string;
  interval?: string;
  limit?: string;
  dryRun?: boolean;
  verbose?: boolean;
  json?: boolean;
}

/**
 * Watch the tracker, and start a run when somebody with the right to do so asks
 * for one by label.
 *
 * This is the only command that starts work with nobody present, which is why
 * it is also the command that refuses the most. It will not start at all until
 * the repository has answered three questions deliberately — who may trigger a
 * run, what one run may cost, and what a day of them may cost — and it stops
 * the moment any of the three kill switches says to.
 *
 * Ctrl-C means *stop starting*: the runs already in flight finish their own
 * pipelines and deliver what they have, because they are work somebody already
 * paid for. A second Ctrl-C cancels them, the way it does everywhere else.
 */
export async function serveCommand(options: ServeOptions = {}): Promise<number> {
  const cli = await createCliContext();
  const json = options.json === true;

  // Read once, and loudly, before anything watches anything: the guardrails are
  // preconditions, and a server that started and then refused every issue would
  // be a much worse way to learn that the allowlist is empty.
  const startup = await loadConfig(cli.repo.root);
  if (options.label !== undefined) startup.workflow.triggerLabel = options.label.trim();
  assertUnattendedReady(startup);
  if (cli.repo.owner === null || cli.repo.name === null) {
    throw new RelayError('This repository has no GitHub remote, so there is no tracker to watch.', {
      code: 'NOT_A_REPOSITORY',
      hint: 'Add an `origin` remote pointing at the repository whose issues should start runs.',
    });
  }

  // Two controllers, because the two signals mean different things. The first
  // stops the *loop* and nothing else — that is the kill switch, and its whole
  // promise is that runs in flight are not touched. Only the second reaches the
  // runs, which is a person deciding the work in progress is not worth waiting
  // for. One controller could not tell those apart.
  const controller = new AbortController();
  const runs = new AbortController();
  const stopping = { asked: false };
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping.asked) {
      out(warning(`  ${signal} again — cancelling the runs still in flight.`));
      runs.abort();
      return;
    }
    stopping.asked = true;
    out();
    out(warning(`  ${signal} — starting nothing more. Runs in flight will finish.`));
    hint('Press Ctrl-C again to cancel them, or run `relay stop <run>` for one of them.');
    controller.abort();
  };
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) process.on(signal, onSignal);

  try {
    const outcome = await serve({
      repoRoot: cli.repo.root,
      provider: cli.issueProvider,
      loadConfig: async () => {
        const next = await loadConfig(cli.repo.root);
        if (options.label !== undefined) next.workflow.triggerLabel = options.label.trim();
        if (options.interval !== undefined) next.unattended.pollSeconds = parseInterval(options.interval);
        return next;
      },
      listRuns: () => listRuns(cli.repo.root),
      createRunId: (now) => createRunId(now),
      startRun: (start) => startRun(cli, start, { verbose: options.verbose === true, json, signal: runs.signal }),
      log: (event) => {
        if (json) emitJsonLine('serve', { type: 'event', at: new Date().toISOString(), event });
        else printEvent(event, options);
      },
      sleep,
      signal: controller.signal,
      // Honest about which of the two things is running, so the audit line on
      // the run says where it came from rather than guessing from a flag.
      source: process.env['GITHUB_ACTIONS'] === 'true' ? 'action' : 'serve',
      ...(options.once === true || options.issue !== undefined ? { maxPasses: 1 } : {}),
      ...(options.issue === undefined ? {} : { only: options.issue }),
      ...(options.dryRun === true ? { dryRun: true } : {}),
      ...(options.limit === undefined ? {} : { limit: parseLimit(options.limit) }),
    });

    const code = exitCodeFor(outcome);
    // A line, not a document: `relay serve --json` is a stream of decisions and
    // the summary is the last of them, so a reader that parses line by line
    // gets the ending the same way it got everything before it.
    if (json) emitJsonLine('serve', { type: 'summary', exitCode: code, ...serveToJson(outcome) });
    else printOutcome(outcome);
    return code;
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
  }
}

/**
 * A server that stopped because it ran out of money exits non-zero, and one
 * that stopped because somebody asked it to exits zero.
 *
 * Both are orderly shutdowns, but only one of them is news. A supervisor
 * restarting a budget-stopped server will watch it stop again immediately,
 * which is the correct and visible behaviour for "this repository has spent
 * what it said it would spend today".
 */
function exitCodeFor(outcome: ServeOutcome): number {
  if (outcome.stoppedBy === 'budget') return EXIT.error;
  const failed = Object.values(outcome.results).filter((code) => code !== EXIT.success);
  return failed.length > 0 ? EXIT.error : EXIT.success;
}

/**
 * Drives one unattended run to completion.
 *
 * It goes through exactly the same engine, queue admission and delivery phase
 * that `relay run` does — the only differences are the config it was handed
 * (capped by `applyUnattendedPolicy`) and the trigger record on its state,
 * which is what everything downstream reads to know a person was not here.
 */
async function startRun(
  cli: CliContext,
  start: ServeStart,
  options: { verbose: boolean; json: boolean; signal: AbortSignal },
): Promise<number> {
  const now = new Date();
  const state = createRunState({
    runId: start.runId,
    shortId: shortId(),
    queued: true,
    issueRef: start.issue.number === null ? start.issue.id : String(start.issue.number),
    repository: {
      root: cli.repo.root,
      owner: cli.repo.owner,
      name: cli.repo.name,
      defaultBranch: cli.repo.defaultBranch,
    },
    config: start.config,
    trigger: start.trigger,
    now,
  });

  const store = new RunStore(state.repository.root, state.runId);
  await store.init();
  await store.saveState(state);

  // The same repository-wide limit an attended batch waits on, so a person
  // running `relay run` and this server cannot together exceed it.
  const admitted = await waitForAdmission(
    state.repository.root,
    state.runId,
    state.config.workflow.maxConcurrentRuns,
    options.signal,
  );
  return executeRun(
    cli,
    admitted,
    { compact: true, ...(options.verbose ? { verbose: true } : {}), ...(options.json ? { json: true } : {}) },
    'run',
    { signal: options.signal },
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true },
    );
  });
}

function parseInterval(value: string): number {
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 5 || parsed > 3600) {
    throw new RelayError(`--interval must be a whole number of seconds between 5 and 3600 (got "${value}").`, {
      code: 'BAD_FLAG',
    });
  }
  return parsed;
}

function parseLimit(value: string): number {
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 200) {
    throw new RelayError(`--limit must be a whole number between 1 and 200 (got "${value}").`, { code: 'BAD_FLAG' });
  }
  return parsed;
}

/**
 * One line per event, because a server's output is read in a log file weeks
 * later rather than watched. Every refusal names the issue and the reason —
 * "an issue labelled by someone outside the allowlist is ignored, with a log
 * line" is the acceptance criterion, and this is that line.
 */
function printEvent(event: ServeEvent, options: ServeOptions): void {
  const at = dim(new Date().toISOString());
  switch (event.type) {
    case 'watching':
      section(event.once ? 'Unattended, once' : 'Unattended');
      rows([
        { label: 'Trigger', value: `issues labelled ${event.label}` },
        {
          label: 'Budget',
          value: `${formatCost(event.maxRunCostUsd)} per run  ·  ${formatCost(event.maxDailyCostUsd)} per day`,
        },
        { label: 'Concurrency', value: `${event.maxConcurrentRuns} run(s) at once` },
        !event.once && { label: 'Polling', value: `every ${event.pollSeconds}s` },
        { label: 'Delivery', value: 'capped at a draft pull request — nothing merges without a person' },
      ]);
      if (options.dryRun === true) out(dim('  Dry run: deciding everything, starting nothing, moving no labels.'));
      out();
      hint('To stop it:');
      command(`touch .relay/${STOP_FILE}`);
      command('# or Ctrl-C, or set unattended.enabled to false');
      out();
      break;
    case 'considered':
      if (options.verbose === true) out(`${at} ${dim(`${event.count} issue(s) carrying the label`)}`);
      break;
    case 'skipped':
      out(`${at} ${warning('ignored')} ${event.issueRef}: ${event.reason}`);
      break;
    case 'claimed':
      out(
        `${at} ${event.dryRun ? warning('would start') : success('started')} ${event.issueRef} as ${event.runId} ` +
          dim(`(${event.reason})`),
      );
      break;
    case 'finished':
      out(
        `${at} ${event.exitCode === 0 ? success('finished') : failure('finished')} ${event.runId} ` +
          dim(`for ${event.issueRef}, exit ${event.exitCode}`),
      );
      break;
    case 'deferred':
      if (options.verbose === true) out(`${at} ${dim(`waiting: ${event.reason}`)}`);
      break;
    case 'budget':
      out();
      out(failure(`  Budget reached — starting nothing more.`));
      out(`  ${event.detail}.`);
      hint('Raise unattended.maxDailyCostUsd, or wait for tomorrow and start it again.');
      break;
    case 'stopping':
      out();
      out(dim(`  Stopping: ${event.reason}.`));
      if (event.inFlight > 0) out(dim(`  Waiting for ${event.inFlight} run(s) in flight to finish.`));
      break;
    case 'error':
      out(`${at} ${failure('error')} ${event.detail}`);
      break;
  }
}

function printOutcome(outcome: ServeOutcome): void {
  out();
  section('Unattended summary');
  rows([
    { label: 'Stopped by', value: `${outcome.stoppedBy} — ${outcome.reason}` },
    { label: 'Runs started', value: String(outcome.started.length) },
    { label: 'Passes', value: String(outcome.passes) },
  ]);
  for (const runId of outcome.started) {
    bullet(`${runId} ${dim(`exit ${outcome.results[runId] ?? 'unknown'}`)}`);
  }
  out();
  hint('What it cost and who asked for it:');
  command('relay stats');
  out();
}

export interface ServeJson {
  stoppedBy: ServeOutcome['stoppedBy'];
  reason: string;
  started: Array<{ runId: string; exitCode: number | null }>;
  passes: number;
}

export function serveToJson(outcome: ServeOutcome): ServeJson {
  return {
    stoppedBy: outcome.stoppedBy,
    reason: outcome.reason,
    started: outcome.started.map((runId) => ({ runId, exitCode: outcome.results[runId] ?? null })),
    passes: outcome.passes,
  };
}
