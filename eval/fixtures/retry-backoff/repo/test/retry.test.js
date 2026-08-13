import { test } from 'node:test';
import assert from 'node:assert/strict';

import { delayFor, retry } from '../src/retry.js';

const noSleep = () => Promise.resolve();

test('a successful operation is called once and its value returned', async () => {
  let calls = 0;
  const value = await retry(
    () => {
      calls += 1;
      return 'ok';
    },
    { sleep: noSleep },
  );
  assert.equal(value, 'ok');
  assert.equal(calls, 1);
});

test('a transient failure is retried', async () => {
  let calls = 0;
  const value = await retry(
    () => {
      calls += 1;
      if (calls < 2) throw new Error('flaky');
      return 'ok';
    },
    { sleep: noSleep },
  );
  assert.equal(value, 'ok');
  assert.equal(calls, 2);
});

test('the operation receives the attempt index', async () => {
  const seen = [];
  await retry(
    (attempt) => {
      seen.push(attempt);
      if (seen.length < 3) throw new Error('again');
      return 'ok';
    },
    { sleep: noSleep },
  );
  assert.deepEqual(seen, [0, 1, 2]);
});

test('delays grow exponentially and are capped', () => {
  assert.equal(delayFor(0, { baseMs: 100, factor: 2, maxMs: 2000 }), 100);
  assert.equal(delayFor(1, { baseMs: 100, factor: 2, maxMs: 2000 }), 200);
  assert.equal(delayFor(2, { baseMs: 100, factor: 2, maxMs: 2000 }), 400);
  assert.equal(delayFor(9, { baseMs: 100, factor: 2, maxMs: 2000 }), 2000);
});
