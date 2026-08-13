import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pageNumbers, paginate } from '../src/pagination.js';

test('reports the page count for a partial last page', () => {
  const result = paginate({ total: 95, page: 5, perPage: 10 });
  assert.equal(result.pageCount, 10);
  assert.equal(result.total, 95);
  assert.equal(result.perPage, 10);
});

test('knows whether there is a page either side', () => {
  const middle = paginate({ total: 95, page: 5, perPage: 10 });
  assert.equal(middle.hasPrevious, true);
  assert.equal(middle.hasNext, true);

  const first = paginate({ total: 95, page: 1, perPage: 10 });
  assert.equal(first.hasPrevious, false);
});

test('rejects arguments that are not in range', () => {
  assert.throws(() => paginate({ total: 10, page: 0, perPage: 10 }), RangeError);
  assert.throws(() => paginate({ total: 10, page: 1, perPage: 0 }), RangeError);
  assert.throws(() => paginate({ total: -1, page: 1, perPage: 10 }), RangeError);
  assert.throws(() => paginate({ total: 10, page: 1, perPage: 2.5 }), RangeError);
});

test('draws a centred strip of page numbers in the middle', () => {
  assert.deepEqual(pageNumbers(5, 10), [3, 4, 5, 6, 7]);
});

test('draws every page when there are fewer than the window', () => {
  assert.deepEqual(pageNumbers(2, 3), [1, 2, 3]);
});
