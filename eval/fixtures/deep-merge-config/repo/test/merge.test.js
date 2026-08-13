import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deepMerge, isPlainObject } from '../src/merge.js';

test('nested objects merge key by key', () => {
  assert.deepEqual(deepMerge({ a: 1, b: { c: 2 } }, { b: { d: 3 } }), { a: 1, b: { c: 2, d: 3 } });
});

test('primitives are replaced', () => {
  assert.deepEqual(deepMerge({ a: 1 }, { a: 2 }), { a: 2 });
});

test('arrays replace rather than concatenate', () => {
  assert.deepEqual(deepMerge({ a: [1, 2] }, { a: [3] }), { a: [3] });
});

test('new keys are added', () => {
  assert.deepEqual(deepMerge({ a: 1 }, { b: 2 }), { a: 1, b: 2 });
});

test('isPlainObject knows what a plain object is', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(new Date()), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject('x'), false);
});
