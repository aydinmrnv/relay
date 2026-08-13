import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatQuery, parseQuery } from '../src/query.js';

test('values and keys are percent-decoded', () => {
  assert.deepEqual(parseQuery('a=%20b'), { a: ' b' });
  assert.deepEqual(parseQuery('a%20b=1'), { 'a b': '1' });
  assert.deepEqual(parseQuery('a=%26'), { a: '&' });
});

test('plus decodes to a space, and %2B to a plus', () => {
  assert.deepEqual(parseQuery('a=1+2'), { a: '1 2' });
  assert.deepEqual(parseQuery('a=1%2B2'), { a: '1+2' });
});

test('a malformed escape is left alone', () => {
  assert.deepEqual(parseQuery('a=%zz'), { a: '%zz' });
  assert.deepEqual(parseQuery('a=100%'), { a: '100%' });
});

test('a bare key has an empty value', () => {
  assert.deepEqual(parseQuery('a&b=1'), { a: '', b: '1' });
  assert.deepEqual(parseQuery('a='), { a: '' });
});

test('empty pairs and empty keys are skipped', () => {
  assert.deepEqual(parseQuery('a=1&&b=2'), { a: '1', b: '2' });
  assert.deepEqual(parseQuery('&a=1&'), { a: '1' });
  assert.deepEqual(parseQuery('=1&a=2'), { a: '2' });
});

test('a repeated key becomes an array in order', () => {
  assert.deepEqual(parseQuery('a=1&a=2'), { a: ['1', '2'] });
  assert.deepEqual(parseQuery('a=1&a=2&a=3'), { a: ['1', '2', '3'] });
  assert.deepEqual(parseQuery('a=1&b=x&a=2'), { a: ['1', '2'], b: 'x' });
});

test('a bracketed key is always an array', () => {
  assert.deepEqual(parseQuery('a[]=1'), { a: ['1'] });
  assert.deepEqual(parseQuery('a[]=1&a[]=2'), { a: ['1', '2'] });
});

test('dangerous keys never reach the result', () => {
  const result = parseQuery('__proto__=x&constructor=y&prototype=z&ok=1');
  assert.deepEqual(result, { ok: '1' });
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal({}.ok, undefined);
});

test('inherited property names do not collide with parsed keys', () => {
  assert.deepEqual(parseQuery('toString=1'), { toString: '1' });
  assert.deepEqual(parseQuery('toString=1&toString=2'), { toString: ['1', '2'] });
});

test('arrays format with the bracket marker', () => {
  assert.equal(formatQuery({ a: ['1', '2'] }), 'a[]=1&a[]=2');
  assert.equal(formatQuery({ a: ['1'] }), 'a[]=1');
});

test('keys and values are encoded on the way out', () => {
  assert.equal(formatQuery({ 'a b': 'c&d' }), 'a%20b=c%26d');
  assert.equal(formatQuery({ a: '1+2' }), 'a=1%2B2');
});

test('undefined is skipped and null is an empty value', () => {
  assert.equal(formatQuery({ a: undefined, b: '1' }), 'b=1');
  assert.equal(formatQuery({ a: null }), 'a=');
});

test('parse, format, parse is a fixed point', () => {
  const inputs = [
    '?a=1&b=2',
    'a=1&a=2&b=x',
    'a[]=1',
    'a%20b=c%26d&e=1+2',
    'flag&other=',
    '',
    'a=%zz',
  ];
  for (const input of inputs) {
    const once = parseQuery(input);
    assert.deepEqual(parseQuery(formatQuery(once)), once, `not a fixed point for ${input}`);
  }
});
