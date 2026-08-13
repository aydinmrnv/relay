import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LruCache } from '../src/lru.js';

test('reading an entry saves it from the next eviction', () => {
  const cache = new LruCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a');
  cache.set('c', 3);

  assert.equal(cache.has('a'), true, 'a was just read');
  assert.equal(cache.has('b'), false, 'b is the least recently used');
  assert.equal(cache.has('c'), true);
});

test('overwriting a value refreshes it', () => {
  const cache = new LruCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('a', 11);
  cache.set('c', 3);

  assert.equal(cache.get('a'), 11);
  assert.equal(cache.has('b'), false);
});

test('has() does not count as a use', () => {
  const cache = new LruCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.has('a');
  cache.set('c', 3);

  assert.equal(cache.has('a'), false, 'asking about a key is not using it');
  assert.equal(cache.has('b'), true);
});

test('a miss changes nothing', () => {
  const cache = new LruCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('nope'), undefined);
  assert.deepEqual(cache.keys(), ['a', 'b']);
  assert.equal(cache.size, 2);
});

test('keys() reports use order, coldest first', () => {
  const cache = new LruCache(3);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  assert.deepEqual(cache.keys(), ['a', 'b', 'c']);

  cache.get('a');
  assert.deepEqual(cache.keys(), ['b', 'c', 'a']);

  cache.set('b', 22);
  assert.deepEqual(cache.keys(), ['c', 'a', 'b']);
});

test('exactly one entry is evicted per overflowing set', () => {
  const cache = new LruCache(3);
  for (const key of ['a', 'b', 'c', 'd', 'e']) cache.set(key, key);
  assert.equal(cache.size, 3);
  assert.deepEqual(cache.keys(), ['c', 'd', 'e']);
});

test('the size never exceeds max under a hot-key workload', () => {
  const cache = new LruCache(4);
  for (let index = 0; index < 100; index += 1) {
    cache.set(`k${index}`, index);
    cache.get('k0');
    assert.ok(cache.size <= 4, `size ${cache.size} exceeded max`);
  }
  assert.equal(cache.has('k0'), true, 'the key read on every iteration survives');
});

test('delete frees the slot the next set would have evicted into', () => {
  const cache = new LruCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.delete('a');
  cache.set('c', 3);
  assert.equal(cache.has('b'), true);
  assert.equal(cache.has('c'), true);
  assert.equal(cache.size, 2);
});
