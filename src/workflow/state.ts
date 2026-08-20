import { RelayError } from '../util/errors.ts';
import type { LocalTask } from '../issues/local.ts';
import type { AgentProvider, DeliveryPolicy, RelayConfig, Role } from '../storage/config.ts';
import type { ReviewRound } from '../reviews/types.ts';
import type { Phase } from './phases.ts';
import { canTransition, isTerminal } from './phases.ts';
import type { RunUsage } from './usage.ts';
import type { ProjectBrief } from '../agents/brief.ts';

export interface AgentBinding {
  provider: AgentProvider;
  /** Present once the CLI has reported a resumable session. */
  sessionId?: string;
}

export interface IssueSummary {
  /**
   * Provider-scoped identity: `github:acme/widgets#142`, `local:fix-flaky-timeout`.
   * Absent on runs recorded before an issue could come from anywhere but GitHub.
   */
  id?: string;
  /**
   * The tracker's own number, or null when the tracker has none. Naming, display
   * and the pull request's `Closes` line all read this rather than assume it.
   */
  number: number | null;
  title: string;
  url: string;
  state: string;
}

export interface WorkspaceInfo {
  path: string;
  branch: string;
  baseSha: string;
  baseRef: string;
  baseBranch: string;
}

export interface DiffSummary {
  fileCount: number;
  additions: number;
  deletions: number;
  files: string[];
  /** Path, relative to the run directory, of the stored patch. */
  patchFile: string;
  at: string;
}

export interface TestRecord {
  discovered: boolean;
  command: string[];
  /** Where the command ran, relative to the worktree. Absent means the root. */
  directory?: string;
  reason: string;
  exitCode: number | null;
  passed: boolean;
  durationMs: number;
  timedOut: boolean;
  /** Relative path of the stored stdout/stderr capture. */
  outputFile?: string;
  skippedReason?: string;
  at: string;
}

/** A commit Relay made on the run branch. Local until someone asks for more. */
export interface CommitRecord {
  sha: string;
  branch: string;
  subject: string;
  at: string;
}

/**
 * The three records below are written by the delivery phase, and each one is
 * the evidence that the run's work left this machine — what moved, where, and
 * when. They are recorded rather than inferred: `relay status` should never
 * have to guess whether a branch was pushed.
 */
export interface PushRecord {
  remote: string;
  branch: string;
  sha: string;
  at: string;
}

export interface PullRequestRecord {
  url: string;
  number: number | null;
  base: string;
  head: string;
  /** True only when `gh pr create` created this PR for this run. */
  createdByRun: boolean;
  at: string;
}

export interface CleanupOutcome { status: 'deleted' | 'removed' | 'absent' | 'skipped' | 'failed'; detail: string; at: string }
export interface CleanupRecord { remoteBranch?: CleanupOutcome; worktree?: CleanupOutcome }

export interface MergeRecord {
  /** Branch the work was merged into. */
  into: string;
  /**
   * Where it landed. `pull-request` means GitHub merged it and this machine's
   * checkout was never touched; `local` means Relay merged it here.
   */
  via: 'local' | 'pull-request';
  /** Merge commit, when Relay made it locally. */
  sha?: string;
  fastForward?: boolean;
  /** The pull request that was merged, when that is how it landed. */
  url?: string;
  at: string;
}

/** The steps delivery can take, in the order it takes them. */
export const DELIVERY_STEPS = ['commit', 'push', 'pullRequest', 'merge'] as const;
export type DeliveryStep = (typeof DELIVERY_STEPS)[number];

export interface DeliveryStepRecord {
  step: DeliveryStep;
  status: 'done' | 'skipped' | 'failed';
  /** What it produced, or why it did not run. Always populated. */
  detail: string;
  at: string;
}

/**
 * Whether the pull request closes a tracker issue, and why not when it does not.
 *
 * A task with no tracker behind it has nothing to link, which must be a recorded
 * skip rather than a failure — the work is delivered either way. Silently
 * dropping the line would make a local run look identical to one whose issue
 * reference was wrong.
 */
