import { acquireLock } from '../git/lock.ts';
import { listRuns, RunStore } from '../storage/runs.ts';
import { isTerminal } from './phases.ts';
import { transition, type RunState } from './state.ts';

export function pidAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export async function admit(repoRoot: string, runId: string, max: number): Promise<RunState | undefined> {
  const lock = await acquireLock(repoRoot, 'admission', { runId });
  try {
    const runs = await listRuns(repoRoot);
    const state = runs.find((run) => run.runId === runId);
    if (state === undefined || isTerminal(state.phase)) return state;
    const active = runs.filter((run) => run.runId !== runId && run.phase !== 'QUEUED' && !isTerminal(run.phase) && pidAlive(run.pid));
    if (active.length >= max) return undefined;
    if (state.phase === 'QUEUED') transition(state, 'INITIALIZING');
    state.pid = process.pid;
    await new RunStore(repoRoot, runId).saveState(state);
    return state;
  } finally { await lock.release(); }
}

export async function waitForAdmission(repoRoot: string, runId: string, max: number, signal?: AbortSignal): Promise<RunState> {
  for (;;) {
    const state = await admit(repoRoot, runId, max);
    if (state !== undefined) return state;
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 100); signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); });
  }
}
