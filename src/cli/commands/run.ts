import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';

import { AGENT_PROVIDERS, isAgentProvider } from '../../agents/index.ts';
import { createRunId, shortId } from '../../util/ids.ts';
import { RelayError } from '../../util/errors.ts';
import { parseIssueRef } from '../../github/provider.ts';
import type { IssueListFilters, IssueProvider } from '../../github/types.ts';
import {
  LocalIssueProvider,
  composeTaskInEditor,
  readTaskFile,
  taskFromPrompt,
  type LocalTask,
} from '../../issues/local.ts';
import { listRuns, RunStore, RUN_FILES, resolveRun } from '../../storage/runs.ts';
import {
  DELIVERY_POLICIES,
  isDeliveryPolicy,
  reviewsCode,
  type DeliveryPolicy,
  type RelayConfig,
} from '../../storage/config.ts';
import {
  applyReviewLevel,
  describeReview,
  isReviewLevel,
  REVIEW_LEVELS,
  reviewProfile,
  type ReviewLevel,
} from '../../reviews/level.ts';
import { WorkflowEngine } from '../../workflow/engine.ts';
import { mergeUnanswered, resolveCeiling, shortfall } from '../../workflow/delivery.ts';
import { delivering } from '../../workflow/phases/delivery.ts';
import type { RunDisplay, RunObserver } from '../../workflow/observer.ts';
import { renderSummary } from '../../workflow/summary.ts';
import { createRunState, type DeliveryStep, type RunState } from '../../workflow/state.ts';
import { displayPhasesFor, isTerminal, phaseLabel, phaseRole } from '../../workflow/phases.ts';
import { failedPhase, phaseTimings } from '../../workflow/timeline.ts';
import { estimateRun, exceedsThreshold, type RunEstimate } from '../../workflow/estimate.ts';
import { formatCost, formatUsage, unpricedTurns } from '../../workflow/usage.ts';
import type { EngineContext } from '../../workflow/context.ts';
import { RunRenderer } from '../../ui/renderer.ts';
import { Prompter, isPromptCancelled, type PromptSession } from '../../ui/prompt.ts';
import { glyphs } from '../../ui/theme.ts';
import { formatDuration } from '../../util/text.ts';
import { createCliContext, type CliContext } from '../context.ts';
import { offerDelivery } from '../mergeOffer.ts';
import { confirmClosedIssue, resolvePickedIssue } from '../issuePicker.ts';
import { EXIT, exitCodeForRun } from '../exit.ts';
import { emitJson } from '../json.ts';
import { runToJson } from '../runJson.ts';
import { RunJsonStream } from '../runStream.ts';
import { landingOf } from './inspect.ts';
import { createTracking } from '../../tracking/index.ts';
import { runQueue } from '../../workflow/queue.ts';
import { waitForAdmission } from '../../workflow/admission.ts';
import { pruneArtifacts } from '../../storage/retention.ts';
import {
  changeCount,
  command,
  theme,
  dim,
  facts,
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
  /** Internal: batches use line-oriented output because dashboards cannot share a terminal. */
  compact?: boolean;
  detach?: boolean;
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
  /** `--allow-secret <path>`: let a file the secret scan flagged publish anyway. */
  allowSecret?: string[];
  /** `-f`: no plan review, no code review. The shorthand for `--review none`. */
  fast?: boolean;
  /** `--review <level>`: how hard the agents are asked to look. */
  review?: string;
  /** `--no-prime`: make each reviewer read only once its turn starts. */
  prime?: boolean;
  /** `--no-parallel-tests`: run the suite after the code review, not during it. */
  parallelTests?: boolean;
  /** `--tuff`: write this run's pull request, commits and comments like a human. */
  tuff?: boolean;
  /** `--json`: stream the run as JSON lines instead of drawing a dashboard. */
  json?: boolean;
  /** `--max-cost <usd>`: stop the run at the first phase boundary past this. */
  maxCost?: string;
  /** `--prompt <text>`: the task itself, with no tracker in the way. */
  prompt?: string;
  /** `--editor`: write the task in `$EDITOR`, the way `git commit` does. */
  editor?: boolean;
  label?: string[];
  assignee?: string;
  mine?: boolean;
  limit?: string;
  yes?: boolean;
}

