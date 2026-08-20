import { RunStore } from '../storage/runs.ts';
import { transition, type RunState } from './state.ts';
import { waitForAdmission } from './admission.ts';

export async function runQueue(
  states: RunState[],
  max: number,
  execute: (state: RunState) => Promise<number>,
): Promise<number> {
  for (const state of states) {
    const store = new RunStore(state.repository.root, state.runId);
    await store.init();
    await store.saveState(state);
  }
  let next = 0;
  let code = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const original = states[index];
      if (original === undefined) return;
      const store = new RunStore(original.repository.root, original.runId);
      let state = await store.loadState();
      if (state.phase === 'CANCELLED' || await store.cancelRequested()) {
        if (state.phase === 'QUEUED') { transition(state, 'CANCELLED', { note: 'cancelled before start' }); await store.saveState(state); }
        continue;
      }
      state = await waitForAdmission(state.repository.root, state.runId, max);
      code = Math.max(code, await execute(state));
    }
  };
  await Promise.all(Array.from({ length: Math.min(max, states.length) }, () => worker()));
  return code;
}
