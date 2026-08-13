import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pageNumbers, paginate } from '../src/pagination.js';

test('page 1 starts at offset 0', () => {
  const result = paginate({ total: 95, page: 1, perPage: 10 });
  assert.equal(result.offset, 0);
  assert.equal(result.limit, 10);
});

test('offset advances one page at a time', () => {
  assert.equal(paginate({ total: 95, page: 2, perPage: 10 }).offset, 10);
  assert.equal(paginate({ total: 95, page: 5, perPage: 10 }).offset, 40);
  assert.equal(paginate({ total: 95, page: 10, perPage: 10 }).offset, 90);
});

test('an exact multiple does not invent a trailing empty page', () => {
  const result = paginate({ total: 100, page: 10, perPage: 10 });
  assert.equal(result.pageCount, 10);
  assert.equal(result.hasNext, false);
  assert.equal(result.limit, 10);
});

test('the last page holds the remainder', () => {
  const result = paginate({ total: 95, page: 10, perPage: 10 });
  assert.equal(result.limit, 5);
  assert.equal(result.hasNext, false);
  assert.equal(result.hasPrevious, true);
});

test('an empty collection still has one empty page', () => {
  const result = paginate({ total: 0, page: 1, perPage: 10 });
  assert.equal(result.pageCount, 1);
  assert.equal(result.offset, 0);
  assert.equal(result.limit, 0);
  assert.equal(result.hasNext, false);
  assert.equal(result.hasPrevious, false);
});

test('a page beyond the end is clamped to the last one', () => {
  const result = paginate({ total: 95, page: 99, perPage: 10 });
  assert.equal(result.page, 10);
  assert.equal(result.offset, 90);
  assert.equal(result.hasNext, false);
});

test('a single short page is complete', () => {
  const result = paginate({ total: 3, page: 1, perPage: 10 });
  assert.equal(result.pageCount, 1);
  assert.equal(result.limit, 3);
  assert.equal(result.hasNext, false);
});

test('the last pages get a full strip of page numbers', () => {
  assert.deepEqual(pageNumbers(10, 10), [6, 7, 8, 9, 10]);
  assert.deepEqual(pageNumbers(9, 10), [6, 7, 8, 9, 10]);
});

test('the first pages get a full strip too', () => {
  assert.deepEqual(pageNumbers(1, 10), [1, 2, 3, 4, 5]);
  assert.deepEqual(pageNumbers(2, 10), [1, 2, 3, 4, 5]);
});

test('an even window puts the extra number after the current page', () => {
  assert.deepEqual(pageNumbers(5, 10, 4), [4, 5, 6, 7]);
  assert.deepEqual(pageNumbers(1, 10, 4), [1, 2, 3, 4]);
  assert.deepEqual(pageNumbers(10, 10, 4), [7, 8, 9, 10]);
});

test('the strip always contains the current page', () => {
  for (let pageCount = 1; pageCount <= 12; pageCount += 1) {
    for (let page = 1; page <= pageCount; page += 1) {
      const numbers = pageNumbers(page, pageCount);
      assert.ok(numbers.includes(page), `page ${page} of ${pageCount} missing from ${numbers}`);
      assert.equal(numbers.length, Math.min(5, pageCount));
      assert.ok(numbers[0] >= 1);
      assert.ok(numbers[numbers.length - 1] <= pageCount);
    }
  }
});