/**
 * Where a run's issue comes from: a tracker reference the provider resolves, or
 * a task this machine already has in hand.
 *
 * Resolved before any state is written, so a missing file or an abandoned editor
 * costs nothing and leaves nothing behind.
 */
export type IssueSource = { kind: 'tracker'; ref: string } | { kind: 'local'; task: LocalTask };

export async function resolveIssueSource(
  issueRef: string | undefined,
  options: Pick<RunOptions, 'prompt' | 'editor'>,
  cwd: string,
): Promise<IssueSource | undefined> {
  // An argument of whitespace is nobody asking for anything, and reads better
  // as "nothing to work on" than as a file that does not exist.
  const ref = issueRef?.trim() === '' ? undefined : issueRef?.trim();

  const given = [ref !== undefined, options.prompt !== undefined, options.editor === true].filter(Boolean).length;
  if (given === 0) {
    throw new RelayError('Nothing to work on.', {
      code: 'NO_ISSUE_REF',
      hint: 'Pass an issue (`relay run 142`), a file (`relay run ./spec.md`), `--prompt "…"`, or `--editor`.',
    });
  }
  if (given > 1) {
    throw new RelayError('Pass one of an issue reference, `--prompt` or `--editor` — not several.', {
      code: 'BAD_FLAG',
    });
  }

  if (options.prompt !== undefined) return { kind: 'local', task: taskFromPrompt(options.prompt) };
  if (options.editor === true) {
    // The editor gets the terminal handed to it. Behind a pipe or in CI there is
    // none to hand over, and the failure that produces is unreadable.
    if (process.stdin.isTTY !== true) {
      throw new RelayError('`--editor` needs a terminal to hand over to.', {
        code: 'NOT_A_TTY',
        hint: 'With no terminal, pass the task directly: `relay run --prompt "…"` or `relay run ./spec.md`.',
      });
    }
    const task = await composeTaskInEditor({ cwd });
    // An empty buffer is the user changing their mind, not a failure.
    if (task === undefined) return undefined;
    return { kind: 'local', task };
  }

  // A tracker reference wins over a file that happens to share its name:
  // `relay run 142` has meant issue 142 since the first release, and that is
  // not something a file called `142` in the working directory gets to change.
  if (isTrackerRef(ref!)) return { kind: 'tracker', ref: ref! };
  return { kind: 'local', task: await readTaskFile(ref!, cwd) };
}

/** Whether the provider would understand this, without making it throw to find out. */
function isTrackerRef(ref: string): boolean {
  try {
    parseIssueRef(ref);
    return true;
  } catch {
    return false;
  }
}

/**
 * The provider this run reads its issue through. A run carrying its own task
 * hands that straight back — including on `relay resume`, where a `--prompt` has
 * no file to be read again from.
 */
export function issueProviderFor(cli: CliContext, state: RunState): IssueProvider {
  return state.task === undefined
    ? cli.issueProvider
    : new LocalIssueProvider({ cwd: state.repository.root, task: state.task });
}

export interface OverrideOptions {
  /**
   * Whether to say what changed. On for a real run — a run reviewed less than
   * the reader expects is the one failure mode these flags can produce — and off
   * when the answer is only being shown, as the home screen does with the flags
   * a `/command` set.
   */
  announce?: boolean;
}

