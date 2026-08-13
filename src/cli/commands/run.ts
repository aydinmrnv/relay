import { AGENT_PROVIDERS, isAgentProvider } from '../../agents/index.ts';
import { createRunId, shortId } from '../../util/ids.ts';
import { RelayError } from '../../util/errors.ts';
import { parseIssueRef } from '../../github/provider.ts';
import { RunStore, RUN_FILES, resolveRun } from '../../storage/runs.ts';
import {
  DELIVERY_POLICIES,
  isDeliveryPolicy,
  reviewsCode,
  type DeliveryPolicy,
  type RelayConfig,
} from '../../storage/config.ts';
import { WorkflowEngine } from '../../workflow/engine.ts';
import { resolveCeiling, shortfall } from '../../workflow/delivery.ts';
import { delivering } from '../../workflow/phases/delivery.ts';
import type { RunDisplay, RunObserver } from '../../workflow/observer.ts';
import { renderSummary } from '../../workflow/summary.ts';
import { createRunState, type DeliveryStep, type RunState } from '../../workflow/state.ts';
import { displayPhasesFor, isTerminal, phaseLabel, phaseRole } from '../../workflow/phases.ts';
import { failedPhase, phaseTimings } from '../../workflow/timeline.ts';
import { formatUsage } from '../../workflow/usage.ts';
import type { EngineContext } from '../../workflow/context.ts';
import { RunRenderer } from '../../ui/renderer.ts';
import { glyphs } from '../../ui/theme.ts';
import { formatDuration } from '../../util/text.ts';
import { createCliContext, type CliContext } from '../context.ts';
import { offerDelivery } from '../mergeOffer.ts';
import { EXIT, exitCodeForRun } from '../exit.ts';
import { emitJson } from '../json.ts';
import { runToJson } from '../runJson.ts';
import { RunJsonStream } from '../runStream.ts';
import { landingOf } from './inspect.ts';
import {
  changeCount,
  command,
  theme,
  dim,
  failure,
  hint,
  out,
  rows,
  section,
  success,
  warning,
  type Row,
} from '../output.ts';

export interface RunOptions {
  verbose?: boolean;
  base?: string;
  planner?: string;
  implementer?: string;
  maxPlanRounds?: string;
  maxCodeRounds?: string;
  tests?: boolean;
  /** `--commit`: stop delivery at the run branch. */
  commit?: boolean;
  push?: boolean;
  pr?: boolean;
  merge?: boolean;
  mergeMethod?: string;
  /** `--deliver <policy>`: how far this run carries its own work. */
  deliver?: string;
  /** `--no-offer-merge`: finish without the one question. */
  offerMerge?: boolean;
  /** `-f`: no plan review, no code review. */
  fast?: boolean;
  /** `--no-prime`: make each reviewer read only once its turn starts. */
  prime?: boolean;
  /** `--no-parallel-tests`: run the suite after the code review, not during it. */
  parallelTests?: boolean;
  /** `--tuff`: write this run's pull request, commits and comments like a human. */
  tuff?: boolean;
  /** `--json`: stream the run as JSON lines instead of drawing a dashboard. */
  json?: boolean;
}

