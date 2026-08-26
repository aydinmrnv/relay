import { isTerminal } from './phases.ts';
import type { RunState } from './state.ts';

export type RunLiveness = 'terminal' | 'running' | 'stale';

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function runLiveness(state: Pick<RunState, 'phase' | 'pid'>): RunLiveness {
  if (isTerminal(state.phase)) return 'terminal';
  return state.pid !== undefined && processAlive(state.pid) ? 'running' : 'stale';
}

/**
 * Whether this platform has a signal that means "wind down" rather than "die".
 *
 * On POSIX it does: SIGINT reaches the run's own handler, which cancels the
 * agents in flight and lets the engine record a CANCELLED run — exactly what
 * Ctrl-C does. Windows has no such signal. `process.kill` there terminates the
 * target outright whatever name it is given, which would kill the run
 * mid-phase, leaving state that still claims a phase is in flight and a
 * worktree nobody ever cleans up.
 *
 * So `relay stop` signals nothing on Windows. It does not need to: the
 * cancellation flag it has already written is what the engine actually checks,
 * at every phase boundary, and the run winds itself down from there. The only
 * difference the user sees is that stopping takes until the end of the current
 * phase — which `relay stop` says out loud rather than implying it was instant.
 */
export function canSignalStop(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}