/** Applies `relay run` flags over the repository config for this run only. */
export function applyOverrides(
  config: RelayConfig,
  options: RunOptions,
  overrideOptions: OverrideOptions = {},
): RelayConfig {
  const merged: RelayConfig = structuredClone(config);
  const announce = overrideOptions.announce !== false;
  const say = (line: string): void => {
    if (announce) out(line);
  };

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
  if (options.allowSecret !== undefined && options.allowSecret.length > 0) {
    merged.delivery.allowSecrets = [...(merged.delivery.allowSecrets ?? []), ...options.allowSecret];
    say(dim(`Secret scan: ${options.allowSecret.join(', ')} allowed through by --allow-secret.`));
  }

  // Review depth is set before the individual knobs below, so an explicit
  // `--max-code-rounds` on top of a level still wins — the same order the
  // config file resolves them in.
  const level = resolveReviewLevel(options);
  if (level !== undefined) {
    merged.workflow.review = level;
    applyReviewLevel(merged.workflow, level);
    if (announce) announceReviewLevel(merged, level);
  }

  if (options.tuff === true) {
    merged.workflow.typos = true;
    say(dim('Tuff: the pull request, the commit messages and the comments in the diff are written with typos.'));
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
  if (options.maxCost !== undefined) merged.workflow.maxCostUsd = parseCost(options.maxCost, '--max-cost');

  if (merged.workflow.plan === 'review' && merged.agents.planner === merged.agents.planReviewer) {
    // Not fatal — the user may only have one CLI installed — but it removes the
    // cross-model critique that makes the workflow worth running.
    say(warning('Warning: the planner and plan reviewer are the same agent, so the plan is self-reviewed.'));
  }

  return merged;
}

/**
 * The level this run is asked for, from either spelling of the question.
 *
 * `--fast` predates levels and is exactly the bottom of the scale, so it stays
 * as the shorthand rather than becoming a second dial pointing at the same
 * thing. Passing both is refused unless they agree: `--fast --review thorough`
 * has no reading that honours either flag.
 */
export function resolveReviewLevel(options: Pick<RunOptions, 'review' | 'fast'>): ReviewLevel | undefined {
  const named = options.review === undefined ? undefined : parseReviewLevel(options.review);
  if (options.fast !== true) return named;
  if (named !== undefined && named !== 'none') {
    throw new RelayError(`--fast is \`--review none\`, so it cannot be combined with --review ${named}.`, {
      code: 'BAD_FLAG',
      hint: 'Pass one of them.',
    });
  }
  return 'none';
}

export function parseReviewLevel(value: string): ReviewLevel {
  const normalized = value.trim().toLowerCase();
  if (!isReviewLevel(normalized)) {
    throw new RelayError(`--review must be one of ${REVIEW_LEVELS.join(', ')} (got "${value}").`, { code: 'BAD_FLAG' });
  }
  return normalized;
}

/**
 * Says what the level just bought or gave up.
 *
 * A run that quietly reviews less than the reader expects is the one failure
 * mode this dial can produce, so turning it down is always said out loud, and
 * turning it off is said in a colour.
 */
function announceReviewLevel(config: RelayConfig, level: ReviewLevel): void {
  const profile = reviewProfile(level);
  out(dim(`Review ${level}: ${profile.headline}.`));

  if (level === 'none') {
    out(
      warning(
        config.workflow.runTests
          ? '  The tests are the only check on this run.'
          : '  Nothing checks this run: reviews are off and so are the tests.',
      ),
    );
    return;
  }
  out(dim(`  ${describeReview({ ...config.workflow, review: level })}.`));
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

/** A dollar amount from the command line. `$2.50` and `2.50` both mean $2.50. */
export function parseCost(value: string, flag: string): number {
  const parsed = Number.parseFloat(value.trim().replace(/^\$/, ''));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RelayError(`${flag} must be a positive number of US dollars, e.g. ${flag} 2.50 (got "${value}").`, {
      code: 'BAD_FLAG',
    });
  }
  return parsed;
}

export function parseLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new RelayError('--limit must be a positive integer.', { code: 'BAD_FLAG' });
  return parsed;
}

