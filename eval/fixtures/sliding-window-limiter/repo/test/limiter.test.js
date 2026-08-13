import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RateLimiter } from '../src/limiter.js';

test('allows exactly the limit within one window', () => {
  const limiter = new RateLimiter({ limit: 3, windowMs: 1000 });
  assert.equal(limiter.allow('a', 0), true);
  assert.equal(limiter.allow('a', 0), true);
  assert.equal(limiter.allow('a', 0), true);
  assert.equal(limiter.allow('a', 0), false);
});

test('keys do not affect each other', () => {
  const limiter = new RateLimiter({ limit: 1, windowMs: 1000 });
  assert.equal(limiter.allow('a', 0), true);
  assert.equal(limiter.allow('b', 0), true);
  assert.equal(limiter.allow('a', 0), false);
  assert.equal(limiter.allow('b', 0), false);
});

test('a request is allowed again once the window has passed', () => {
  const limiter = new RateLimiter({ limit: 1, windowMs: 1000 });
  assert.equal(limiter.allow('a', 0), true);
  assert.equal(limiter.allow('a', 1000), true);
});

test('tracks one entry per key', () => {
  const limiter = new RateLimiter({ limit: 1, windowMs: 1000 });
  limiter.allow('a', 0);
  limiter.allow('b', 0);
  assert.equal(limiter.size, 2);
});

test('the constructor rejects nonsense', () => {
  assert.throws(() => new RateLimiter({ limit: 0, windowMs: 1000 }), RangeError);
  assert.throws(() => new RateLimiter({ limit: 1, windowMs: 0 }), RangeError);
  assert.throws(() => new RateLimiter({ limit: 1.5, windowMs: 1000 }), RangeError);
});
