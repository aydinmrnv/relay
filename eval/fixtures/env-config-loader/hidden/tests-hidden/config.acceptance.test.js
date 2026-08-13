import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigError, loadConfig } from '../src/config.js';

test('numbers and integers are coerced', () => {
  assert.deepEqual(loadConfig({ port: { env: 'PORT', type: 'integer' } }, { PORT: '8080' }), { port: 8080 });
  assert.deepEqual(loadConfig({ ratio: { env: 'RATIO', type: 'number' } }, { RATIO: '0.25' }), { ratio: 0.25 });
});

test('booleans understand the usual spellings', () => {
  const schema = { debug: { env: 'DEBUG', type: 'boolean' } };
  for (const raw of ['1', 'true', 'TRUE', 'yes', 'On']) {
    assert.deepEqual(loadConfig(schema, { DEBUG: raw }), { debug: true }, raw);
  }
  for (const raw of ['0', 'false', 'FALSE', 'no', 'Off']) {
    assert.deepEqual(loadConfig(schema, { DEBUG: raw }), { debug: false }, raw);
  }
});

test('lists are split and trimmed', () => {
  assert.deepEqual(loadConfig({ hosts: { env: 'HOSTS', type: 'list' } }, { HOSTS: 'a, b ,,c ' }), {
    hosts: ['a', 'b', 'c'],
  });
  assert.deepEqual(loadConfig({ hosts: { env: 'HOSTS', type: 'list' } }, { HOSTS: 'a' }), { hosts: ['a'] });
});

test('values are trimmed, and a blank value counts as absent', () => {
  assert.deepEqual(loadConfig({ port: { env: 'PORT' } }, { PORT: '  8080  ' }), { port: '8080' });
  assert.deepEqual(loadConfig({ port: { env: 'PORT', default: '3000' } }, { PORT: '   ' }), { port: '3000' });
});

test('a default is used as it is, without coercion', () => {
  assert.deepEqual(loadConfig({ port: { env: 'PORT', type: 'integer', default: 3000 } }, {}), { port: 3000 });
  assert.deepEqual(
    loadConfig({ mode: { env: 'MODE', values: ['a', 'b'], default: 'anything' } }, {}),
    { mode: 'anything' },
  );
});

test('a missing required variable is a problem', () => {
  assert.throws(
    () => loadConfig({ token: { env: 'TOKEN', required: true } }, {}),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.name, 'ConfigError');
      assert.deepEqual(error.problems, ['token: TOKEN is required']);
      return true;
    },
  );
});

test('coercion failures name the type and the value', () => {
  assert.throws(
    () => loadConfig({ port: { env: 'PORT', type: 'integer' } }, { PORT: '80.5' }),
    (error) => {
      assert.deepEqual(error.problems, ['port: PORT must be an integer, got "80.5"']);
      return true;
    },
  );
  assert.throws(
    () => loadConfig({ ratio: { env: 'RATIO', type: 'number' } }, { RATIO: 'x' }),
    (error) => {
      assert.deepEqual(error.problems, ['ratio: RATIO must be a number, got "x"']);
      return true;
    },
  );
  assert.throws(
    () => loadConfig({ debug: { env: 'DEBUG', type: 'boolean' } }, { DEBUG: 'maybe' }),
    (error) => {
      assert.deepEqual(error.problems, ['debug: DEBUG must be a boolean, got "maybe"']);
      return true;
    },
  );
});

test('an unknown type is a problem rather than a crash', () => {
  assert.throws(
    () => loadConfig({ x: { env: 'X', type: 'colour' } }, { X: 'red' }),
    (error) => {
      assert.deepEqual(error.problems, ['x: unknown type "colour"']);
      return true;
    },
  );
});

test('the allowed set is checked after coercion', () => {
  assert.deepEqual(loadConfig({ mode: { env: 'MODE', values: ['dev', 'prod'] } }, { MODE: 'dev' }), { mode: 'dev' });
  assert.deepEqual(loadConfig({ n: { env: 'N', type: 'integer', values: [1, 2] } }, { N: '2' }), { n: 2 });

  assert.throws(
    () => loadConfig({ mode: { env: 'MODE', values: ['dev', 'prod'] } }, { MODE: 'staging' }),
    (error) => {
      assert.deepEqual(error.problems, ['mode: MODE must be one of dev, prod, got "staging"']);
      return true;
    },
  );
});

test('every element of a list is checked against the allowed set', () => {
  assert.throws(
    () => loadConfig({ hosts: { env: 'HOSTS', type: 'list', values: ['a', 'b'] } }, { HOSTS: 'a,c,d' }),
    (error) => {
      assert.deepEqual(error.problems, ['hosts: HOSTS must be one of a, b, got "c, d"']);
      return true;
    },
  );
});

test('every problem is reported at once, in schema order', () => {
  assert.throws(
    () =>
      loadConfig(
        {
          port: { env: 'PORT', type: 'integer' },
          token: { env: 'TOKEN', required: true },
          debug: { env: 'DEBUG', type: 'boolean' },
        },
        { PORT: 'x', DEBUG: 'maybe' },
      ),
    (error) => {
      assert.deepEqual(error.problems, [
        'port: PORT must be an integer, got "x"',
        'token: TOKEN is required',
        'debug: DEBUG must be a boolean, got "maybe"',
      ]);
      assert.ok(error.message.startsWith('invalid configuration:'));
      for (const problem of error.problems) assert.ok(error.message.includes(`\n  - ${problem}`), problem);
      return true;
    },
  );
});

test('a valid configuration throws nothing', () => {
  assert.deepEqual(
    loadConfig(
      {
        port: { env: 'PORT', type: 'integer', default: 3000 },
        debug: { env: 'DEBUG', type: 'boolean', default: false },
        hosts: { env: 'HOSTS', type: 'list' },
        mode: { env: 'MODE', values: ['dev', 'prod'] },
      },
      { PORT: '8080', HOSTS: 'a,b', MODE: 'prod', UNRELATED: 'x' },
    ),
    { port: 8080, debug: false, hosts: ['a', 'b'], mode: 'prod' },
  );
});
