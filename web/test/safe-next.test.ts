import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeNext } from '@/lib/safe-next';

const FALLBACK = '/dashboard';

test('a same-site path is kept, with its query and hash', () => {
  assert.equal(safeNext('/workflows/wf_1?tab=runs#top', FALLBACK), '/workflows/wf_1?tab=runs#top');
  assert.equal(safeNext('/connect', FALLBACK), '/connect');
});

test('another site is refused, however it is spelled', () => {
  for (const value of ['https://example.com/login', '//example.com/login', '/\\example.com', '/\t/example.com', 'javascript:alert(1)', 'dashboard']) {
    assert.equal(safeNext(value, FALLBACK), FALLBACK, value);
  }
});

// Dot segments are removed when the path is resolved, so these pass a check
// on the input and come out as `//example.com/login`: another site.
test('a path that only becomes protocol-relative once resolved is refused', () => {
  for (const value of ['/.//example.com/login', '/..//example.com/login', '/a/..//example.com/login']) {
    assert.equal(safeNext(value, FALLBACK), FALLBACK, value);
  }
});

test('nothing, or something absurdly long, falls back', () => {
  assert.equal(safeNext(null, FALLBACK), FALLBACK);
  assert.equal(safeNext(undefined, FALLBACK), FALLBACK);
  assert.equal(safeNext('', FALLBACK), FALLBACK);
  assert.equal(safeNext(`/${'a'.repeat(3000)}`, FALLBACK), FALLBACK);
});
