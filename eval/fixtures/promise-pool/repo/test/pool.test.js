import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runPool } from '../src/pool.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('results come back in task order', async () => {
  const tasks = [async () => { await wait(20); return 'a'; }, async () => 'b', async () => { await wait(5); return 'c'; }];
  assert.deepEqual(await runPool(tasks, 2), ['a', 'b', 'c']);
});

test('no more than the limit run at once', async () => {
  let active = 0;
  let peak = 0;
  const tasks = Array.from({ length: 8 }, () => async () => {
    active += 1;
    peak = Math.max(peak, active);
    await wait(5);
    active -= 1;
  });

  await runPool(tasks, 3);
  assert.ok(peak <= 3, `peak concurrency was ${peak}`);
});

test('an empty list resolves to an empty array', async () => {
  assert.deepEqual(await runPool([], 4), []);
});

test('a failure rejects with an AggregateError', async () => {
  const tasks = [async () => 'ok', async () => { throw new Error('boom'); }];
  await assert.rejects(runPool(tasks, 2), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    return true;
  });
});
