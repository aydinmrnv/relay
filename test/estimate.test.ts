import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { confirmEstimate, printEstimate } from '../src/cli/commands/run.ts';
import { setTheme } from '../src/cli/output.ts';
import { DEFAULT_CONFIG, type RelayConfig } from '../src/storage/config.ts';
import { createRunId, shortId } from '../src/util/ids.ts';
import { estimateRun, exceedsThreshold, plannedPhases } from '../src/workflow/estimate.ts';
import type { Phase } from '../src/workflow/phases.ts';
import { createRunState, type RunState } from '../src/workflow/state.ts';
import { recordTurnUsage } from '../src/workflow/usage.ts';
import { ScriptedPrompter } from './helpers/scriptedPrompter.ts';

const MINUTE = 60_000;

/** A full run's phases, with the minutes each one took. */
const FULL: Array<[Phase, number]> = [
  ['INITIALIZING', 0],
  ['FETCHING_ISSUE', 1],
  ['CREATING_WORKSPACE', 1],
  ['PLANNING', 10],
  ['REVIEWING_PLAN', 5],
  ['IMPLEMENTING', 20],
  ['REVIEWING_CODE', 4],
  ['TESTING', 2],
  ['DELIVERING', 1],
];

interface FakeRunOptions {
  phases?: Array<[Phase, number]>;
  costs?: Partial<Record<Phase, number>>;
  /** Terminal phase. Anything but COMPLETE must not be sampled. */
  ended?: Phase;
  /** Turns to record with no price at all, per phase. */
  unpriced?: Partial<Record<Phase, number>>;
  workflow?: Partial<RelayConfig['workflow']>;
}

/**
 * A run on disk, with a real transition history so the estimate reads its
 * timings the same way `relay status` does.
 */
function fakeRun(options: FakeRunOptions = {}): RunState {
  const config = structuredClone(DEFAULT_CONFIG);
  Object.assign(config.workflow, options.workflow ?? {});

  const started = Date.parse('2026-08-01T10:00:00Z');
  const state = createRunState({
    runId: createRunId(new Date(started)),
    shortId: shortId(),
    issueRef: '142',
    repository: { root: '/repo', owner: 'acme', name: 'widgets', defaultBranch: 'main' },
    config,
    now: new Date(started),
  });

  let at = started;
  state.history = [];
  for (const [phase, minutes] of options.phases ?? FULL) {
    state.history.push({ phase, at: new Date(at).toISOString() });
    at += minutes * MINUTE;
  }

  state.phase = options.ended ?? 'COMPLETE';
  state.history.push({ phase: state.phase, at: new Date(at).toISOString() });
  state.finishedAt = new Date(at).toISOString();
  state.updatedAt = state.finishedAt;

  for (const [phase, costUsd] of Object.entries(options.costs ?? {})) {
    state.usage = recordTurnUsage(state.usage, phase as Phase, { inputTokens: 1000, outputTokens: 100, costUsd });
  }
  for (const [phase, turns] of Object.entries(options.unpriced ?? {})) {
    for (let turn = 0; turn < turns; turn += 1) {
      state.usage = recordTurnUsage(state.usage, phase as Phase, { inputTokens: 1000, outputTokens: 100 });
    }
  }
  return state;
}

function workflow(overrides: Partial<RelayConfig['workflow']> = {}): RelayConfig['workflow'] {
  return { ...structuredClone(DEFAULT_CONFIG).workflow, ...overrides };
}

