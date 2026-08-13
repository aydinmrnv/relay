import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PathEscapeError, isInside, safeJoin } from '../src/paths.js';

test('joins segments under the root', () => {
  assert.equal(safeJoin('/srv/data', 'a', 'b'), '/srv/data/a/b');
  assert.equal(safeJoin('/srv/data', 'a/b.txt'), '/srv/data/a/b.txt');
});

test('normalizes redundant segments', () => {
  assert.equal(safeJoin('/srv/data', 'a/./b'), '/srv/data/a/b');
  assert.equal(safeJoin('/srv/data', 'a//b'), '/srv/data/a/b');
});

test('a path under the root is inside it', () => {
  assert.equal(isInside('/srv/data', '/srv/data/a/b'), true);
});

test('an unrelated path is not inside', () => {
  assert.equal(isInside('/srv/data', '/etc/passwd'), false);
});

test('PathEscapeError is an Error with its own name', () => {
  const error = new PathEscapeError('nope');
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'PathEscapeError');
});
