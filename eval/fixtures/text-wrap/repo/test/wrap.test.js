import { test } from 'node:test';
import assert from 'node:assert/strict';

import { wrap } from '../src/wrap.js';

test('text that fits stays on one line', () => {
  assert.deepEqual(wrap('a b c', 5), ['a b c']);
  assert.deepEqual(wrap('one two three', 20), ['one two three']);
  assert.deepEqual(wrap('hello', 10), ['hello']);
});

test('text that does not fit breaks between words', () => {
  assert.deepEqual(wrap('aaa bbb ccc', 7), ['aaa bbb', 'ccc']);
});

test('breaking happens at the last word that fits', () => {
  assert.deepEqual(wrap('one two three four', 9), ['one two', 'three', 'four']);
});
