import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PathEscapeError, isInside, safeJoin } from '../src/paths.js';

test('traversal out of the root throws', () => {
  assert.throws(() => safeJoin('/srv/data', '..'), PathEscapeError);
  assert.throws(() => safeJoin('/srv/data', '../etc/passwd'), PathEscapeError);
  assert.throws(() => safeJoin('/srv/data', 'a', '../../etc/passwd'), PathEscapeError);
  assert.throws(() => safeJoin('/srv/data', 'a/../../..'), PathEscapeError);
});

test('traversal that stays inside is fine', () => {
  assert.equal(safeJoin('/srv/data', 'a/../b'), '/srv/data/b');
  assert.equal(safeJoin('/srv/data', 'a', '..', 'b'), '/srv/data/b');
  assert.equal(safeJoin('/srv/data', 'a/b/../c'), '/srv/data/a/c');
});

test('an absolute segment is refused rather than reinterpreted', () => {
  assert.throws(() => safeJoin('/srv/data', '/etc/passwd'), PathEscapeError);
  assert.throws(() => safeJoin('/srv/data', 'a', '/etc'), PathEscapeError);
});

test('empty and dot segments are ignored', () => {
  assert.equal(safeJoin('/srv/data', '', '.', 'a'), '/srv/data/a');
  assert.equal(safeJoin('/srv/data'), '/srv/data');
  assert.equal(safeJoin('/srv/data', '.'), '/srv/data');
});

test('a trailing slash on the root changes nothing', () => {
  assert.equal(safeJoin('/srv/data/', 'a'), '/srv/data/a');
  assert.equal(safeJoin('/srv/data/'), '/srv/data');
  assert.throws(() => safeJoin('/srv/data/', '../x'), PathEscapeError);
});

test('the result never carries a trailing slash', () => {
  assert.equal(safeJoin('/srv/data', 'a/'), '/srv/data/a');
  assert.equal(safeJoin('/srv/data', 'a/b/'), '/srv/data/a/b');
});

test('a sibling whose name starts with the root is not inside it', () => {
  assert.equal(isInside('/srv/data', '/srv/data-old/secrets'), false);
  assert.equal(isInside('/srv/data', '/srv/database'), false);
});

test('the root is inside itself', () => {
  assert.equal(isInside('/srv/data', '/srv/data'), true);
  assert.equal(isInside('/srv/data/', '/srv/data'), true);
  assert.equal(isInside('/srv/data', '/srv/data/'), true);
});

test('a parent is not inside its child', () => {
  assert.equal(isInside('/srv/data', '/srv'), false);
  assert.equal(isInside('/srv/data', '/'), false);
});

test('everything is inside the filesystem root', () => {
  assert.equal(isInside('/', '/srv/data'), true);
  assert.equal(isInside('/', '/'), true);
});
