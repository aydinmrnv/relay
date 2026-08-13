import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatQuery, parseQuery } from '../src/query.js';

test('parses a plain pair list', () => {
  assert.deepEqual(parseQuery('a=1&b=2'), { a: '1', b: '2' });
});

test('strips a leading question mark', () => {
  assert.deepEqual(parseQuery('?a=1'), { a: '1' });
});

test('an empty query is an empty object', () => {
  assert.deepEqual(parseQuery(''), {});
});

test('formats a plain object', () => {
  assert.equal(formatQuery({ a: '1', b: '2' }), 'a=1&b=2');
});

test('an empty object formats to an empty string', () => {
  assert.equal(formatQuery({}), '');
});
