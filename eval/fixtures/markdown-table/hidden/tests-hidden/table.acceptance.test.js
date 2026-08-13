import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderTable } from '../src/table.js';

const lines = (table) => table.split('\n');

test('the separator row carries the alignment', () => {
  assert.equal(lines(renderTable([{ header: 'a', align: 'left' }], []))[1], '| :-- |');
  assert.equal(lines(renderTable([{ header: 'a', align: 'right' }], []))[1], '| --: |');
  assert.equal(lines(renderTable([{ header: 'a', align: 'center' }], []))[1], '| :-: |');
  assert.equal(lines(renderTable([{ header: 'a' }], []))[1], '| --- |');
  assert.equal(lines(renderTable(['a'], []))[1], '| --- |');
});

test('alignment markers fill a wider column', () => {
  assert.equal(lines(renderTable([{ header: 'abcdef', align: 'right' }], []))[1], '| -----: |');
  assert.equal(lines(renderTable([{ header: 'abcdef', align: 'center' }], []))[1], '| :----: |');
});

test('right-aligned content is padded on the left', () => {
  const table = renderTable([{ header: 'count', align: 'right' }], [['7'], ['1234']]);
  assert.deepEqual(lines(table), ['| count |', '| ----: |', '|     7 |', '|  1234 |']);
});

test('centred content splits the padding, extra space on the right', () => {
  const table = renderTable([{ header: 'abcdef', align: 'center' }], [['ab'], ['abc']]);
  assert.deepEqual(lines(table), ['| abcdef |', '| :----: |', '|   ab   |', '|  abc   |']);
});

test('a pipe in a cell is escaped and counted', () => {
  const table = renderTable(['a'], [['x|y']]);
  assert.deepEqual(lines(table), ['| a    |', '| ---- |', '| x\\|y |']);
});

test('a pipe in a header is escaped too', () => {
  assert.equal(lines(renderTable(['a|b'], []))[0], '| a\\|b |');
});

test('a line break becomes a break tag', () => {
  const table = renderTable(['a'], [['one\ntwo']]);
  assert.equal(lines(table)[2], '| one<br>two |');
});

test('null and undefined are empty cells', () => {
  const table = renderTable(['a', 'b'], [[null, undefined]]);
  assert.deepEqual(lines(table), ['| a   | b   |', '| --- | --- |', '|     |     |']);
});

test('numbers and booleans are stringified', () => {
  assert.equal(lines(renderTable(['a', 'b'], [[42, true]]))[2], '| 42  | true |');
});

test('a short row is padded with empty cells', () => {
  const table = renderTable(['a', 'b', 'c'], [['1']]);
  assert.deepEqual(lines(table), ['| a   | b   | c   |', '| --- | --- | --- |', '| 1   |     |     |']);
});

test('extra cells are dropped', () => {
  const table = renderTable(['a'], [['1', '2', '3']]);
  assert.deepEqual(lines(table), ['| a   |', '| --- |', '| 1   |']);
});

test('a table with no columns is empty', () => {
  assert.equal(renderTable([], []), '');
  assert.equal(renderTable([], [['ignored']]), '');
});

test('every row has the same number of cells', () => {
  const table = renderTable(['a', { header: 'b', align: 'right' }, 'c'], [['1'], ['x|y', '2', '3', '4'], []]);
  // Split on unescaped pipes only: `\|` is content, not a cell boundary.
  const counts = lines(table).map((line) => line.split(/(?<!\\)\|/).length);
  assert.equal(new Set(counts).size, 1, `ragged rows: ${JSON.stringify(lines(table))}`);
});
