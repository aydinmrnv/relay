import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validate } from '../src/validate.js';

const valid = { name: 'Ada', email: 'ada@example.com' };

test('a valid user has no problems', () => {
  assert.deepEqual(validate(valid), []);
  assert.deepEqual(validate({ ...valid, age: 30, role: 'admin' }), []);
});

test('a missing name is reported', () => {
  assert.deepEqual(validate({ ...valid, name: '' }), [
    { field: 'name', code: 'required', message: 'name is required' },
  ]);
});

test('a bad email is reported', () => {
  assert.deepEqual(validate({ ...valid, email: 'nope' }), [
    { field: 'email', code: 'invalid', message: 'email must contain @' },
  ]);
});

test('an age below the minimum is reported', () => {
  assert.deepEqual(validate({ ...valid, age: 9 }), [
    { field: 'age', code: 'too_young', message: 'age must be at least 13' },
  ]);
});

test('an unknown role is reported', () => {
  assert.deepEqual(validate({ ...valid, role: 'owner' }), [
    { field: 'role', code: 'unknown', message: 'role must be admin, editor or viewer' },
  ]);
});