describe('estimating a run from the repository\'s own history', () => {
  it('says there is no estimate rather than inventing one', () => {
    const estimate = estimateRun([], workflow());

    assert.equal(estimate.sampleSize, 0);
    assert.equal(estimate.unfinished, 0);
    assert.equal(estimate.duration, undefined);
    assert.equal(estimate.cost, undefined);
  });

  it('does not sample runs that never completed', () => {
    // A run that died in planning says nothing about what a whole one costs.
    const estimate = estimateRun([fakeRun({ ended: 'FAILED' }), fakeRun({ ended: 'CANCELLED' })], workflow());

    assert.equal(estimate.sampleSize, 0);
    assert.equal(estimate.unfinished, 2);
  });

  it('reports the median and the worst case with the sample it used', () => {
    const short: Array<[Phase, number]> = [['IMPLEMENTING', 10], ['TESTING', 1]];
    const middle: Array<[Phase, number]> = [['IMPLEMENTING', 20], ['TESTING', 1]];
    const long: Array<[Phase, number]> = [['IMPLEMENTING', 60], ['TESTING', 1]];

    const estimate = estimateRun(
      [fakeRun({ phases: short }), fakeRun({ phases: long }), fakeRun({ phases: middle })],
      workflow(),
    );

    assert.equal(estimate.sampleSize, 3);
    assert.equal(estimate.duration?.median, 21 * MINUTE);
    assert.equal(estimate.duration?.worst, 61 * MINUTE);
  });

  it('costs only the phases the planned run will take, which is what --fast buys', () => {
    const costs = { PLANNING: 0.4, REVIEWING_PLAN: 0.3, IMPLEMENTING: 1, REVIEWING_CODE: 0.3 } as const;
    const history = [fakeRun({ costs })];

    const full = estimateRun(history, workflow());
    const fast = estimateRun(history, workflow({ plan: 'inline', reviewCode: false }));

    assert.equal(full.cost?.median, 2);
    assert.equal(fast.cost?.median, 1);
    // And the time those phases took goes with them.
    assert.equal(full.duration?.median, 44 * MINUTE);
    assert.equal(fast.duration?.median, 25 * MINUTE);
  });

  it('drops the suite from the estimate when the suite will not run', () => {
    const history = [fakeRun({ costs: { IMPLEMENTING: 1, TESTING: 0.5 } })];

    assert.equal(estimateRun(history, workflow()).cost?.median, 1.5);
    assert.equal(estimateRun(history, workflow({ runTests: false })).cost?.median, 1);
    assert.ok(!plannedPhases(workflow({ runTests: false })).includes('TESTING'));
    assert.ok(plannedPhases(workflow()).includes('TESTING'));
  });

  it('leaves cost absent when nothing in the planned phases was ever priced', () => {
    // A Codex-only repository has real durations and no prices at all.
    const estimate = estimateRun([fakeRun({ unpriced: { IMPLEMENTING: 3 } })], workflow());

    assert.ok(estimate.duration !== undefined);
    assert.equal(estimate.cost, undefined);
  });

  it('counts the unpriced turns behind a cost, so the number reads as a floor', () => {
    const estimate = estimateRun(
      [fakeRun({ costs: { PLANNING: 0.5 }, unpriced: { IMPLEMENTING: 2 } })],
      workflow(),
    );

    assert.equal(estimate.cost?.median, 0.5);
    assert.equal(estimate.cost?.unpriced, 2);
  });

  it('states the sample size of the cost separately from the sample size of the run', () => {
    const estimate = estimateRun(
      [fakeRun({ costs: { IMPLEMENTING: 1 } }), fakeRun({ unpriced: { IMPLEMENTING: 1 } })],
      workflow(),
    );

    assert.equal(estimate.sampleSize, 2);
    assert.equal(estimate.cost?.sampleSize, 1);
  });

  it('names the planned phases no previous run ever entered', () => {
    // History from `--fast` runs cannot price a review that never happened.
    const fast: Array<[Phase, number]> = [['IMPLEMENTING', 10], ['TESTING', 1], ['DELIVERING', 1]];
    const estimate = estimateRun([fakeRun({ phases: fast })], workflow());

    assert.deepEqual([...estimate.unobserved], ['FETCHING_ISSUE', 'CREATING_WORKSPACE', 'PLANNING', 'REVIEWING_PLAN', 'REVIEWING_CODE']);
  });
});

describe('the confirmation above a threshold', () => {
  const expensive = estimateRun([fakeRun({ costs: { IMPLEMENTING: 4 } })], workflow());

  it('compares the threshold against the median, and only asks above it', () => {
    assert.equal(exceedsThreshold(expensive, 2), true);
    assert.equal(exceedsThreshold(expensive, 4), false);
    assert.equal(exceedsThreshold(expensive, null), false);
    assert.equal(exceedsThreshold(estimateRun([], workflow()), 0.01), false);
  });

  it('asks once on a terminal, and takes no for an answer', async () => {
    const prompter = new ScriptedPrompter(['n']);
    assert.equal(await confirmEstimate(expensive, 2, { prompter }), false);
    assert.equal(prompter.asked.length, 1);
    assert.match(prompter.asked[0] ?? '', /\$4\.00/);
  });

  it('starts the run when the answer is yes', async () => {
    assert.equal(await confirmEstimate(expensive, 2, { prompter: new ScriptedPrompter(['y']) }), true);
  });

  it('does not ask at all when the estimate is under the threshold', async () => {
    const prompter = new ScriptedPrompter([]);
    assert.equal(await confirmEstimate(expensive, 10, { prompter }), true);
    assert.deepEqual(prompter.asked, []);
  });

  it('refuses rather than prompting when nobody is there to answer', async () => {
    const prompter = new ScriptedPrompter([], false);

    await assert.rejects(
      () => confirmEstimate(expensive, 2, { prompter }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'COST_NOT_CONFIRMED');
        assert.match(error.message, /not a terminal/);
        return true;
      },
    );
    assert.deepEqual(prompter.asked, []);
  });
});

describe('the estimate as printed', () => {
  function capture(run: () => void): string {
    const originalWrite = process.stdout.write.bind(process.stdout);
    let captured = '';
    setTheme({ color: false, unicode: true, interactive: false });
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stdout.write;
    try {
      run();
    } finally {
      process.stdout.write = originalWrite;
      setTheme(undefined);
    }
    return captured;
  }

  it('lists the phases and states the sample size', () => {
    const output = capture(() => printEstimate(estimateRun([fakeRun({ costs: { IMPLEMENTING: 1.5 } })], workflow())));

    assert.match(output, /Planning → Plan review → Implementation → Code review → Tests → Delivery/);
    assert.match(output, /from 1 completed run\b/);
    assert.match(output, /\$1\.50/);
  });

  it('says there is no history instead of printing a number', () => {
    const output = capture(() => printEstimate(estimateRun([], workflow())));

    assert.match(output, /No previous runs in this repository/);
    assert.ok(!output.includes('$'));
  });

  it('names the budget the run will stop itself at', () => {
    const output = capture(() => printEstimate(estimateRun([], workflow()), 5));

    assert.match(output, /stop itself past \$5\.00/);
  });
});
