import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatDuration, parseDuration } from '../src/duration.js';

test('zero is zero milliseconds', () => {
  assert.equal(formatDuration(0), '0ms');
});

test('sub-second durations show milliseconds', () => {
  assert.equal(formatDuration(1), '1ms');
  assert.equal(formatDuration(999), '999ms');
  assert.equal(formatDuration(1000), '1s');
});

test('components are truncated, never rounded up', () => {
  assert.equal(formatDuration(1999, { units: 1 }), '1s');
  assert.equal(formatDuration(1999, { units: 2 }), '1s 999ms');
  assert.equal(formatDuration(59999, { units: 1 }), '59s');
});

test('hours and days are units too', () => {
  assert.equal(formatDuration(3600000, { units: 1 }), '1h');
  assert.equal(formatDuration(86400000, { units: 1 }), '1d');
  assert.equal(formatDuration(90061000, { units: 2 }), '1d 1h');
  assert.equal(formatDuration(90061000, { units: 3 }), '1d 1h 1m');
});

test('a zero component in the middle is skipped without using a slot', () => {
  assert.equal(formatDuration(3605000, { units: 2 }), '1h 5s');
  assert.equal(formatDuration(86400000 + 1000, { units: 2 }), '1d 1s');
});

test('negatives are formatted by magnitude with a sign', () => {
  assert.equal(formatDuration(-65000), '-1m 5s');
  assert.equal(formatDuration(-1), '-1ms');
});

test('a value that is not a finite number throws', () => {
  assert.throws(() => formatDuration(Number.NaN), TypeError);
  assert.throws(() => formatDuration(Number.POSITIVE_INFINITY), TypeError);
  assert.throws(() => formatDuration('5000'), TypeError);
});

test('parseDuration reads components', () => {
  assert.equal(parseDuration('1h 30m'), 5400000);
  assert.equal(parseDuration('1d'), 86400000);
  assert.equal(parseDuration('250ms'), 250);
  assert.equal(parseDuration('1s 999ms'), 1999);
});

test('parseDuration tolerates whitespace and bare numbers', () => {
  assert.equal(parseDuration('  2m 3s  '), 123000);
  assert.equal(parseDuration('2 m'), 120000);
  assert.equal(parseDuration('1500'), 1500);
  assert.equal(parseDuration('-1m 5s'), -65000);
  assert.equal(parseDuration(1500), 1500);
});

test('parseDuration rejects what it cannot read', () => {
  assert.throws(() => parseDuration(''), TypeError);
  assert.throws(() => parseDuration('   '), TypeError);
  assert.throws(() => parseDuration('soon'), TypeError);
  assert.throws(() => parseDuration('1x'), TypeError);
  assert.throws(() => parseDuration('1h x'), TypeError);
  assert.throws(() => parseDuration(null), TypeError);
});

test('formatting then parsing round trips', () => {
  const values = [0, 1, 999, 1000, 1999, 61000, 3605000, 90061000, -65000, 86399999];
  for (const value of values) {
    assert.equal(parseDuration(formatDuration(value, { units: 5 })), Math.trunc(value), `round trip failed for ${value}`);
  }
});