export interface IssueLinkRecord {
  status: 'done' | 'skipped';
  detail: string;
  at: string;
}

export interface IssueCommentRecord {
  status: 'done' | 'skipped' | 'failed';
  detail: string;
  url?: string;
  at: string;
}

export interface NotificationRecord {
  webhook?: { status: 'done' | 'skipped' | 'failed'; detail: string; at: string };
  system?: { status: 'done' | 'skipped' | 'failed'; detail: string; at: string };
  command?: { status: 'done' | 'skipped' | 'failed'; detail: string; at: string };
  completion?: { outcome: Phase; attemptedAt: string };
}

/**
 * What the delivery phase did, step by step.
 *
 * Skipped steps are recorded with their reason rather than omitted: "no
 * pull request" and "no pull request because this repository has no remote"
 * are different facts, and only one of them is actionable.
 */
export interface DeliveryRecord {
  /** The ceiling the run was configured with. */
  policy: DeliveryPolicy;
  /** How far it actually got. */
  reached: DeliveryPolicy;
  steps: DeliveryStepRecord[];
  at: string;
  cleanup?: CleanupRecord;
  /** Present once a pull request exists: whether it closes an issue, or why not. */
  issueLink?: IssueLinkRecord;
  comment?: IssueCommentRecord;
}

/**
 * Why a run ended before its work did, when the reason was not a failure.
 *
 * A cancelled run and a run that hit its cost ceiling leave the same phase
 * behind — CANCELLED, at a boundary, committed and unpublished — and the only
 * thing that tells them apart afterwards is this record.
 */
export interface StopRecord {
  reason: 'user' | 'budget';
  /** One phrase, reused as the transition note and the terminal line. */
  detail: string;
  at: string;
  /** Reported cost at the moment a budget stopped the run. */
  spentUsd?: number;
  maxCostUsd?: number;
}

export interface RunState {
  version: 1;
  runId: string;
  shortId: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;

  phase: Phase;
  /** Every transition, in order — the run's decision trail. */
  history: Array<{ phase: Phase; at: string; note?: string }>;

  issueRef: string;
  issue?: IssueSummary;
  /**
   * The task itself, when it came from this machine rather than a tracker.
   *
   * Carried by the run so a resume works from what the run started with, and so
   * a `--prompt` — which has no file to go back to — survives the process that
   * created it.
   */
  task?: LocalTask;

  repository: { root: string; owner: string | null; name: string | null; defaultBranch: string };
  workspace?: WorkspaceInfo;
  /** Project instructions snapshotted once when the run worktree is created. */
  brief?: ProjectBrief;

  agents: Partial<Record<Role, AgentBinding>>;
  /** Effective config for this run, snapshotted so later edits cannot rewrite history. */
  config: RelayConfig;

  rounds: { planReview: number; codeReview: number };
  reviews: ReviewRound[];

  planApproved: boolean;
  diff?: DiffSummary;
  tests?: TestRecord;
  /** Present once the work was captured in a commit on the run branch. */
  commit?: CommitRecord;
  /** Present once the run branch was pushed. */
  push?: PushRecord;
  pullRequest?: PullRequestRecord;
  merge?: MergeRecord;
  /** What the delivery phase did with the finished work, and what it skipped. */
  delivery?: DeliveryRecord;
  notification?: NotificationRecord;
  /** Tokens and cost the run has spent so far. Absent until a CLI reports any. */
  usage?: RunUsage;
  /** Why the run stopped short of finishing, when it did. */
  stopped?: StopRecord;

  error?: { message: string; phase: Phase; code?: string };
  /** PID of the process driving the run, so `relay stop` can signal it. */
  pid?: number;
}

export interface CreateRunStateOptions {
  runId: string;
  shortId: string;
  issueRef: string;
  /** Set when the run works from a local task rather than a tracker issue. */
  task?: LocalTask;
  repository: RunState['repository'];
  config: RelayConfig;
  now?: Date;
}

