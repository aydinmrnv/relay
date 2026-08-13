import type { DiffSnapshot } from '../git/diff.ts';
import type { LoggedEvent } from '../storage/runs.ts';
import type { Phase } from '../workflow/phases.ts';
import { isTerminal, phaseLabel } from '../workflow/phases.ts';
import type { RunState } from '../workflow/state.ts';
import type { RunUsageJson } from './runJson.ts';
import { usageToJson } from './runJson.ts';

/**
 * The machine-readable shapes of the inspect commands: `diff`, `logs`, `plan`
 * and `stop`.
 *
 * Each one is built from state, git or the event log — never from the strings
 * the terminal view paints — so nothing here can carry a colour code, an
 * ellipsis or a column that was sized to fit a frame.
 */

export interface DiffFileJson {
  status: string;
  path: string;
  /** The name it had before a rename, or `null`. */
  previousPath: string | null;
  additions: number;
  deletions: number;
}

export interface DiffJson {
  runId: string;
  branch: string | null;
  fileCount: number;
  additions: number;
  deletions: number;
  files: DiffFileJson[];
  /**
   * The unified patch, or `null` under `--stat`, which asked for the summary
   * and not the diff. `null` says "not requested"; `""` would say "no changes".
   */
  patch: string | null;
  /**
   * Where the answer came from. `worktree` is recomputed from git and reflects
   * the branch as it is now; `stored` is the patch captured during the run,
   * which is all that survives once the worktree is pruned.
   */
  source: 'worktree' | 'stored';
  truncated: boolean;
}

/** Projects a live worktree diff. `stat` drops the patch, not the file list. */
export function diffToJson(
  state: RunState,
  snapshot: DiffSnapshot,
  options: { stat?: boolean } = {},
): DiffJson {
  return {
    runId: state.runId,
    branch: state.workspace?.branch ?? null,
    fileCount: snapshot.files.length,
    additions: snapshot.additions,
    deletions: snapshot.deletions,
    files: snapshot.files.map((file) => ({
      status: file.status,
      path: file.path,
      previousPath: file.previousPath ?? null,
      additions: file.added,
      deletions: file.removed,
    })),
    patch: options.stat === true ? null : snapshot.patch,
    source: 'worktree',
    truncated: snapshot.truncated,
  };
}

/**
 * Projects the patch Relay stored during the run, for the case the worktree is
 * gone. The per-file breakdown comes from the run's own diff summary, which
 * records the count but not the line changes per file.
 */
export function storedDiffToJson(state: RunState, patch: string, options: { stat?: boolean } = {}): DiffJson {
  const diff = state.diff;
  return {
    runId: state.runId,
    branch: state.workspace?.branch ?? null,
    fileCount: diff?.fileCount ?? 0,
    additions: diff?.additions ?? 0,
    deletions: diff?.deletions ?? 0,
    files: (diff?.files ?? []).map((path) => ({
      status: 'M',
      path,
      previousPath: null,
      additions: 0,
      deletions: 0,
    })),
    patch: options.stat === true ? null : patch,
    source: 'stored',
    truncated: false,
  };
}

export interface EventJson {
  timestamp: string;
  phase: Phase;
  agent: string | null;
  type: string;
  message: string | null;
  data: Record<string, unknown> | null;
}

export interface LogsJson {
  runId: string;
  /** Events actually returned, after `--limit`. */
  count: number;
  /** Events the run has recorded in total, so a truncated read says so. */
  total: number;
  events: EventJson[];
  usage: RunUsageJson | null;
}

/**
 * Projects the event log. The `data` payload is passed through as the run
 * recorded it — already redacted on the way in — rather than flattened to the
 * one-line summary the terminal shows.
 */
export function logsToJson(state: RunState, events: readonly LoggedEvent[], limit: number): LogsJson {
  const shown = limit >= events.length ? events : events.slice(-limit);
  return {
    runId: state.runId,
    count: shown.length,
    total: events.length,
    events: shown.map(eventToJson),
    usage: state.usage === undefined ? null : usageToJson(state.usage),
  };
}

export function eventToJson(event: LoggedEvent): EventJson {
  return {
    timestamp: event.timestamp,
    phase: event.phase,
    agent: event.agent ?? null,
    type: event.type,
    message: event.message ?? null,
    data: event.data ?? null,
  };
}

export interface PlanJson {
  runId: string;
  approved: boolean;
  /** The plan as markdown, byte-for-byte as the agents wrote it. */
  plan: string;
}

export function planToJson(state: RunState, plan: string): PlanJson {
  return { runId: state.runId, approved: state.planApproved, plan: plan.trimEnd() };
}

export interface StopJson {
  runId: string;
  phase: Phase;
  phaseLabel: string;
  terminal: boolean;
  /** Whether this invocation recorded the cancellation flag. */
  cancelRequested: boolean;
  /** The process driving the run, when there was one to signal. */
  pid: number | null;
  /** Whether SIGINT actually reached it. False when the process was already gone. */
  signalled: boolean;
}

export function stopToJson(
  state: RunState,
  outcome: { cancelRequested: boolean; signalled: boolean },
): StopJson {
  return {
    runId: state.runId,
    phase: state.phase,
    phaseLabel: phaseLabel(state.phase),
    terminal: isTerminal(state.phase),
    cancelRequested: outcome.cancelRequested,
    pid: state.pid ?? null,
    signalled: outcome.signalled,
  };
}