/** Applies `relay run` flags over the repository config for this run only. */
export function applyOverrides(config: RelayConfig, options: RunOptions): RelayConfig {
  const merged: RelayConfig = structuredClone(config);

  if (options.base !== undefined) merged.workflow.baseBranch = options.base;
  if (options.tests === false) merged.workflow.runTests = false;
  // `--commit` is the short way to say "keep it, publish nothing".
  merged.workflow.deliver = resolveCeiling(merged, options);
  if (options.deliver !== undefined) merged.workflow.deliver = parseDeliver(options.deliver);
  if (options.mergeMethod !== undefined) {
    if (!['squash', 'merge', 'rebase'].includes(options.mergeMethod)) throw new RelayError('--merge-method must be squash, merge, or rebase.', { code: 'BAD_FLAG' });
    merged.github.mergeMethod = options.mergeMethod as RelayConfig['github']['mergeMethod'];
  }
  if (options.offerMerge === false) merged.workflow.offerMerge = false;
  if (options.prime === false) merged.workflow.primeReviewers = false;
  if (options.parallelTests === false) merged.workflow.concurrentTests = false;

  if (options.fast === true) {
    // Fast is the whole trade in one flag: no planner turn, no plan review, no
    // code review. What is left is one agent, its own plan, and the suite —
    // which is the fastest a run can be and the least it can promise.
    merged.workflow.plan = 'inline';
    merged.workflow.reviewCode = false;
    out(dim('Fast: one agent plans and implements, and no reviewer reads either the plan or the diff.'));
    out(
      warning(
        merged.workflow.runTests
          ? '  The tests are the only check on this run.'
          : '  Nothing checks this run: reviews are off and so are the tests.',
      ),
    );
  }

  if (options.tuff === true) {
    merged.workflow.typos = true;
    out(dim('Tuff: the pull request, the commit messages and the comments in the diff are written with typos.'));
  }

  if (options.planner !== undefined) {
    assertProvider(options.planner, '--planner');
    merged.agents.planner = options.planner;
    // Keeping the reviewer on the other model is the point of the workflow.
    merged.agents.codeReviewer = merged.agents.planner;
  }
  if (options.implementer !== undefined) {
    assertProvider(options.implementer, '--implementer');
    merged.agents.implementer = options.implementer;
    merged.agents.planReviewer = merged.agents.implementer;
  }

  if (options.maxPlanRounds !== undefined) {
    merged.workflow.maxPlanReviewRounds = parseRounds(options.maxPlanRounds, '--max-plan-rounds');
  }
  if (options.maxCodeRounds !== undefined) {
    merged.workflow.maxCodeReviewRounds = parseRounds(options.maxCodeRounds, '--max-code-rounds');
  }

  if (merged.workflow.plan === 'review' && merged.agents.planner === merged.agents.planReviewer) {
    // Not fatal — the user may only have one CLI installed — but it removes the
    // cross-model critique that makes the workflow worth running.
    out(warning('Warning: the planner and plan reviewer are the same agent, so the plan is self-reviewed.'));
  }

  return merged;
}

function assertProvider(value: string, flag: string): void {
  if (!isAgentProvider(value)) {
    throw new RelayError(`${flag} must be one of ${AGENT_PROVIDERS.join(', ')} (got "${value}").`, { code: 'BAD_FLAG' });
  }
}

export function parseDeliver(value: string): DeliveryPolicy {
  if (!isDeliveryPolicy(value)) {
    throw new RelayError(`--deliver must be one of ${DELIVERY_POLICIES.join(', ')} (got "${value}").`, {
      code: 'BAD_FLAG',
    });
  }
  return value;
}

function parseRounds(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10) {
    throw new RelayError(`${flag} must be an integer between 0 and 10.`, { code: 'BAD_FLAG' });
  }
  return parsed;
}

export async function runCommand(issueRef: string, options: RunOptions): Promise<number> {
  const cli = await createCliContext();

  // Fail on a malformed reference before creating any state on disk.
  parseIssueRef(issueRef);

  const config = applyOverrides(cli.config, options);
  const now = new Date();
  const state = createRunState({
    runId: createRunId(now),
    shortId: shortId(),
    issueRef,
    repository: {
      root: cli.repo.root,
      owner: cli.repo.owner,
      name: cli.repo.name,
      defaultBranch: cli.repo.defaultBranch,
    },
    config,
    now,
  });

  return executeRun(cli, state, options, 'run');
}

