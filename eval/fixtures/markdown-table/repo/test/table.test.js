import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderTable } from '../src/table.js';

test('renders a header, a separator and one row per row', () => {
  assert.equal(
    renderTable(['a', 'b'], [['1', '2']]),
    ['| a   | b   |', '| --- | --- |', '| 1   | 2   |'].join('\n'),
  );
});

test('columns widen to their content', () => {
  assert.equal(
    renderTable(['name'], [['alexandra']]),
    ['| name      |', '| --------- |', '| alexandra |'].join('\n'),
  );
});

test('a table with no rows is still a table', () => {
  assert.equal(renderTable(['a'], []), ['| a   |', '| --- |'].join('\n'));
});

test('there is no trailing newline', () => {
  assert.equal(renderTable(['a'], [['1']]).endsWith('|'), true);
});
