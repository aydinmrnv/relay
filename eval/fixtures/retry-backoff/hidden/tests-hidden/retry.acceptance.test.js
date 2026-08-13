import { test } from 'node:test';
import assert from 'node:assert/strict';

import { retry } from '../src/retry.js';

function recorder() {
  const sleeps = [];
  return { sleeps, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } };
}

test('attempts is a total, not a retry count', async () => {
  const { sleep, sleeps } = recorder();
  let calls = 0;
  await assert.rejects(
    retry(
      () => {
        calls += 1;
        throw new Error(`fail ${calls}`);
      },
      { attempts: 3, sleep },
    ),
  );
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2, 'there is nothing to wait for after the last attempt');
});

test('attempts: 1 means no retrying at all', async () => {
  const { sleep, sleeps } = recorder();
  let calls = 0;
  await assert.rejects(
    retry(
      () => {
        calls += 1;
        throw new Error('nope');
      },
      { attempts: 1, sleep },
    ),
  );
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
});

test('the last error is the one thrown', async () => {
  const { sleep } = recorder();
  await assert.rejects(
    retry(
      (attempt) => {
        throw new Error(`attempt-${attempt}`);
      },
      { attempts: 3, sleep },
    ),
    /attempt-2/,
  );
});

test('a non-retryable error stops everything immediately', async () => {
  const { sleep, sleeps } = recorder();
  let calls = 0;
  const fatal = Object.assign(new Error('not authenticated'), { retryable: false });

  await assert.rejects(
    retry(
      () => {
        calls += 1;
        throw fatal;
      },
      { attempts: 5, sleep },
    ),
    /not authenticated/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
});

test('a non-retryable error part-way through stops the rest', async () => {
  const { sleep, sleeps } = recorder();
  let calls = 0;
  await assert.rejects(
    retry(
      () => {
        calls += 1;
        if (calls < 3) throw new Error('transient');
        throw Object.assign(new Error('fatal'), { retryable: false });
      },
      { attempts: 10, sleep },
    ),
    /fatal/,
  );
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2);
});

test('retryable: true is retried like any other error', async () => {
  const { sleep } = recorder();
  let calls = 0;
  const value = await retry(
    () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('rate limited'), { retryable: true });
      return 'ok';
    },
    { attempts: 4, sleep },
  );
  assert.equal(value, 'ok');
  assert.equal(calls, 3);
});

test('sleeps follow the backoff schedule, in order', async () => {
  const { sleep, sleeps } = recorder();
  await assert.rejects(
    retry(() => { throw new Error('x'); }, { attempts: 4, baseMs: 50, factor: 3, maxMs: 300, sleep }),
  );
  assert.deepEqual(sleeps, [50, 150, 300]);
});

test('success on the final permitted attempt still returns', async () => {
  const { sleep, sleeps } = recorder();
  let calls = 0;
  const value = await retry(
    () => {
      calls += 1;
      if (calls < 3) throw new Error('nearly');
      return 'ok';
    },
    { attempts: 3, sleep },
  );
  assert.equal(value, 'ok');
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2);
});
