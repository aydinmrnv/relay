import { test } from 'node:test';
import assert from 'node:assert/strict';

import { transition } from '../src/machine.js';

test('a draft is submitted for review', () => {
  assert.equal(transition('draft', 'submit'), 'review');
});

test('a review can approve or reject', () => {
  assert.equal(transition('review', 'approve'), 'approved');
  assert.equal(transition('review', 'reject'), 'draft');
});

test('an approved document is published and then archived', () => {
  assert.equal(transition('approved', 'publish'), 'published');
  assert.equal(transition('published', 'archive'), 'archived');
});

test('an illegal transition throws', () => {
  assert.throws(() => transition('draft', 'publish'), /cannot publish from draft/);
});
