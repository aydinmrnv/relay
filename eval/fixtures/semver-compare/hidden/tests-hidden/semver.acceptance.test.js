import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compare, sort } from '../src/semver.js';

const before = (a, b) => {
  assert.ok(compare(a, b) < 0, `${a} should come before ${b}`);
  assert.ok(compare(b, a) > 0, `${b} should come after ${a}`);
};

test('a prerelease comes before its own release', () => {
  before('1.0.0-alpha', '1.0.0');
  before('2.3.4-rc.1', '2.3.4');
});

test('prerelease identifiers order left to right', () => {
  before('1.0.0-alpha', '1.0.0-alpha.1');
  before('1.0.0-alpha.1', '1.0.0-alpha.beta');
  before('1.0.0-alpha.beta', '1.0.0-beta');
  before('1.0.0-beta', '1.0.0-beta.2');
  before('1.0.0-beta.2', '1.0.0-beta.11');
  before('1.0.0-beta.11', '1.0.0-rc.1');
});

test('numeric identifiers compare numerically, not as text', () => {
  before('1.0.0-1', '1.0.0-2');
  before('1.0.0-2', '1.0.0-10');
  before('1.0.0-alpha.9', '1.0.0-alpha.10');
});

test('a numeric identifier has lower precedence than a non-numeric one', () => {
  before('1.0.0-1', '1.0.0-alpha');
  before('1.0.0-alpha.1', '1.0.0-alpha.beta');
});

test('more identifiers win when the shared ones are equal', () => {
  before('1.0.0-alpha', '1.0.0-alpha.1');
  before('1.0.0-alpha.1', '1.0.0-alpha.1.1');
});

test('numeric precedence still applies to the release triple', () => {
  before('1.9.0', '1.10.0');
  before('1.0.9', '1.0.10');
  before('9.0.0', '10.0.0');
});

test('build metadata is ignored entirely', () => {
  assert.equal(compare('1.0.0+build.1', '1.0.0+build.2'), 0);
  assert.equal(compare('1.0.0', '1.0.0+anything'), 0);
  assert.equal(compare('1.0.0-alpha+a', '1.0.0-alpha+b'), 0);
});

test('the spec ordering sorts as one list', () => {
  const ordered = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
    '1.0.1',
    '1.1.0',
    '2.0.0',
  ];
  const shuffled = [...ordered].reverse();
  assert.deepEqual(sort(shuffled), ordered);
});

test('sort still leaves its argument alone', () => {
  const input = ['1.0.0', '1.0.0-alpha'];
  sort(input);
  assert.deepEqual(input, ['1.0.0', '1.0.0-alpha']);
});
