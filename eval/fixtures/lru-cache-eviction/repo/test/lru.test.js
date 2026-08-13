import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LruCache } from '../src/lru.js';

test('stores and reads values', () => {
  const cache = new LruCache(3);
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('missing'), undefined);
  assert.equal(cache.size, 2);
});

test('drops the coldest entry when it would exceed max', () => {
  const cache = new LruCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  assert.equal(cache.size, 2);
  assert.equal(cache.has('a'), false);
  assert.equal(cache.has('c'), true);
});

test('delete frees a slot', () => {
  const cache = new LruCache(2);
  cache.set('a', 1);
  assert.equal(cache.delete('a'), true);
  assert.equal(cache.delete('a'), false);
  assert.equal(cache.size, 0);
});

test('the constructor rejects a max that is not a positive integer', () => {
  assert.throws(() => new LruCache(0), RangeError);
  assert.throws(() => new LruCache(-1), RangeError);
  assert.throws(() => new LruCache(1.5), RangeError);
});

test('clear empties the cache', () => {
  const cache = new LruCache(3);
  cache.set('a', 1);
  cache.clear();
  assert.equal(cache.size, 0);
});
