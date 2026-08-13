import { RelayError } from '../util/errors.ts';
import type { AgentProvider, DeliveryPolicy, RelayConfig, Role } from '../storage/config.ts';
import type { ReviewRound } from '../reviews/types.ts';
import type { Phase } from './phases.ts';
import { canTransition, isTerminal } from './phases.ts';
import type { RunUsage } from './usage.ts';

export interface AgentBinding {
  provider: AgentProvider;
  /** Present once the CLI has reported a resumable session. */
  sessionId?: string;
}

export interface IssueSummary {
  number: number;
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

  repository: { root: string; owner: string | null; name: string | null; defaultBranch: string };
  workspace?: WorkspaceInfo;

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
  /** Tokens and cost the run has spent so far. Absent until a CLI reports any. */
  usage?: RunUsage;

  error?: { message: string; phase: Phase; code?: string };
  /** PID of the process driving the run, so `relay stop` can signal it. */
  pid?: number;
}

export interface CreateRunStateOptions {
  runId: string;
  shortId: string;
  issueRef: string;
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
  return state as RunState;
}