export async function resumeCommand(runRef: string, options: RunOptions): Promise<number> {
  const cli = await createCliContext();
  const previous = await resolveRun(cli.repo.root, runRef);

  // The rest of the run's config is a snapshot and stays untouched, but a
  // resume is exactly when a user decides the work should not strand again.
  if (options.commit === true) previous.config.workflow.deliver = 'branch';
  else if (options.push === true || options.pr === true || options.merge === true) {
    previous.config.workflow.deliver = resolveCeiling(previous.config, options);
  }
  if (options.deliver !== undefined) previous.config.workflow.deliver = parseDeliver(options.deliver);
  if (options.offerMerge === false) previous.config.workflow.offerMerge = false;
  // The phases this run will take are already decided, but what it writes on
  // its way out is not: a resume is allowed to change the voice.
  if (options.tuff === true) previous.config.workflow.typos = true;

  if (isTerminal(previous.phase)) {
    if (previous.phase === 'COMPLETE') {
      // Nothing left to run, but delivery may still have something to do:
      // a push that failed, or a policy that has been raised since.
      out(`Run ${previous.runId} already completed.`);
      return deliverRun(previous, { command: 'resume', ...(options.json === true ? { json: true } : {}) });
    }
    // A failed or cancelled run resumes from the phase it died in, keeping its
    // worktree, sessions and review history.
    const retryFrom = previous.history.filter((entry) => entry.phase !== previous.phase).pop()?.phase;
    if (retryFrom === undefined) {
      throw new RelayError(`Run ${previous.runId} has no phase to resume from.`, { code: 'CANNOT_RESUME' });
    }
    out(dim(`Resuming ${previous.runId} from ${retryFrom} (was ${previous.phase}).`));
    previous.phase = retryFrom;
    delete previous.error;
    delete previous.finishedAt;
  } else {
    out(dim(`Resuming ${previous.runId} from ${previous.phase}.`));
  }

  return executeRun(cli, previous, options, 'resume');
}

/**
 * Re-runs the delivery phase for a run that is already over.
 *
 * A run delivers itself, so this exists for the cases where that could not
 * finish the job at the time: `gh` was not installed, the remote rejected the
 * push, or the policy was `branch` on Friday and is `pr` on Monday. It is the
 * same phase, with the same gates, driven from outside the engine.
 */
export async function deliverRun(
  state: RunState,
  options: { policy?: DeliveryPolicy; json?: boolean; command?: string } = {},
): Promise<number> {
  const store = new RunStore(state.repository.root, state.runId);
  if (options.policy !== undefined) state.config.workflow.deliver = options.policy;
  const json = options.json === true;

  await delivering({ state, store, observer: cliObserver, signal: new AbortController().signal });
  await store.writeArtifact(RUN_FILES.summary, renderSummary(state));
  await store.saveState(state);

  // Reported after the fact, so the ledger describes what just happened rather
  // than what the last run left behind.
  printOutcome(state, store);
  // The one interactive step there is. Whatever is parsing a document is not at
  // a terminal by definition, so `--json` never asks and never blocks on it.
  if (!json) await offerDelivery(state, store, { observer: cliObserver });
  printNextSteps(state, store);

  // Read from git rather than assumed: delivery may have committed the work, or
  // may have been unable to, and only the branch itself can say which.
  const landing = await landingOf(state.repository.root, state);
  const code = exitCodeForRun(state, landing);
  if (json) emitJson(options.command ?? 'deliver', { exitCode: code, run: runToJson(state, { landing }) });
  return code;
}

/** Minimal observer for the phases run outside the live renderer. */
const cliObserver: RunObserver = {
  phaseChanged() {},
  roleStatus() {},
  agentEvent() {},
  note: (text) => out(`  ${text}`),
  warn: (text) => out(warning(`  ${text}`)),
};

