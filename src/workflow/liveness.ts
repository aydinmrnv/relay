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
