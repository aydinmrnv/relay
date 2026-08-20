import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../src/storage/config.ts';
import { RunStore } from '../src/storage/runs.ts';
import { runQueue } from '../src/workflow/queue.ts';
import { createRunState, transition } from '../src/workflow/state.ts';

test('queue never exceeds its worker and repository limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-queue-'));
  const repository = { root, owner: null, name: null, defaultBranch: 'main' };
  const states = [1, 2, 3].map((number) => createRunState({
    runId: `20260101T00000${number}-queue${number}`, shortId: `queue${number}`, issueRef: String(number),
    repository, config: structuredClone(DEFAULT_CONFIG), queued: true,
  }));
  let active = 0;
  let peak = 0;
  const code = await runQueue(states, 2, async (state) => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 150));
    active -= 1;
    transition(state, 'FAILED');
    delete state.pid;
    await new RunStore(root, state.runId).saveState(state);
    return 0;
  });
  assert.equal(code, 0);
  assert.equal(peak, 2);
  for (const state of states) assert.equal((await new RunStore(root, state.runId).loadState()).phase, 'FAILED');
});