export function createRunState(options: CreateRunStateOptions): RunState {
  const at = (options.now ?? new Date()).toISOString();
  return {
    version: 1,
    runId: options.runId,
    shortId: options.shortId,
    createdAt: at,
    updatedAt: at,
    phase: 'INITIALIZING',
    history: [{ phase: 'INITIALIZING', at }],
    issueRef: options.issueRef,
    ...(options.task === undefined ? {} : { task: options.task }),
    repository: options.repository,
    agents: {
      planner: { provider: options.config.agents.planner },
      planReviewer: { provider: options.config.agents.planReviewer },
      implementer: { provider: options.config.agents.implementer },
      codeReviewer: { provider: options.config.agents.codeReviewer },
    },
    config: options.config,
    rounds: { planReview: 0, codeReview: 0 },
    reviews: [],
    planApproved: false,
  };
}

/**
 * Applies a phase transition, rejecting anything the state machine disallows.
 * Mutating `state.phase` directly anywhere else would bypass this check, so the
 * engine always goes through here.
 */
export function transition(state: RunState, to: Phase, options: { note?: string; now?: Date } = {}): RunState {
  if (state.phase === to) return state;

  if (!canTransition(state.phase, to)) {
    throw new RelayError(`Invalid workflow transition: ${state.phase} → ${to}.`, {
      code: 'INVALID_TRANSITION',
      hint: 'This is a bug in Relay. The run state has been left untouched.',
    });
  }

  const at = (options.now ?? new Date()).toISOString();
  state.phase = to;
  state.updatedAt = at;
  state.history.push({ phase: to, at, ...(options.note === undefined ? {} : { note: options.note }) });
  if (isTerminal(to)) state.finishedAt = at;
  return state;
}

export function recordAgentSession(state: RunState, role: Role, sessionId: string | undefined): void {
  const binding = state.agents[role];
  if (binding === undefined || sessionId === undefined) return;
  binding.sessionId = sessionId;
}

export function providerFor(state: RunState, role: Role): AgentProvider {
  return state.agents[role]?.provider ?? state.config.agents[role];
}

export function isRunning(state: RunState): boolean {
  return !isTerminal(state.phase);
}

/** Restores a persisted run, validating the parts the engine relies on. */
export function validateRunState(value: unknown): RunState {
  if (value === null || typeof value !== 'object') {
    throw new RelayError('Run state file is not a JSON object.', { code: 'BAD_RUN_STATE' });
  }
  const state = value as Partial<RunState>;
  if (state.version !== 1) {
    throw new RelayError(`Unsupported run state version: ${String(state.version)}.`, {
      code: 'BAD_RUN_STATE',
      hint: 'This run was created by a different version of Relay.',
    });
  }
  for (const key of ['runId', 'phase', 'issueRef'] as const) {
    if (typeof state[key] !== 'string') {
      throw new RelayError(`Run state is missing "${key}".`, { code: 'BAD_RUN_STATE' });
    }
  }
  if (state.config === undefined || state.repository === undefined) {
    throw new RelayError('Run state is missing its config or repository snapshot.', { code: 'BAD_RUN_STATE' });
  }
  if (state.brief !== undefined) {
    const brief = state.brief as Partial<ProjectBrief>;
    const validRoles = brief.roles !== null && typeof brief.roles === 'object' &&
      Object.entries(brief.roles).every(([role, text]) =>
        ['planner', 'implementer', 'reviewer'].includes(role) && typeof text === 'string');
    if (!Array.isArray(brief.sources) || !brief.sources.every((source) => typeof source === 'string') ||
        typeof brief.common !== 'string' || typeof brief.truncated !== 'boolean' || !validRoles) {
      throw new RelayError('Run state contains an invalid project brief.', { code: 'BAD_RUN_STATE' });
    }
  }
  return state as RunState;
}
