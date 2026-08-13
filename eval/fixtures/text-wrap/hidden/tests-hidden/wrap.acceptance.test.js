import { test } from 'node:test';
import assert from 'node:assert/strict';

import { wrap } from '../src/wrap.js';

test('existing line breaks are kept', () => {
  assert.deepEqual(wrap('a\nb', 10), ['a', 'b']);
  assert.deepEqual(wrap('a\r\nb', 10), ['a', 'b']);
  assert.deepEqual(wrap('a\rb', 10), ['a', 'b']);
});

test('a blank line stays blank', () => {
  assert.deepEqual(wrap('a\n\nb', 10), ['a', '', 'b']);
  assert.deepEqual(wrap('\n', 10), ['', '']);
});

test('runs of whitespace collapse', () => {
  assert.deepEqual(wrap('a   b', 10), ['a b']);
  assert.deepEqual(wrap('a\tb', 10), ['a b']);
  assert.deepEqual(wrap('  a  ', 10), ['a']);
});

test('empty input is one empty line', () => {
  assert.deepEqual(wrap('', 10), ['']);
  assert.deepEqual(wrap('   ', 10), ['']);
});

test('a word longer than the width is hard-broken', () => {
  assert.deepEqual(wrap('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(wrap('hi abcdefghij', 4), ['hi', 'abcd', 'efgh', 'ij']);
  assert.deepEqual(wrap('abcdefghij hi', 4), ['abcd', 'efgh', 'ij', 'hi']);
});

test('the indent prefixes every line and counts towards the width', () => {
  assert.deepEqual(wrap('aaa bbb', 8, { indent: '  ' }), ['  aaa', '  bbb']);
});

test('a hanging indent applies from the second line on', () => {
  assert.deepEqual(wrap('aaa bbb', 8, { indent: '- ', hangingIndent: '  ' }), ['- aaa', '  bbb']);
  assert.deepEqual(wrap('a\nb', 10, { indent: '- ', hangingIndent: '  ' }), ['- a', '- b']);
});

test('the width is validated', () => {
  assert.throws(() => wrap('a', 0), RangeError);
  assert.throws(() => wrap('a', -1), RangeError);
  assert.throws(() => wrap('a', 2.5), RangeError);
});

test('no line is ever longer than the width', () => {
  const text = [
    'The quick brown fox jumps over the lazy dog.',
    '',
    'https://example.com/a/very/long/path/that/will/not/fit/anywhere/at/all',
    'short',
  ].join('\n');

  for (const width of [1, 2, 5, 12, 40]) {
    for (const line of wrap(text, width)) {
      assert.ok(line.length <= width, `"${line}" is ${line.length} wide, limit ${width}`);
    }
    for (const line of wrap(text, width, { indent: '>> ' })) {
      assert.ok(line.length <= Math.max(width, 4), `"${line}" overflowed at width ${width} with an indent`);
    }
  }
});
