import { test } from 'node:test';
import assert from 'node:assert/strict';

import { contains, intersect, isEmpty, overlaps } from '../src/ranges.js';

test('ranges that share a span overlap', () => {
  assert.equal(overlaps({ start: 0, end: 10 }, { start: 5, end: 15 }), true);
  assert.equal(overlaps({ start: 5, end: 15 }, { start: 0, end: 10 }), true);
});

test('ranges that are far apart do not overlap', () => {
  assert.equal(overlaps({ start: 0, end: 5 }, { start: 10, end: 15 }), false);
  assert.equal(overlaps({ start: 10, end: 15 }, { start: 0, end: 5 }), false);
});

test('a strict subrange is contained', () => {
  assert.equal(contains({ start: 0, end: 10 }, { start: 2, end: 8 }), true);
  assert.equal(contains({ start: 2, end: 8 }, { start: 0, end: 10 }), false);
});

test('intersect returns the shared span', () => {
  assert.deepEqual(intersect({ start: 0, end: 10 }, { start: 5, end: 15 }), { start: 5, end: 10 });
});

test('isEmpty recognizes a zero-width range', () => {
  assert.equal(isEmpty({ start: 5, end: 5 }), true);
  assert.equal(isEmpty({ start: 0, end: 5 }), false);
});
