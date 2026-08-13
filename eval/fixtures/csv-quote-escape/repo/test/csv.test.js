import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatCsv, formatRow, formatValue, parseCsv } from '../src/csv.js';

test('plain fields are written bare', () => {
  assert.equal(formatRow(['a', 'b', 'c']), 'a,b,c');
});

test('a field containing a comma is quoted', () => {
  assert.equal(formatRow(['a,b', 'c']), '"a,b",c');
});

test('null and undefined become empty fields', () => {
  assert.equal(formatRow([null, undefined, '']), ',,');
});

test('a single row needs no separator', () => {
  assert.equal(formatCsv([['a', 'b']]), 'a,b');
});

test('numbers are written as their string form', () => {
  assert.equal(formatValue(42), '42');
});

test('the reader handles quoted fields and CRLF rows', () => {
  assert.deepEqual(parseCsv('a,b\r\nc,d'), [
    ['a', 'b'],
    ['c', 'd'],
  ]);
  assert.deepEqual(parseCsv('"a,b",c'), [['a,b', 'c']]);
  assert.deepEqual(parseCsv('"he said ""hi""",c'), [['he said "hi"', 'c']]);
});
