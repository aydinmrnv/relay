import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReport, renderReport, summarize } from '../src/report.js';

const runs = [
  { name: 'lint', status: 'passed', durationMs: 300 },
  { name: 'build', status: 'passed', durationMs: 900 },
  { name: 'test', status: 'failed', durationMs: 300 },
];

test('summarize reports the numbers', () => {
  const summary = summarize(runs);
  assert.equal(summary.total, 3);
  assert.equal(summary.passed, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.totalMs, 1500);
  assert.ok(Math.abs(summary.passRate - (200 / 3)) < 1e-9);
});

test('slowest is the run itself, and ties go to the earliest', () => {
  const summary = summarize(runs);
  assert.equal(summary.slowest, runs[1]);

  const tied = [
    { name: 'first', status: 'passed', durationMs: 500 },
    { name: 'second', status: 'passed', durationMs: 500 },
  ];
  assert.equal(summarize(tied).slowest, tied[0]);
});

test('buildReport is renderReport of summarize', () => {
  for (const sample of [runs, [], [runs[0]], [...runs, { name: 'e2e', status: 'skipped', durationMs: 0 }]]) {
    assert.equal(buildReport(sample), renderReport(summarize(sample)), `disagreed for ${JSON.stringify(sample)}`);
  }
});

test('an empty run list renders rather than crashing', () => {
  const summary = summarize([]);
  assert.deepEqual(
    { total: summary.total, passed: summary.passed, failed: summary.failed, skipped: summary.skipped },
    { total: 0, passed: 0, failed: 0, skipped: 0 },
  );
  assert.equal(summary.passRate, null);
  assert.equal(summary.slowest, null);
  assert.equal(summary.totalMs, 0);

  assert.equal(
    buildReport([]),
    ['0 runs · 0 passed · 0 failed · 0 skipped', 'pass rate n/a', 'total 0.0s · slowest none'].join('\n'),
  );
});

test('a batch with nothing but skips has no pass rate', () => {
  const skips = [{ name: 'a', status: 'skipped', durationMs: 10 }];
  assert.equal(summarize(skips).passRate, null);
  assert.equal(buildReport(skips).split('\n')[1], 'pass rate n/a');
});

test('an unrecognized status counts as skipped', () => {
  const summary = summarize([{ name: 'a', status: 'errored', durationMs: 10 }]);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.passed, 0);
  assert.equal(summary.failed, 0);
});

test('the pass rate is rendered to one decimal place', () => {
  const third = [
    { name: 'a', status: 'passed', durationMs: 0 },
    { name: 'b', status: 'failed', durationMs: 0 },
    { name: 'c', status: 'failed', durationMs: 0 },
  ];
  assert.equal(buildReport(third).split('\n')[1], 'pass rate 33.3%');
});

test('the output for the sample batch is byte-identical to what it always was', () => {
  assert.equal(
    buildReport(runs),
    ['3 runs · 2 passed · 1 failed · 0 skipped', 'pass rate 66.7%', 'total 1.5s · slowest build (900ms)'].join('\n'),
  );
});

test('summarize does not touch its argument', () => {
  const input = runs.map((run) => ({ ...run }));
  const copy = JSON.parse(JSON.stringify(input));
  summarize(input);
  assert.deepEqual(input, copy);
});

test('renderReport works from a summary it was handed rather than from runs', () => {
  assert.equal(
    renderReport({
      total: 2,
      passed: 1,
      failed: 1,
      skipped: 0,
      passRate: 50,
      totalMs: 2000,
      slowest: { name: 'x', durationMs: 1500 },
    }),
    ['2 runs · 1 passed · 1 failed · 0 skipped', 'pass rate 50.0%', 'total 2.0s · slowest x (1500ms)'].join('\n'),
  );
});
