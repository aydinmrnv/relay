import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeEmail, normalizeSlug, normalizeUsername } from '../src/normalize.js';

test('emails are trimmed and lowercased', () => {
  assert.equal(normalizeEmail('  Ada@Example.COM '), 'ada@example.com');
});

test('usernames become underscore-separated', () => {
  assert.equal(normalizeUsername(' Ada Lovelace '), 'ada_lovelace');
  assert.equal(normalizeUsername('Ada!'), 'ada');
});

test('slugs become hyphen-separated', () => {
  assert.equal(normalizeSlug(' Hello World '), 'hello-world');
  assert.equal(normalizeSlug('Hello, World!'), 'hello-world');
});

test('a non-string is empty', () => {
  for (const normalize of [normalizeEmail, normalizeUsername, normalizeSlug]) {
    assert.equal(normalize(null), '');
    assert.equal(normalize(undefined), '');
    assert.equal(normalize(42), '');
  }
});
