import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NORMALIZERS, normalize, normalizeEmail, normalizeSlug, normalizeUsername } from '../src/normalize.js';

test('NORMALIZERS holds a step list for each kind', () => {
  assert.deepEqual(Object.keys(NORMALIZERS).sort(), ['email', 'slug', 'username']);
  for (const steps of Object.values(NORMALIZERS)) {
    assert.ok(Array.isArray(steps) && steps.length > 0);
    for (const step of steps) assert.equal(typeof step, 'function');
  }
});

test('normalize pipes a string through its steps', () => {
  assert.equal(normalize('  AB  ', [(text) => text.trim(), (text) => text.toLowerCase()]), 'ab');
  assert.equal(normalize('x', []), 'x');
});

test('normalize returns an empty string for anything that is not one', () => {
  assert.equal(normalize(null, NORMALIZERS.email), '');
  assert.equal(normalize(undefined, NORMALIZERS.slug), '');
  assert.equal(normalize(42, NORMALIZERS.username), '');
});

test('the three functions are their step lists', () => {
  const samples = ['  Ada@Example.COM ', 'Hello, World!', '_ada_', 'Ｈｅｌｌｏ', '', '   ', 'a  b'];
  for (const sample of samples) {
    assert.equal(normalizeEmail(sample), normalize(sample, NORMALIZERS.email), `email: ${sample}`);
    assert.equal(normalizeUsername(sample), normalize(sample, NORMALIZERS.username), `username: ${sample}`);
    assert.equal(normalizeSlug(sample), normalize(sample, NORMALIZERS.slug), `slug: ${sample}`);
  }
});

test('all three apply Unicode normalization first', () => {
  assert.equal(normalizeUsername('Ｈｅｌｌｏ'), 'hello');
  assert.equal(normalizeSlug('Ｈｅｌｌｏ Ｗｏｒｌｄ'), 'hello-world');
  assert.equal(normalizeEmail('ＡＤＡ@ｅｘａｍｐｌｅ.ＣＯＭ'), 'ada@example.com');
});

test('repeated separators collapse in both username and slug', () => {
  assert.equal(normalizeUsername('a__b'), 'a_b');
  assert.equal(normalizeUsername('a _ _ b'), 'a_b');
  assert.equal(normalizeSlug('a--b'), 'a-b');
  assert.equal(normalizeSlug('a - - b'), 'a-b');
});

test('separators are trimmed off the ends', () => {
  assert.equal(normalizeUsername('_ada_'), 'ada');
  assert.equal(normalizeUsername('!!ada!!'), 'ada');
  assert.equal(normalizeSlug('--hi--'), 'hi');
  assert.equal(normalizeSlug('!!hi!!'), 'hi');
});

test('a value made only of separators is empty', () => {
  assert.equal(normalizeUsername('___'), '');
  assert.equal(normalizeSlug('---'), '');
  assert.equal(normalizeSlug('!!!'), '');
});

test('the length limits are applied last', () => {
  assert.equal(normalizeUsername('a'.repeat(40)).length, 32);
  assert.equal(normalizeSlug('a'.repeat(70)).length, 60);
  // Cut mid-word, so the result may end on a separator; that is not trimmed again.
  assert.equal(normalizeSlug(`${'a'.repeat(59)} bbb`), `${'a'.repeat(59)}-`);
});

test('emails keep everything else', () => {
  assert.equal(normalizeEmail('Ada.Lovelace+tag@Example.com'), 'ada.lovelace+tag@example.com');
  assert.equal(normalizeEmail('a'.repeat(70)).length, 70);
});