async function executeRun(
  cli: CliContext,
  state: RunState,
  options: RunOptions,
  command: 'run' | 'resume',
): Promise<number> {
  const store = new RunStore(state.repository.root, state.runId);
  const controller = new AbortController();
  const json = options.json === true;

  // Both displays watch the same engine through the same interface, so nothing
  // downstream of here knows or cares which one is attached.
  const stream = json
    ? new RunJsonStream({ state, command, ...(options.verbose === true ? { verbose: true } : {}) })
    : undefined;
  const display: RunDisplay =
    stream ??
    new RunRenderer({
      // The renderer supplies the mark; this is only what the run is about.
      title: state.issue === undefined ? `Issue ${state.issueRef}` : `Issue #${state.issue.number}`,
      subtitle: state.issue?.title ?? `run ${state.runId}`,
      agentNames: {
        planner: state.config.agents.planner,
        planReviewer: state.config.agents.planReviewer,
        implementer: state.config.agents.implementer,
        codeReviewer: state.config.agents.codeReviewer,
      },
      phases: displayPhasesFor(state.config.workflow),
      ...(options.verbose === true ? { verbose: true } : {}),
    });

  // Ctrl-C stops the agents and lets the engine record a CANCELLED run rather
  // than leaving state that claims a phase is still in flight.
  let interrupted = false;
  const onSigint = (): void => {
    if (interrupted) process.exit(EXIT.cancelled);
    interrupted = true;
    display.warn('Cancelling… (press Ctrl-C again to force quit)');
    controller.abort();
    void Promise.all(Object.values(cli.harnesses).map((harness) => harness.cancel()));
  };
  process.on('SIGINT', onSigint);

  display.start();

  const context: EngineContext = {
    state,
    store,
    harnesses: cli.harnesses,
    issueProvider: cli.issueProvider,
    observer: display,
    signal: controller.signal,
  };

  let finalState: RunState;
  try {
    finalState = await new WorkflowEngine(context).run();
    display.finish(finalState.phase);
  } finally {
    process.off('SIGINT', onSigint);
  }

  printOutcome(finalState, store);

  // Delivery took it as far as the policy allows on its own. Landing it is the
  // one call left, and this is the moment its author is still watching — which
  // a run being piped into something is not, so `--json` never asks.
  if (!json) await offerDelivery(finalState, store);
  printNextSteps(finalState, store);

  const landing = await landingOf(state.repository.root, finalState);
  const code = exitCodeForRun(finalState, landing);
  stream?.summary(runToJson(finalState, { landing }), code);
  return code;
}

/**
 * What the run did, what it produced, and where that work ended up. Delivery
 * has already happened by the time this prints, so the block reports a finished
 * story rather than a to-do list.
 */
export function printOutcome(state: RunState, store: RunStore): void {
  const elapsed = new Date(state.finishedAt ?? state.updatedAt).getTime() - new Date(state.createdAt).getTime();

  out();
  if (state.phase === 'COMPLETE') {
    out(success('Run complete') + dim(` in ${formatDuration(elapsed)}`));
  } else if (state.phase === 'CANCELLED') {
    out(warning('Run cancelled') + dim(` after ${formatDuration(elapsed)}`));
  } else {
    printFailure(state);
  }

  printPhases(state);

  section('Result');
  rows([
    state.workspace !== undefined && { label: 'Branch', value: state.workspace.branch },
    state.workspace !== undefined && { label: 'Worktree', value: state.workspace.path },
    state.diff !== undefined && {
      label: 'Changes',
      value: `${state.diff.fileCount} file(s), ${changeCount(state.diff.additions, state.diff.deletions)}`,
    },
    state.tests !== undefined && { label: 'Tests', value: testsLine(state) },
    {
      label: 'Reviews',
      value:
        `plan ${state.rounds.planReview} round(s), ` +
        (reviewsCode(state.config) ? `code ${state.rounds.codeReview} round(s)` : warning('code review skipped')),
    },
    commitRow(state),
    state.usage !== undefined && { label: 'Usage', value: formatUsage(state.usage.total) },
    { label: 'Run state', value: store.dir },
  ]);

  printDelivery(state);
}

/**
 * The delivery ledger: every step the run took with its result, and every step
 * it did not with the reason. Both halves matter — a run that quietly stopped
 * short of the pull request it was configured to open looks identical to a
 * successful one unless the skipped step says why.
 */
export function printDelivery(state: RunState): void {
  const delivery = state.delivery;
  if (delivery === undefined) return;

  const marks = glyphs(theme());
  section('Delivery');
  out(
    dim(
      `  policy ${delivery.policy}` +
        (delivery.reached === delivery.policy
          ? ''
          : `  ·  reached ${delivery.reached === 'none' ? 'nothing' : delivery.reached}`),
    ),
  );

  rows(
    delivery.steps.map((step) => ({
      label:
        `${step.status === 'done' ? success(marks.ok) : step.status === 'failed' ? failure(marks.failed) : dim(marks.bullet)} ` +
        stepLabel(step.step),
      value: step.status === 'done' ? step.detail : step.status === 'failed' ? failure(step.detail) : dim(step.detail),
    })),
  );
}

function stepLabel(step: DeliveryStep): string {
  switch (step) {
    case 'commit':
      return 'Commit';
    case 'push':
      return 'Push';
    case 'pullRequest':
      return 'Pull request';
    case 'merge':
      return 'Merge';
  }
}

