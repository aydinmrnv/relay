import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReport } from '../src/report.js';

const runs = [
  { name: 'lint', status: 'passed', durationMs: 300 },
  { name: 'build', status: 'passed', durationMs: 900 },
  { name: 'test', status: 'failed', durationMs: 300 },
];

test('renders the three lines', () => {
  assert.equal(
    buildReport(runs),
    [
      '3 runs · 2 passed · 1 failed · 0 skipped',
      'pass rate 66.7%',
      'total 1.5s · slowest build (900ms)',
    ].join('\n'),
  );
});

test('renders a single passing run', () => {
  assert.equal(
    buildReport([{ name: 'only', status: 'passed', durationMs: 100 }]),
    ['1 runs · 1 passed · 0 failed · 0 skipped', 'pass rate 100.0%', 'total 0.1s · slowest only (100ms)'].join('\n'),
  );
});

test('counts skipped runs separately', () => {
  const line = buildReport([...runs, { name: 'e2e', status: 'skipped', durationMs: 0 }]).split('\n')[0];
  assert.equal(line, '4 runs · 2 passed · 1 failed · 1 skipped');
});