export async function runCommand(issueRefs: string | string[] | undefined, options: RunOptions): Promise<number> {
  const cli = await createCliContext();
  if (options.mine === true && options.assignee !== undefined) {
    throw new RelayError('Pass --mine or --assignee, not both.', { code: 'BAD_FLAG' });
  }
  const filters: IssueListFilters = {
    ...(options.label === undefined ? {} : { labels: options.label }),
    ...(options.assignee === undefined ? {} : { assignee: options.assignee }),
    ...(options.mine === true ? { mine: true } : {}),
    ...(options.limit === undefined ? {} : { limit: parseLimit(options.limit) }),
  };
  const refs = Array.isArray(issueRefs) ? (issueRefs.length === 0 ? [undefined] : issueRefs) : [issueRefs];
  if (refs.length > 1 && (options.prompt !== undefined || options.editor === true)) {
    throw new RelayError('Batch runs accept issue references only; --prompt and --editor create one task.', { code: 'BAD_FLAG' });
  }
  // A detached child drives one run. Detaching a batch would either bypass the
  // concurrency limit or leave nobody holding the queue, so the combination is
  // refused rather than half-honoured.
  if (refs.length > 1 && options.detach === true) {
    throw new RelayError('--detach starts a single run; pass one issue reference.', { code: 'BAD_FLAG' });
  }

  const prompter = new Prompter();
  const explicitlyNamed = refs.map((ref) => ref !== undefined && ref.trim().length > 0);
  // Naming nothing is a question only a lone run can ask: a batch named its
  // issues by definition, so there is nothing left to pick.
  const resolvedRefs =
    refs.length === 1 && !explicitlyNamed[0] && options.prompt === undefined && options.editor !== true && prompter.interactive
      ? [await resolvePickedIssue(cli.issueProvider, filters, prompter)]
      : refs;

  // Resolve what the run is about before creating any state on disk: a
  // malformed reference, a missing file and an abandoned editor all cost
  // nothing and leave nothing behind.
  const resolved = await Promise.all(resolvedRefs.map((ref) => resolveIssueSource(ref, options, process.cwd())));
  if (resolved.some((source) => source === undefined)) {
    out(dim('Nothing written, so nothing was started.'));
    prompter.close();
    return 0;
  }
  const sources = resolved as IssueSource[];

  // Every named issue answers for itself, and all of them before any of them
  // starts: learning halfway through a batch that the third one was closed is
  // too late for the answer to mean anything.
  for (const [index, source] of sources.entries()) {
    if (explicitlyNamed[index] !== true || source.kind !== 'tracker') continue;
    const issue = await cli.issueProvider.getIssue(source.ref);
    if (!(await confirmClosedIssue(issue, options.yes === true, prompter))) {
      out(dim('Not started.'));
      prompter.close();
      return 130;
    }
  }

  const config = applyOverrides(cli.config, options);

  // What this run will do and what runs of its shape have cost here before —
  // said before the first agent turn, which is the only time it is useful.
  const estimate = estimateRun(await listRuns(cli.repo.root), config.workflow);
  printEstimate(estimate, config.workflow.maxCostUsd);
  if (!(await confirmEstimate(estimate, config.workflow.confirmAboveUsd, { prompter }))) {
    out(dim('  Not started.'));
    prompter.close();
    return 130;
  }
  prompter.close();

  const states = sources.map((source, index) => {
    // Offset per run so a batch created inside the same millisecond still gets
    // distinct, ordered run ids.
    const now = new Date(Date.now() + index);
    return createRunState({
      runId: createRunId(now),
      shortId: shortId(),
      queued: true,
      // For a local task the reference is where it came from — a path, `--prompt`
      // or `--editor` — which is what `relay status` has to be able to show.
      issueRef: source.kind === 'tracker' ? source.ref : source.task.origin,
      ...(source.kind === 'tracker' ? {} : { task: source.task }),
      repository: {
        root: cli.repo.root,
        owner: cli.repo.owner,
        name: cli.repo.name,
        defaultBranch: cli.repo.defaultBranch,
      },
      config,
      now,
    });
  });

  // Guarded above to a single reference, so there is exactly one state here.
  if (options.detach === true) return startDetached(states[0]!);

  const runOptions = states.length > 1 ? { ...options, compact: true } : options;
  return runQueue(states, config.workflow.maxConcurrentRuns, (state) => executeRun(cli, state, runOptions, 'run'));
}

async function startDetached(state: RunState): Promise<number> {
  const store = new RunStore(state.repository.root, state.runId);
  await store.init();
  await store.saveState(state);
  const entry = process.argv[1];
  if (entry === undefined) throw new RelayError('Cannot locate the Relay launcher.', { code: 'SPAWN_FAILED' });
  const child = spawn(process.execPath, [entry, '__run-detached', state.runId], {
    cwd: state.repository.root, detached: true, stdio: 'ignore', env: process.env, shell: false,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('detached child launch timed out')), 2_000);
      child.once('spawn', () => { clearTimeout(timer); resolve(); });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
  } catch (error) {
    await rm(store.dir, { recursive: true, force: true });
    throw new RelayError(`Failed to start detached run: ${error instanceof Error ? error.message : String(error)}`, { code: 'SPAWN_FAILED' });
  }
  child.unref();
  out(`Started ${state.runId}`);
  hint(`relay watch ${state.runId}`);
  hint(`relay stop ${state.runId}`);
  return EXIT.success;
}

