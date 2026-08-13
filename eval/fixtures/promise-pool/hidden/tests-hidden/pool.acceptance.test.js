import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapPool, runPool } from '../src/pool.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('mapPool maps items in order', async () => {
  const results = await mapPool([1, 2, 3], async (item) => {
    await wait(item === 1 ? 20 : 1);
    return item * 2;
  });
  assert.deepEqual(results, [2, 4, 6]);
});

test('the mapper receives the item and its index', async () => {
  const seen = [];
  await mapPool(['a', 'b', 'c'], async (item, index) => {
    seen.push([item, index]);
  }, { concurrency: 1 });
  assert.deepEqual(seen, [['a', 0], ['b', 1], ['c', 2]]);
});

test('an empty list never calls the mapper', async () => {
  let calls = 0;
  assert.deepEqual(await mapPool([], async () => { calls += 1; }), []);
  assert.equal(calls, 0);
});

test('a concurrency larger than the list is fine', async () => {
  assert.deepEqual(await mapPool([1, 2], async (item) => item, { concurrency: 10 }), [1, 2]);
});

test('concurrency is validated before anything runs', async () => {
  let calls = 0;
  const mapper = async () => { calls += 1; };
  await assert.rejects(mapPool([1], mapper, { concurrency: 0 }), RangeError);
  await assert.rejects(mapPool([1], mapper, { concurrency: 1.5 }), RangeError);
  await assert.rejects(mapPool([1], mapper, { concurrency: -1 }), RangeError);
  assert.equal(calls, 0);
});

test('concurrency 1 is sequential', async () => {
  let active = 0;
  let peak = 0;
  await mapPool(Array.from({ length: 5 }, (_, index) => index), async () => {
    active += 1;
    peak = Math.max(peak, active);
    await wait(2);
    active -= 1;
  }, { concurrency: 1 });
  assert.equal(peak, 1);
});

test('the concurrency cap holds for mapPool too', async () => {
  let active = 0;
  let peak = 0;
  await mapPool(Array.from({ length: 12 }, (_, index) => index), async () => {
    active += 1;
    peak = Math.max(peak, active);
    await wait(3);
    active -= 1;
  }, { concurrency: 4 });
  assert.ok(peak <= 4, `peak concurrency was ${peak}`);
});

test('every item is attempted even after a failure', async () => {
  const attempted = [];
  await assert.rejects(
    mapPool([0, 1, 2, 3], async (item) => {
      attempted.push(item);
      if (item === 0) throw new Error('first');
      return item;
    }, { concurrency: 2 }),
    AggregateError,
  );
  assert.deepEqual(attempted.sort(), [0, 1, 2, 3]);
});

test('aggregated errors are in item order, not completion order', async () => {
  await assert.rejects(
    mapPool([0, 1, 2], async (item) => {
      // Item 0 fails last in wall-clock order and must still be reported first.
      if (item === 0) { await wait(30); throw new Error('zero'); }
      if (item === 2) { await wait(5); throw new Error('two'); }
      return item;
    }, { concurrency: 3 }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors.map((each) => each.message), ['zero', 'two']);
      return true;
    },
  );
});

test('runPool is mapPool over thunks', async () => {
  const tasks = [async () => 'a', async () => { throw new Error('b'); }, async () => 'c'];
  await assert.rejects(runPool(tasks, 3), (error) => {
    assert.deepEqual(error.errors.map((each) => each.message), ['b']);
    return true;
  });
  assert.deepEqual(await runPool([async () => 1, async () => 2], 1), [1, 2]);
  await assert.rejects(runPool([async () => 1], 0), RangeError);
});

test('a mapper that throws synchronously is caught like any other failure', async () => {
  await assert.rejects(
    mapPool([1, 2], (item) => {
      if (item === 1) throw new Error('sync');
      return Promise.resolve(item);
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors.map((each) => each.message), ['sync']);
      return true;
    },
  );
});
