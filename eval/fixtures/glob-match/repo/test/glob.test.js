import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matches } from '../src/glob.js';

test('a star matches within a segment', () => {
  assert.equal(matches('*.js', 'app.js'), true);
  assert.equal(matches('*.js', 'app.ts'), false);
  assert.equal(matches('src/*.js', 'src/app.js'), true);
});

test('a literal pattern matches only itself', () => {
  assert.equal(matches('src/app.js', 'src/app.js'), true);
  assert.equal(matches('src/app.js', 'src/other.js'), false);
});

test('a dot in the pattern is a dot, not any character', () => {
  assert.equal(matches('a.b', 'axb'), false);
  assert.equal(matches('a.b', 'a.b'), true);
});

test('a star can match nothing', () => {
  assert.equal(matches('a*b', 'ab'), true);
});