export async function runDetachedChild(runRef: string): Promise<number> {
  const cli = await createCliContext();
  const state = await resolveRun(cli.repo.root, runRef);
  return executeRun(cli, state, {}, 'run');
}

/**
 * What the run will do, and what it has cost to do it here before.
 *
 * The sample size is part of the estimate rather than a footnote: "about four
 * minutes, from two runs" and "about four minutes, from thirty" are different
 * claims, and only the reader can decide which one to plan around. A
 * repository with no completed runs is told exactly that — an invented number
 * would be worse than none, because it would be believed.
 */
export function printEstimate(estimate: RunEstimate, maxCostUsd: number | null = null): void {
  section('Estimate');
  out(dim(`  ${estimate.phases.map(phaseLabel).join(' → ')}`));

  if (estimate.sampleSize === 0) {
    hint(
      estimate.unfinished === 0
        ? 'No previous runs in this repository, so there is nothing to estimate from — this is the first.'
        : `No completed runs in this repository (${estimate.unfinished} unfinished), so there is nothing to estimate from.`,
    );
    if (maxCostUsd !== null) hint(`It will stop itself past ${formatCost(maxCostUsd)}.`);
    return;
  }

  const sample = `from ${estimate.sampleSize} completed run${estimate.sampleSize === 1 ? '' : 's'}`;
  rows([
    estimate.duration !== undefined && {
      label: 'Duration',
      value: facts([
        `~${formatDuration(estimate.duration.median)}`,
        `worst ${formatDuration(estimate.duration.worst)}`,
        dim(sample),
      ]),
    },
    {
      label: 'Cost',
      value:
        estimate.cost === undefined
          ? dim('no previous run reported one — the agents in this repository publish no price')
          : facts([
              `~${formatCost(estimate.cost.median)}`,
              `worst ${formatCost(estimate.cost.worst)}`,
              dim(
                estimate.cost.sampleSize === estimate.sampleSize
                  ? sample
                  : `from ${estimate.cost.sampleSize} of ${estimate.sampleSize} runs that reported one`,
              ),
            ]),
    },
    maxCostUsd !== null && { label: 'Budget', value: `stops itself past ${formatCost(maxCostUsd)}` },
  ]);

  if (estimate.cost !== undefined && estimate.cost.unpriced > 0) {
    hint(`${estimate.cost.unpriced} turn(s) in that sample reported no price, so the cost is a floor.`);
  }
  if (estimate.unobserved.length > 0) {
    hint(`No history for ${estimate.unobserved.map(phaseLabel).join(', ')} — the estimate leaves them out.`);
  }
}

/**
 * The one question asked before a run, and only when the user asked for it.
 *
 * `workflow.confirmAboveUsd` means "never start a run above this without me",
 * so a terminal nobody is watching is a refusal rather than a prompt — the
 * same rule the merge offer follows, for the same reason.
 */
