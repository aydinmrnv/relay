import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatCsv, formatRow, formatValue, parseCsv } from '../src/csv.js';

test('a field containing a double quote is quoted and its quotes doubled', () => {
  assert.equal(formatValue('He said "no"'), '"He said ""no"""');
  assert.equal(formatValue('"'), '""""');
});

test('a field containing a line feed is quoted', () => {
  assert.equal(formatValue('line1\nline2'), '"line1\nline2"');
});

test('a field containing a carriage return is quoted', () => {
  assert.equal(formatValue('a\rb'), '"a\rb"');
  assert.equal(formatValue('a\r\nb'), '"a\r\nb"');
});

test('significant whitespace is preserved by quoting', () => {
  assert.equal(formatValue(' a'), '" a"');
  assert.equal(formatValue('a '), '"a "');
  assert.equal(formatValue('  '), '"  "');
});

test('bare fields stay bare', () => {
  assert.equal(formatValue('abc'), 'abc');
  assert.equal(formatValue(''), '');
  assert.equal(formatValue(null), '');
  assert.equal(formatValue(undefined), '');
  assert.equal(formatValue(0), '0');
});

test('rows are joined with CRLF and there is no trailing break', () => {
  assert.equal(formatCsv([['a'], ['b']]), 'a\r\nb');
  assert.equal(formatCsv([['a', 'b'], ['c', 'd']]), 'a,b\r\nc,d');
});

test('a field with both a comma and a quote is handled once, not twice', () => {
  assert.equal(formatRow(['a,"b"', 'c']), '"a,""b""",c');
});

test('every value survives a write-then-read round trip', () => {
  const rows = [
    ['plain', 'with,comma', 'with"quote'],
    ['line\nbreak', 'crlf\r\nbreak', ' padded '],
    ['', 'trailing"', '"leading'],
    ['a""b', ',', '\n'],
  ];

  assert.deepEqual(parseCsv(formatCsv(rows)), rows);
});

test('non-strings round trip as their string form', () => {
  assert.deepEqual(parseCsv(formatCsv([[1, 2.5, true, null, undefined]])), [['1', '2.5', 'true', '', '']]);
});
