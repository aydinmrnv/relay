import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RateLimiter } from '../src/limiter.js';

test('the window slides rather than resetting', () => {
  const limiter = new RateLimiter({ limit: 2, windowMs: 1000 });
  assert.equal(limiter.allow('a', 0), true);
  assert.equal(limiter.allow('a', 900), true);
  // The request at 0 has just left the window, so there is room for one more.
  assert.equal(limiter.allow('a', 1000), true);
  // Now 900 and 1000 are both still inside it, so there is not.
  assert.equal(limiter.allow('a', 1500), false);
});

test('the window boundary is half-open', () => {
  const limiter = new RateLimiter({ limit: 1, windowMs: 1000 });
  assert.equal(limiter.allow('a', 0), true);
  assert.equal(limiter.allow('a', 999), false);
  assert.equal(limiter.allow('a', 1000), true);
});

test('a rejected request is not recorded', () => {
  const limiter = new RateLimiter({ limit: 1, windowMs: 1000 });
  assert.equal(limiter.allow('a', 0), true);
  assert.equal(limiter.allow('a', 500), false);
  // If the rejected request at 500 had been recorded, this would be refused.
  assert.equal(limiter.allow('a', 1000), true);
});

test('remaining counts what is left without spending it', () => {
  const limiter = new RateLimiter({ limit: 3, windowMs: 1000 });
  assert.equal(limiter.remaining('a', 0), 3);
  limiter.allow('a', 0);
  assert.equal(limiter.remaining('a', 0), 2);
  assert.equal(limiter.remaining('a', 0), 2);
  limiter.allow('a', 0);
  limiter.allow('a', 0);
  assert.equal(limiter.remaining('a', 0), 0);
  assert.equal(limiter.remaining('a', 1000), 3);
});

test('retryAfter is zero while there is room', () => {
  const limiter = new RateLimiter({ limit: 2, windowMs: 1000 });
  assert.equal(limiter.retryAfter('a', 0), 0);
  limiter.allow('a', 0);
  assert.equal(limiter.retryAfter('a', 0), 0);
});

test('retryAfter counts down to the oldest request leaving the window', () => {
  const limiter = new RateLimiter({ limit: 1, windowMs: 1000 });
  limiter.allow('a', 0);
  assert.equal(limiter.retryAfter('a', 0), 1000);
  assert.equal(limiter.retryAfter('a', 500), 500);
  assert.equal(limiter.retryAfter('a', 1000), 0);
});

test('retryAfter looks at the oldest counted request, not the newest', () => {
  const limiter = new RateLimiter({ limit: 2, windowMs: 1000 });
  limiter.allow('a', 0);
  limiter.allow('a', 400);
  assert.equal(limiter.retryAfter('a', 500), 500);
});

test('prune forgets keys with nothing left in the window', () => {
  const limiter = new RateLimiter({ limit: 2, windowMs: 1000 });
  limiter.allow('a', 0);
  limiter.allow('b', 0);
  limiter.allow('c', 900);
  assert.equal(limiter.size, 3);

  assert.equal(limiter.prune(1000), 2);
  assert.equal(limiter.size, 1);
  assert.equal(limiter.prune(1000), 0);

  assert.equal(limiter.prune(1900), 1);
  assert.equal(limiter.size, 0);
});

test('pruning does not change what is allowed', () => {
  const limiter = new RateLimiter({ limit: 1, windowMs: 1000 });
  limiter.allow('a', 0);
  limiter.prune(500);
  assert.equal(limiter.allow('a', 500), false);
});

test('a long burst never exceeds the limit in any window', () => {
  const limiter = new RateLimiter({ limit: 5, windowMs: 1000 });
  const accepted = [];
  for (let now = 0; now < 5000; now += 50) {
    if (limiter.allow('a', now)) accepted.push(now);
  }
  for (const at of accepted) {
    const inWindow = accepted.filter((other) => other > at - 1000 && other <= at);
    assert.ok(inWindow.length <= 5, `${inWindow.length} requests counted at ${at}`);
  }
  assert.ok(accepted.length >= 20, `expected the limiter to keep letting requests through, got ${accepted.length}`);
});
