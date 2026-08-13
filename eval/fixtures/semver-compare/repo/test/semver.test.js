import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compare, parse, sort } from '../src/semver.js';

test('parse splits a plain version', () => {
  assert.deepEqual(parse('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: '', build: '' });
});

test('parse rejects nonsense', () => {
  assert.throws(() => parse('nope'), TypeError);
  assert.throws(() => parse('1.2'), TypeError);
});

test('released versions order by major, minor, then patch', () => {
  assert.ok(compare('1.2.3', '1.3.0') < 0);
  assert.ok(compare('2.0.0', '1.9.9') > 0);
  assert.equal(compare('1.0.0', '1.0.0'), 0);
});

test('sort returns a new array, oldest first', () => {
  const input = ['1.2.0', '1.0.0', '1.1.0'];
  assert.deepEqual(sort(input), ['1.0.0', '1.1.0', '1.2.0']);
  assert.deepEqual(input, ['1.2.0', '1.0.0', '1.1.0']);
});