/**
 * Where the work is now, and the shortest route to it. Delivery already ran, so
 * this is a report with links — not a menu, and not a command to finish the job.
 */
export function printNextSteps(state: RunState, store: RunStore): void {
  section('Next');

  if (state.phase === 'FAILED') {
    if (state.commit !== undefined) {
      hint(`The work that did get written is committed on ${state.commit.branch}, and nothing was published.`);
    }
    hint('To diagnose and continue:');
    command(`relay logs ${state.runId}`);
    command(`relay resume ${state.runId}`);
    out();
    return;
  }

  if (state.merge !== undefined) {
    hint(`Merged into ${state.merge.into}${state.merge.via === 'local' ? ' in your checkout' : ''}.`);
    command(state.merge.url ?? `git log --oneline -3 ${state.merge.into}`);
  } else if (state.pullRequest !== undefined) {
    hint('Open for review:');
    command(state.pullRequest.url);
  } else if (state.commit !== undefined) {
    // When delivery stopped short, the reason is more useful than the command:
    // re-running it changes nothing until the thing that blocked it is fixed.
    const blocked = shortfall(state.delivery);
    hint(
      blocked === undefined
        ? `The work is on ${state.commit.branch}. To take it further:`
        : `Delivery stopped at ${state.push === undefined ? 'the commit' : 'the push'}: ${blocked.detail}.`,
    );
    command(`relay deliver ${state.runId}${blocked === undefined ? ' --to pr' : ''}`);
  } else if ((state.diff?.fileCount ?? 0) > 0) {
    out(warning('  The work is staged in the run worktree and committed nowhere.'));
    command(`relay deliver ${state.runId}`);
  }

  out();
  hint('To review it:');
  command(`relay diff ${state.runId}`);
  command(store.path('summary.md'));

  if (state.phase === 'CANCELLED') {
    out();
    hint('To pick up where it stopped:');
    command(`relay resume ${state.runId}`);
  }
  out();
}

/**
 * Failure is the moment the UI matters most: name the agent that failed, say
 * why, and give the two commands that do something about it.
 */
function printFailure(state: RunState): void {
  const elapsed = new Date(state.finishedAt ?? state.updatedAt).getTime() - new Date(state.createdAt).getTime();
  const phase = failedPhase(state);
  const role = phase === undefined ? undefined : phaseRole(phase);
  const agent = role === undefined ? undefined : state.config.agents[role];

  const where = phase === undefined ? '' : ` during ${phaseLabel(phase)}`;
  out(failure(`Run failed${where}`) + dim(` after ${formatDuration(elapsed)}`));

  if (agent !== undefined && role !== undefined) out(`  ${agent} ${dim(`(${role})`)} did not finish its turn.`);
  if (state.error !== undefined) out(`  ${state.error.message}`);
}

/** Where the run spent its time, folded so revision rounds count as review time. */
function printPhases(state: RunState): void {
  const timings = phaseTimings(state);
  if (timings.length === 0) return;

  section('Phases');
  rows(
    timings.map(({ phase, ms, visits }) => ({
      label: phaseLabel(phase),
      value: formatDuration(ms) + (visits > 1 ? dim(`  ${visits} rounds`) : ''),
    })),
  );
}

function testsLine(state: RunState): string {
  const tests = state.tests;
  if (tests === undefined) return dim('not run');
  if (!tests.discovered) return dim(`not run (${tests.skippedReason ?? tests.reason})`);
  return `${tests.command.join(' ')} → ${tests.passed ? success('passed') : failure('failed')}`;
}

function commitRow(state: RunState): Row | false {
  if (state.commit !== undefined) {
    return {
      label: 'Commit',
      value:
        `${state.commit.sha.slice(0, 8)} on ${state.commit.branch} ` +
        dim(state.push === undefined ? '(local only)' : '(pushed)'),
    };
  }
  // Uncommitted work in a throwaway worktree is one `git worktree prune` from
  // being gone, so the run says so rather than reporting a clean success.
  if (state.phase === 'COMPLETE' && (state.diff?.fileCount ?? 0) > 0) {
    return { label: 'Commit', value: warning('none — the work is staged but uncommitted') };
  }
  return false;
}
