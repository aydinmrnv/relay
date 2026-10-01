import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatDuration } from '../src/util/text.ts';

describe('formatDuration', () => {
  it('prints each scale in its own unit', () => {
    assert.equal(formatDuration(0), '0ms');
    assert.equal(formatDuration(412), '412ms');
    assert.equal(formatDuration(1_000), '1.0s');
    assert.equal(formatDuration(21_040), '21.0s');
    assert.equal(formatDuration(64_000), '1m 4s');
    assert.equal(formatDuration(482_000), '8m 2s');
    assert.equal(formatDuration(4_800_000), '1h 20m');
  });

  // The remainder is rounded, and a rounded remainder can reach the size of the
  // unit above it. Every boundary below once printed a number its own unit
  // cannot hold: `1000ms`, `60.0s`, `1m 60s`, `59m 60s`.
  it('carries a remainder that rounds up into the next unit', () => {
    assert.equal(formatDuration(999.6), '1.0s');
    assert.equal(formatDuration(59_949), '59.9s');
    assert.equal(formatDuration(59_950), '1m 0s');
    assert.equal(formatDuration(59_999), '1m 0s');
    assert.equal(formatDuration(119_600), '2m 0s');
    assert.equal(formatDuration(3_599_400), '59m 59s');
    assert.equal(formatDuration(3_599_600), '1h 0m');
  });

  it('never prints sixty of anything', () => {
    for (let ms = 0; ms < 2 * 60 * 60_000; ms += 137) {
      const text = formatDuration(ms);
      assert.doesNotMatch(text, /\b60(?:\.0)?[sm]\b/, `${ms}ms printed as ${text}`);
      assert.doesNotMatch(text, /^1000ms$/, `${ms}ms printed as ${text}`);
    }
  });
});
