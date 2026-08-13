import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';

test('reads a value out of the environment', () => {
  assert.deepEqual(loadConfig({ port: { env: 'PORT' } }, { PORT: '8080' }), { port: '8080' });
});

test('falls back to the default when the variable is absent', () => {
  assert.deepEqual(loadConfig({ port: { env: 'PORT', default: '3000' } }, {}), { port: '3000' });
});

test('an absent variable with no default is undefined', () => {
  assert.deepEqual(loadConfig({ port: { env: 'PORT' } }, {}), { port: undefined });
});

test('variables the schema does not name are ignored', () => {
  assert.deepEqual(loadConfig({ port: { env: 'PORT' } }, { PORT: '1', SECRET: 'x' }), { port: '1' });
});
