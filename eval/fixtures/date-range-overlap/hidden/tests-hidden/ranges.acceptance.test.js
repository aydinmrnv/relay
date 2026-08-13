import { test } from 'node:test';
import assert from 'node:assert/strict';

import { contains, intersect, overlaps } from '../src/ranges.js';

test('touching ranges do not overlap', () => {
  assert.equal(overlaps({ start: 0, end: 5 }, { start: 5, end: 10 }), false);
  assert.equal(overlaps({ start: 5, end: 10 }, { start: 0, end: 5 }), false);
});

test('identical ranges overlap', () => {
  assert.equal(overlaps({ start: 0, end: 10 }, { start: 0, end: 10 }), true);
});

test('a range overlapping by a single millisecond overlaps', () => {
  assert.equal(overlaps({ start: 0, end: 6 }, { start: 5, end: 10 }), true);
});

test('an empty range overlaps nothing, including itself', () => {
  assert.equal(overlaps({ start: 5, end: 5 }, { start: 0, end: 10 }), false);
  assert.equal(overlaps({ start: 0, end: 10 }, { start: 5, end: 5 }), false);
  assert.equal(overlaps({ start: 5, end: 5 }, { start: 5, end: 5 }), false);
});

test('containment is inclusive of identical bounds', () => {
  assert.equal(contains({ start: 0, end: 10 }, { start: 0, end: 10 }), true);
  assert.equal(contains({ start: 0, end: 10 }, { start: 0, end: 11 }), false);
  assert.equal(contains({ start: 0, end: 10 }, { start: -1, end: 10 }), false);
});

test('an empty range is contained by nothing', () => {
  assert.equal(contains({ start: 0, end: 10 }, { start: 5, end: 5 }), false);
  assert.equal(contains({ start: 5, end: 5 }, { start: 5, end: 5 }), false);
});

test('intersect returns null rather than a zero-width range', () => {
  assert.equal(intersect({ start: 0, end: 5 }, { start: 5, end: 10 }), null);
  assert.equal(intersect({ start: 5, end: 10 }, { start: 0, end: 5 }), null);
});

test('intersect returns null when either range is empty', () => {
  assert.equal(intersect({ start: 5, end: 5 }, { start: 0, end: 10 }), null);
  assert.equal(intersect({ start: 0, end: 10 }, { start: 7, end: 7 }), null);
});

test('intersect never returns an empty range', () => {
  const pairs = [
    [{ start: 0, end: 10 }, { start: 5, end: 15 }],
    [{ start: 0, end: 10 }, { start: 9, end: 10 }],
    [{ start: 0, end: 10 }, { start: 0, end: 1 }],
  ];
  for (const [a, b] of pairs) {
    const result = intersect(a, b);
    assert.notEqual(result, null);
    assert.ok(result.start < result.end, `${JSON.stringify(result)} is empty`);
  }
});

test('overlaps is symmetric across a spread of pairs', () => {
  const ranges = [
    { start: 0, end: 10 },
    { start: 10, end: 20 },
    { start: 5, end: 5 },
    { start: -5, end: 5 },
    { start: 3, end: 4 },
  ];
  for (const a of ranges) {
    for (const b of ranges) {
      assert.equal(overlaps(a, b), overlaps(b, a), `asymmetric for ${JSON.stringify([a, b])}`);
    }
  }
});
