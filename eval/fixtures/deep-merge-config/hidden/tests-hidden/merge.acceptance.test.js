import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deepMerge } from '../src/merge.js';

test('an undefined override is ignored', () => {
  assert.deepEqual(deepMerge({ a: 1 }, { a: undefined }), { a: 1 });
  assert.deepEqual(deepMerge({ a: { b: 1 } }, { a: undefined }), { a: { b: 1 } });
});

test('null replaces', () => {
  assert.deepEqual(deepMerge({ a: { b: 1 } }, { a: null }), { a: null });
  assert.deepEqual(deepMerge({ a: 1 }, { a: null }), { a: null });
});

test('the result shares no nested object with the base', () => {
  const base = { nested: { value: 1 } };
  const result = deepMerge(base, {});
  result.nested.value = 99;
  assert.equal(base.nested.value, 1);
});

test('the result shares no nested object with the override', () => {
  const override = { nested: { value: 1 } };
  const result = deepMerge({}, override);
  result.nested.value = 99;
  assert.equal(override.nested.value, 1);
});

test('arrays are copied, not aliased', () => {
  const override = { list: [1, 2] };
  const result = deepMerge({}, override);
  result.list.push(3);
  assert.deepEqual(override.list, [1, 2]);

  const base = { list: [1] };
  const kept = deepMerge(base, {});
  kept.list.push(2);
  assert.deepEqual(base.list, [1]);
});

test('objects inside arrays are copied too', () => {
  const override = { list: [{ a: 1 }] };
  const result = deepMerge({}, override);
  result.list[0].a = 99;
  assert.equal(override.list[0].a, 1);
});

test('neither input is mutated', () => {
  const base = { a: 1, nested: { b: 2 } };
  const override = { nested: { c: 3 } };
  deepMerge(base, override);
  assert.deepEqual(base, { a: 1, nested: { b: 2 } });
  assert.deepEqual(override, { nested: { c: 3 } });
});

test('__proto__ arriving through JSON does not reach the prototype', () => {
  const payload = JSON.parse('{"__proto__": {"polluted": true}}');
  const result = deepMerge({ a: 1 }, payload);

  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.hasOwn(result, '__proto__'), false);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(result, { a: 1 });
});

test('constructor and prototype keys are dropped at any depth', () => {
  const payload = JSON.parse('{"nested": {"constructor": {"x": 1}, "prototype": {"y": 2}, "keep": 3}}');
  const result = deepMerge({}, payload);
  assert.deepEqual(result, { nested: { keep: 3 } });
});

test('values that are neither plain objects nor arrays are carried across', () => {
  const when = new Date(1000);
  const result = deepMerge({ at: new Date(0) }, { at: when });
  assert.equal(result.at.getTime(), 1000);
  assert.ok(result.at instanceof Date);
});

test('base keys keep their order and override keys follow', () => {
  const result = deepMerge({ a: 1, b: 2 }, { c: 3, a: 9 });
  assert.deepEqual(Object.keys(result), ['a', 'b', 'c']);
  assert.equal(result.a, 9);
});
