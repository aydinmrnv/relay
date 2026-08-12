import { RelayError } from '../util/errors.ts';
import type { AgentProvider, RelayConfig, Role } from '../storage/config.ts';
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

/** A commit Relay made on the run branch. Local only: nothing is ever pushed. */
export interface CommitRecord {
  sha: string;
  branch: string;
  subject: string;
  at: string;
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
  /** Present once `--commit` captured the work on the run branch. */
  commit?: CommitRecord;
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
