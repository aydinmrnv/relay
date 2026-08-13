import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RULES, validate } from '../src/validate.js';

const valid = { name: 'Ada', email: 'ada@example.com' };
const ruleFor = (field, code) => RULES.find((rule) => rule.field === field && rule.code === code);

test('RULES is an ordered table with the declared shape', () => {
  assert.ok(Array.isArray(RULES));
  assert.equal(RULES.length, 7);
  for (const rule of RULES) {
    assert.equal(typeof rule.field, 'string');
    assert.equal(typeof rule.code, 'string');
    assert.equal(typeof rule.message, 'string');
    assert.equal(typeof rule.applies, 'function');
    assert.equal(typeof rule.test, 'function');
  }
  assert.deepEqual(
    RULES.map((rule) => `${rule.field}.${rule.code}`),
    [
      'name.required',
      'name.too_long',
      'email.invalid',
      'age.not_an_integer',
      'age.too_young',
      'age.too_old',
      'role.unknown',
    ],
  );
});

test('each rule can be called on its own', () => {
  assert.equal(ruleFor('name', 'required').test({ name: 'x' }), true);
  assert.equal(ruleFor('name', 'required').test({ name: '   ' }), false);
  assert.equal(ruleFor('name', 'too_long').test({ name: 'x'.repeat(40) }), true);
  assert.equal(ruleFor('name', 'too_long').test({ name: 'x'.repeat(41) }), false);
  assert.equal(ruleFor('email', 'invalid').test({ email: 'a@b' }), true);
  assert.equal(ruleFor('email', 'invalid').test({ email: 'ab' }), false);
  assert.equal(ruleFor('age', 'too_young').test({ age: 13 }), true);
  assert.equal(ruleFor('age', 'too_young').test({ age: 12 }), false);
  assert.equal(ruleFor('age', 'too_old').test({ age: 130 }), true);
  assert.equal(ruleFor('age', 'too_old').test({ age: 131 }), false);
  assert.equal(ruleFor('role', 'unknown').test({ role: 'viewer' }), true);
  assert.equal(ruleFor('role', 'unknown').test({ role: 'owner' }), false);
});

test('optional rules do not apply when the field is absent', () => {
  for (const code of ['not_an_integer', 'too_young', 'too_old']) {
    assert.equal(ruleFor('age', code).applies({}), false);
    assert.equal(ruleFor('age', code).applies({ age: 30 }), true);
  }
  assert.equal(ruleFor('role', 'unknown').applies({}), false);
  assert.equal(ruleFor('role', 'unknown').applies({ role: 'x' }), true);
});

test('a valid user still has no problems', () => {
  assert.deepEqual(validate(valid), []);
  assert.deepEqual(validate({ ...valid, age: 13, role: 'viewer' }), []);
  assert.deepEqual(validate({ ...valid, age: 130, role: 'editor', extra: 'ignored' }), []);
});

test('a field reports at most one problem', () => {
  assert.deepEqual(validate({ ...valid, name: undefined }), [
    { field: 'name', code: 'required', message: 'name is required' },
  ]);
  assert.deepEqual(validate({ ...valid, age: 1.5 }), [
    { field: 'age', code: 'not_an_integer', message: 'age must be a whole number' },
  ]);
});

test('problems come back in rule order', () => {
  const problems = validate({ name: '', email: 'nope', age: 200, role: 'owner' });
  assert.deepEqual(
    problems.map((problem) => `${problem.field}.${problem.code}`),
    ['name.required', 'email.invalid', 'age.too_old', 'role.unknown'],
  );
});

test('the boundaries are exactly where they were', () => {
  assert.deepEqual(validate({ ...valid, name: 'x'.repeat(40) }), []);
  assert.equal(validate({ ...valid, name: 'x'.repeat(41) })[0].code, 'too_long');
  assert.deepEqual(validate({ ...valid, name: `  ${'x'.repeat(40)}  ` }), []);
  assert.deepEqual(validate({ ...valid, age: 12 })[0].code, 'too_young');
  assert.deepEqual(validate({ ...valid, age: 131 })[0].code, 'too_old');
});

test('a non-string name is required rather than too long', () => {
  assert.deepEqual(validate({ ...valid, name: 42 }), [
    { field: 'name', code: 'required', message: 'name is required' },
  ]);
});

test('validate agrees with the table it walks', () => {
  const users = [
    valid,
    { ...valid, name: '' },
    { ...valid, email: 'nope' },
    { ...valid, age: 12 },
    { ...valid, age: 131 },
    { ...valid, age: '30' },
    { ...valid, role: 'owner' },
    { name: '', email: '', age: 0, role: '' },
  ];

  for (const user of users) {
    const expected = [];
    const seen = new Set();
    for (const rule of RULES) {
      if (seen.has(rule.field)) continue;
      if (!rule.applies(user) || rule.test(user)) continue;
      seen.add(rule.field);
      expected.push({ field: rule.field, code: rule.code, message: rule.message });
    }
    assert.deepEqual(validate(user), expected, `disagreed for ${JSON.stringify(user)}`);
  }
});
