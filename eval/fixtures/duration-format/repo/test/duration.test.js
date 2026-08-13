import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatDuration } from '../src/duration.js';

test('formats whole seconds', () => {
  assert.equal(formatDuration(5000), '5s');
});

test('formats minutes and seconds', () => {
  assert.equal(formatDuration(65000), '1m 5s');
  assert.equal(formatDuration(90000), '1m 30s');
});

test('formats the last minute before an hour', () => {
  assert.equal(formatDuration(3599000), '59m 59s');
});
