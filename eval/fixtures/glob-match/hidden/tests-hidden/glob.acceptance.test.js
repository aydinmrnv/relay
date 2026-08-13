import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matches, matchesAny } from '../src/glob.js';

test('a single star does not cross a separator', () => {
  assert.equal(matches('src/*.js', 'src/nested/app.js'), false);
  assert.equal(matches('*', 'a/b'), false);
  assert.equal(matches('*/*', 'a/b'), true);
  assert.equal(matches('*/*', 'a/b/c'), false);
});

test('a double star crosses separators', () => {
  assert.equal(matches('src/**', 'src/a/b/app.js'), true);
  assert.equal(matches('src/**/*.js', 'src/a/b/app.js'), true);
  assert.equal(matches('src/**/*.js', 'src/app.js'), true);
});

test('a double-star segment can match nothing', () => {
  assert.equal(matches('a/**/b', 'a/b'), true);
  assert.equal(matches('a/**/b', 'a/x/b'), true);
  assert.equal(matches('a/**/b', 'a/x/y/b'), true);
  assert.equal(matches('**/*.js', 'app.js'), true);
  assert.equal(matches('**/*.js', 'src/a/app.js'), true);
});

test('a question mark is exactly one non-separator character', () => {
  assert.equal(matches('a?c', 'abc'), true);
  assert.equal(matches('a?c', 'ac'), false);
  assert.equal(matches('a?c', 'abbc'), false);
  assert.equal(matches('a?c', 'a/c'), false);
});

test('character classes match one listed character', () => {
  assert.equal(matches('[abc].js', 'a.js'), true);
  assert.equal(matches('[abc].js', 'd.js'), false);
  assert.equal(matches('[a-c]x', 'bx'), true);
  assert.equal(matches('[a-c]x', 'dx'), false);
});

test('a leading bang or caret negates a class', () => {
  assert.equal(matches('[!a]x', 'bx'), true);
  assert.equal(matches('[!a]x', 'ax'), false);
  assert.equal(matches('[^a]x', 'bx'), true);
});

test('an unclosed bracket is a literal bracket', () => {
  assert.equal(matches('a[b', 'a[b'), true);
});

test('metacharacters are literal', () => {
  assert.equal(matches('a+b', 'a+b'), true);
  assert.equal(matches('a+b', 'ab'), false);
  assert.equal(matches('a(b)', 'a(b)'), true);
  assert.equal(matches('a$b', 'a$b'), true);
});

test('matching is anchored at both ends', () => {
  assert.equal(matches('abc', 'xabcx'), false);
  assert.equal(matches('abc', 'abcx'), false);
  assert.equal(matches('*.js', 'app.js.map'), false);
});

test('matchesAny needs one inclusion', () => {
  assert.equal(matchesAny(['*.js'], 'app.js'), true);
  assert.equal(matchesAny(['*.ts'], 'app.js'), false);
  assert.equal(matchesAny([], 'app.js'), false);
});

test('an exclusion wins wherever it appears', () => {
  const patterns = ['**/*.js', '!**/vendor/**'];
  assert.equal(matchesAny(patterns, 'src/app.js'), true);
  assert.equal(matchesAny(patterns, 'src/vendor/a.js'), false);
  assert.equal(matchesAny([...patterns].reverse(), 'src/vendor/a.js'), false);
});

test('a list of only exclusions matches nothing', () => {
  assert.equal(matchesAny(['!*.js'], 'app.ts'), false);
  assert.equal(matchesAny(['!*.js'], 'app.js'), false);
});