export async function confirmEstimate(
  estimate: RunEstimate,
  thresholdUsd: number | null,
  deps: { prompter?: PromptSession } = {},
): Promise<boolean> {
  const cost = estimate.cost;
  if (cost === undefined || thresholdUsd === null || !exceedsThreshold(estimate, thresholdUsd)) return true;

  const owned = deps.prompter === undefined;
  const prompter = deps.prompter ?? new Prompter();

  try {
    if (!prompter.interactive) {
      throw new RelayError(
        `Runs of this shape cost ${formatCost(cost.median)} here, above the ` +
          `${formatCost(thresholdUsd)} you asked to be consulted about — and this is not a terminal, ` +
          'so there is nobody to ask.',
        {
          code: 'COST_NOT_CONFIRMED',
          hint:
            'Start it from a terminal, or raise workflow.confirmAboveUsd in .relay/config.json ' +
            '(null removes the question entirely).',
        },
      );
    }

    out();
    // Enter is "no": the threshold exists because this run is expensive enough
    // that its author wanted to be stopped, not nudged.
    return await prompter.confirm(
      `  Runs of this shape cost about ${formatCost(cost.median)} here, worst ` +
        `${formatCost(cost.worst)}. Start it?`,
      false,
    );
  } catch (error) {
    if (isPromptCancelled(error)) return false;
    throw error;
  } finally {
    if (owned) prompter.close();
  }
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
  // The phases already taken are history, but the ones left are not: a resume
  // is exactly when somebody decides the remaining reviews should be harder —
  // or, after a round limit was hit, that this run has been reviewed enough.
  if (options.review !== undefined || options.fast === true) {
    const level = resolveReviewLevel(options);
    if (level !== undefined) {
      previous.config.workflow.review = level;
      applyReviewLevel(previous.config.workflow, level);
      out(dim(`Review ${level} from here: ${describeReview(previous.config.workflow)}.`));
    }
  }
  // A budget applies from here on, and the cost already spent counts against
  // it: resuming past a cap the run has already breached would defeat it.
  if (options.maxCost !== undefined) previous.config.workflow.maxCostUsd = parseCost(options.maxCost, '--max-cost');
  // The phases this run will take are already decided, but what it writes on
  // its way out is not: a resume is allowed to change the voice.
  if (options.tuff === true) previous.config.workflow.typos = true;
  // A resume is exactly when a scan finding gets answered: the run stopped at
  // `branch`, the user looked at the file, and this is the deliberate override.
  if (options.allowSecret !== undefined && options.allowSecret.length > 0) {
    previous.config.delivery = {
      comment: previous.config.delivery?.comment ?? false,
      allowSecrets: [...(previous.config.delivery?.allowSecrets ?? []), ...options.allowSecret],
    };
  }

  if (isTerminal(previous.phase)) {
    if (previous.phase === 'COMPLETE') {
      // Nothing left to run, but delivery may still have something to do:
      // a push that failed, or a policy that has been raised since.
      out(`Run ${previous.runId} already completed.`);
      return deliverRun(previous, { command: 'resume', cli, ...(options.json === true ? { json: true } : {}) });
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
    // Whatever stopped it last time is history; this attempt records its own.
    delete previous.stopped;
    if (previous.notification !== undefined) delete previous.notification.completion;
  } else {
    out(dim(`Resuming ${previous.runId} from ${previous.phase}.`));
  }

  const store = new RunStore(previous.repository.root, previous.runId);
  await store.saveState(previous);
  const admitted = await waitForAdmission(previous.repository.root, previous.runId, previous.config.workflow.maxConcurrentRuns ?? 1);
  return executeRun(cli, admitted, options, 'resume');
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
  options: { policy?: DeliveryPolicy; json?: boolean; command?: string; cli?: CliContext; allowSecrets?: string[] } = {},
): Promise<number> {
  const store = new RunStore(state.repository.root, state.runId);
  if (options.policy !== undefined) state.config.workflow.deliver = options.policy;
  // `--allow-secret`: the deliberate answer to a scan finding, scoped to this
  // run's snapshot — the repository's own config never learns it.
  if (options.allowSecrets !== undefined && options.allowSecrets.length > 0) {
    state.config.delivery = {
      comment: state.config.delivery?.comment ?? false,
      allowSecrets: [...(state.config.delivery?.allowSecrets ?? []), ...options.allowSecrets],
    };
  }
  const json = options.json === true;

  await delivering({
    state,
    store,
    observer: cliObserver,
    signal: new AbortController().signal,
    ...(options.cli === undefined ? {} : { issueProvider: issueProviderFor(options.cli, state) }),
  });
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
  reviewCompleted() {},
  testStatus() {},
  note: (text) => out(`  ${text}`),
  warn: (text) => out(warning(`  ${text}`)),
};

export async function executeRun(
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
  // Runs in a batch share one terminal, so each reports itself in lines tagged
  // with its short id rather than redrawing a dashboard over its neighbours.
  const compact: RunDisplay = {
    ...cliObserver,
    start: () => out(dim(`[${state.shortId}] started ${state.issueRef}`)),
    finish: (phase) => out(dim(`[${state.shortId}] ${phaseLabel(phase)}`)),
    phaseChanged: (phase) => out(dim(`[${state.shortId}] ${phaseLabel(phase)}`)),
    note: (text) => out(`  [${state.shortId}] ${text}`),
    warn: (text) => out(warning(`  [${state.shortId}] ${text}`)),
  };
  const renderer =
    stream === undefined && options.compact !== true
      ? rendererFor(state, options, {
          onStop: () => store.requestCancel(`stopped by user at ${new Date().toISOString()}`),
        })
      : undefined;
  const display: RunDisplay = stream ?? renderer ?? compact;

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

  const tracking = await createTracking({ state, store, observer: display, signal: controller.signal });

  const context: EngineContext = {
    state,
    store,
    harnesses: cli.harnesses,
    issueProvider: issueProviderFor(cli, state),
    observer: tracking.observer,
    signal: controller.signal,
  };

  let finalState: RunState;
  try {
    finalState = await new WorkflowEngine(context).run();
    display.finish(finalState.phase);
    if (!json && finalState.config.notify.bell && process.stdout.isTTY) process.stdout.write('\u0007');
  } finally {
    renderer?.teardown();
    tracking.stop();
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
  await pruneArtifacts(state.repository.root, state.config.retention?.artifactDays ?? 30).catch(() => undefined);
  return code;
}

/**
 * The renderer a run is displayed through, built from the run itself.
 *
 * `relay run` and `relay attach` show the same picture of the same run, so they
 * build it the same way. Only the live run can stop the engine, which is why
 * `hooks` is separate: attaching to someone else's run gets the display without
 * the controls.
 */
export function rendererFor(
  state: RunState,
  options: Pick<RunOptions, 'verbose'> = {},
  hooks: { onStop?: () => void | Promise<void> } = {},
): RunRenderer {
  return new RunRenderer({
    // The renderer supplies the mark; this is only what the run is about. A
    // task with no number is named after where it came from — `./spec.md`,
    // `--prompt` — because `Issue undefined` says less than nothing.
    title: state.issue !== undefined && state.issue.number !== null ? `Issue #${state.issue.number}` : state.task?.origin ?? `Issue ${state.issueRef}`,
    subtitle: state.issue?.title ?? state.task?.title ?? `run ${state.runId}`,
    agentNames: { planner: state.config.agents.planner, planReviewer: state.config.agents.planReviewer, implementer: state.config.agents.implementer, codeReviewer: state.config.agents.codeReviewer },
    phases: displayPhasesFor(state.config.workflow),
    state,
    ...hooks,
    ...(options.verbose === true ? { verbose: true } : {}),
  });
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
    const stopped = state.stopped;
    out(
      warning(stopped?.reason === 'budget' ? 'Run stopped by its budget' : 'Run cancelled') +
        dim(` after ${formatDuration(elapsed)}`),
    );
    if (stopped?.reason === 'budget') out(`  ${stopped.detail}. Nothing was published.`);
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
    state.usage !== undefined && { label: 'Usage', value: usageLine(state) },
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

  const link = delivery.issueLink;
  rows([
    ...delivery.steps.map((step) => ({
      label:
        `${step.status === 'done' ? success(marks.ok) : step.status === 'failed' ? failure(marks.failed) : dim(marks.bullet)} ` +
        stepLabel(step.step),
      value: step.status === 'done' ? step.detail : step.status === 'failed' ? failure(step.detail) : dim(step.detail),
    })),
    link !== undefined && {
      label: `${link.status === 'done' ? success(marks.ok) : dim(marks.bullet)} Issue link`,
      value: link.status === 'done' ? link.detail : dim(link.detail),
    },
    delivery.comment !== undefined && {
      label: `${delivery.comment.status === 'done' ? success(marks.ok) : delivery.comment.status === 'failed' ? failure(marks.failed) : dim(marks.bullet)} Issue comment`,
      value: delivery.comment.status === 'done' ? delivery.comment.detail : delivery.comment.status === 'failed' ? failure(delivery.comment.detail) : dim(delivery.comment.detail),
    },
  ]);
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
    // Only while the merge question is still unanswered — an answered "no"
    // was a decision, and this block is a report, not a second ask.
    if (mergeUnanswered(state)) command(`relay deliver ${state.runId} --to merge`);
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

/**
 * Tokens, cost and the caveat that goes with them. A run whose Codex turns
 * published no price has a real cost that is higher than the one printed, and
 * a number presented without that is a number read as the bill.
 */
function usageLine(state: RunState): string {
  const usage = state.usage;
  if (usage === undefined) return dim('none reported');
  const unpriced = unpricedTurns(usage.total);
  return formatUsage(usage.total) + (unpriced === 0 ? '' : dim(`  (${unpriced} turn(s) reported no cost)`));
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
