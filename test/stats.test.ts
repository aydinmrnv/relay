import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { statsCommand, statsToJson, type StatsJson } from '../src/cli/commands/stats.ts';
import { setTheme } from '../src/cli/output.ts';
import { DEFAULT_CONFIG, type RelayConfig } from '../src/storage/config.ts';
import { RunStore } from '../src/storage/runs.ts';
import { createRunId, shortId } from '../src/util/ids.ts';
import { median, percentile } from '../src/util/stats.ts';
import type { Phase } from '../src/workflow/phases.ts';
import { repositoryStats } from '../src/workflow/stats.ts';
import { createRunState, type RunState } from '../src/workflow/state.ts';
import { recordTurnUsage } from '../src/workflow/usage.ts';
import { createTempRepo, type TempRepo } from './helpers/tempRepo.ts';

const MINUTE = 60_000;

interface FakeRunOptions {
  ended?: Phase;
  minutes?: number;
  costs?: Partial<Record<Phase, number>>;
  unpriced?: number;
  rounds?: { planReview?: number; codeReview?: number };
  planDecision?: 'approve' | 'request_changes';
  codeDecision?: 'approve' | 'request_changes';
  workflow?: Partial<RelayConfig['workflow']>;
  createdAt?: string;
}

function fakeRun(options: FakeRunOptions = {}): RunState {
  const config = structuredClone(DEFAULT_CONFIG);
  Object.assign(config.workflow, options.workflow ?? {});

  const started = Date.parse(options.createdAt ?? '2026-08-01T10:00:00Z');
  const state = createRunState({
    runId: createRunId(new Date(started)),
    shortId: shortId(),
    issueRef: '142',
    repository: { root: '/repo', owner: 'acme', name: 'widgets', defaultBranch: 'main' },
    config,
    now: new Date(started),
  });

  const finished = started + (options.minutes ?? 10) * MINUTE;
  state.phase = options.ended ?? 'COMPLETE';
  state.history.push({ phase: state.phase, at: new Date(finished).toISOString() });
  state.finishedAt = new Date(finished).toISOString();
  state.updatedAt = state.finishedAt;

  state.rounds = { planReview: options.rounds?.planReview ?? 1, codeReview: options.rounds?.codeReview ?? 1 };

  for (const [phase, costUsd] of Object.entries(options.costs ?? {})) {
    state.usage = recordTurnUsage(state.usage, phase as Phase, { inputTokens: 1000, outputTokens: 100, costUsd });
  }
  for (let turn = 0; turn < (options.unpriced ?? 0); turn += 1) {
    state.usage = recordTurnUsage(state.usage, 'IMPLEMENTING', { inputTokens: 1000, outputTokens: 100 });
  }

  if (options.planDecision !== undefined) {
    state.reviews.push({
      round: 1,
      kind: 'plan',
      reviewer: 'codex',
      decision: options.planDecision,
      findings: [],
      at: state.finishedAt,
    });
  }
  if (options.codeDecision !== undefined) {
    state.reviews.push({
      round: 1,
      kind: 'code',
      reviewer: 'claude',
      decision: options.codeDecision,
      findings: [],
      at: state.finishedAt,
    });
  }

  return state;
}

describe('repository statistics', () => {
  it('counts every outcome and rates success against the finished runs', () => {
    const stats = repositoryStats([
      fakeRun(),
      fakeRun(),
      fakeRun({ ended: 'FAILED' }),
      fakeRun({ ended: 'CANCELLED' }),
      fakeRun({ ended: 'IMPLEMENTING' }),
    ]);

    assert.equal(stats.runs, 5);
    assert.equal(stats.complete, 2);
    assert.equal(stats.failed, 1);
    assert.equal(stats.cancelled, 1);
    assert.equal(stats.running, 1);
    // The run still in flight has not succeeded or failed, so it is not judged.
    assert.equal(stats.successRate, 0.5);
  });

  it('reports duration over completed runs only', () => {
    const stats = repositoryStats([
      fakeRun({ minutes: 10 }),
      fakeRun({ minutes: 20 }),
      fakeRun({ minutes: 90 }),
      // A run that died after 90 seconds is not a fast run.
      fakeRun({ minutes: 1, ended: 'FAILED' }),
    ]);

    assert.equal(stats.duration?.runs, 3);
    assert.equal(stats.duration?.median, 20 * MINUTE);
    assert.equal(stats.duration?.p90, 90 * MINUTE);
  });

  it('counts the cost of runs that failed, because the money was still spent', () => {
    const stats = repositoryStats([
      fakeRun({ costs: { IMPLEMENTING: 1 } }),
      fakeRun({ costs: { IMPLEMENTING: 3 }, ended: 'FAILED' }),
    ]);

    assert.equal(stats.cost?.runs, 2);
    assert.equal(stats.cost?.total, 4);
    assert.equal(stats.cost?.median, 1);
  });

  it('leaves cost out entirely when no run reported one', () => {
    const stats = repositoryStats([fakeRun({ unpriced: 3 })]);

    assert.equal(stats.cost, undefined);
    assert.ok(stats.duration !== undefined);
  });

  it('carries the unpriced turn count so every cost reads as a floor', () => {
    const stats = repositoryStats([fakeRun({ costs: { PLANNING: 1 }, unpriced: 2 })]);

    assert.equal(stats.cost?.unpriced, 2);
  });

  it('attributes cost to phases in workflow order, folding revisions into their review', () => {
    const stats = repositoryStats([
      fakeRun({ costs: { PLANNING: 0.5, REVIEWING_CODE: 0.2, REVISING_CODE: 0.3 } }),
      fakeRun({ costs: { PLANNING: 1.5, REVIEWING_CODE: 0.5 } }),
    ]);

    assert.deepEqual(
      stats.costByPhase.map((entry) => entry.phase),
      ['PLANNING', 'REVIEWING_CODE'],
    );
    assert.equal(stats.costByPhase[0]?.total, 2);
    assert.equal(stats.costByPhase[0]?.median, 0.5);
    // The revision round belongs to the review that asked for it.
    assert.equal(stats.costByPhase[1]?.total, 1);
  });

  it('counts rounds only over the runs that held that review', () => {
    const stats = repositoryStats([
      fakeRun({ rounds: { planReview: 2, codeReview: 1 } }),
      fakeRun({ rounds: { planReview: 1, codeReview: 1 } }),
      // A --fast run held neither, so it must not drag either median to zero.
      fakeRun({ rounds: { planReview: 0, codeReview: 0 }, workflow: { plan: 'inline', reviewCode: false } }),
    ]);

    assert.equal(stats.rounds.planReview?.runs, 2);
    assert.equal(stats.rounds.planReview?.median, 1);
    assert.equal(stats.rounds.planReview?.max, 2);
    assert.equal(stats.rounds.codeReview?.runs, 2);
    assert.equal(stats.rounds.codeReview?.median, 1);
  });

  it('measures how often each review did the thing it exists to do', () => {
    const stats = repositoryStats([
      fakeRun({ planDecision: 'request_changes', codeDecision: 'approve' }),
      fakeRun({ planDecision: 'approve', codeDecision: 'request_changes' }),
      fakeRun({ planDecision: 'approve', codeDecision: 'approve' }),
      // No review of either kind: not part of either denominator.
      fakeRun(),
    ]);

    assert.deepEqual(stats.planChanged, { runs: 1, of: 3 });
    assert.deepEqual(stats.codeBlocked, { runs: 1, of: 3 });
  });

  it('reports nothing about reviews that have never happened here', () => {
    const stats = repositoryStats([fakeRun()]);

    assert.equal(stats.planChanged, undefined);
    assert.equal(stats.codeBlocked, undefined);
  });

  it('describes an empty repository without inventing rates', () => {
    const stats = repositoryStats([]);

    assert.equal(stats.runs, 0);
    assert.equal(stats.successRate, undefined);
    assert.equal(stats.duration, undefined);
    assert.deepEqual(stats.costByPhase, []);
  });
});

describe('order statistics', () => {
  it('reports values a run actually produced rather than interpolating between them', () => {
    assert.equal(median([10, 20, 30]), 20);
    assert.equal(median([10, 20]), 10);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
    assert.equal(percentile([5], 0.9), 5);
    assert.equal(percentile([], 0.5), 0);
  });
});

describe('relay stats', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo();
    setTheme({ color: false, unicode: true, interactive: false });
  });

  afterEach(async () => {
    setTheme(undefined);
    await repo.cleanup();
  });

  async function persist(state: RunState): Promise<void> {
    const store = new RunStore(repo.root, state.runId);
    await store.init();
    state.repository.root = repo.root;
    await store.saveState(state);
  }

  async function capture(run: () => Promise<unknown>): Promise<string> {
    const originalCwd = process.cwd();
    const originalWrite = process.stdout.write.bind(process.stdout);
    let captured = '';

    process.chdir(repo.root);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stdout.write;

    try {
      await run();
    } finally {
      process.stdout.write = originalWrite;
      process.chdir(originalCwd);
    }
    return captured;
  }

  it('reports over the repository\'s runs', async () => {
    await persist(fakeRun({ minutes: 10, costs: { PLANNING: 0.5 }, planDecision: 'request_changes', createdAt: '2026-08-01T10:00:00Z' }));
    await persist(fakeRun({ minutes: 30, costs: { PLANNING: 1.5 }, planDecision: 'approve', ended: 'FAILED', createdAt: '2026-08-02T10:00:00Z' }));

    const output = await capture(() => statsCommand());

    assert.match(output, /2 runs/);
    assert.match(output, /1 complete/);
    assert.match(output, /1 failed/);
    assert.match(output, /50% of finished runs/);
    assert.match(output, /\$2\.00 in total/);
    assert.match(output, /Plan review changed the plan\s+1 of 2/);
  });

  it('says so plainly when there is nothing to report', async () => {
    const output = await capture(() => statsCommand());

    assert.match(output, /No runs yet in this repository/);
  });

  it('prints machine-readable JSON with nulls rather than missing keys', async () => {
    await persist(fakeRun({ minutes: 10, costs: { IMPLEMENTING: 2 } }));

    const output = await capture(() => statsCommand({ json: true }));
    const payload = JSON.parse(output) as StatsJson;

    assert.equal(payload.runs, 1);
    assert.equal(payload.cost?.totalUsd, 2);
    assert.equal(payload.duration?.medianMs, 10 * MINUTE);
    assert.equal(payload.costByPhase[0]?.phase, 'IMPLEMENTING');
    assert.equal(payload.planReviewChangedPlan, null);
    assert.equal(payload.codeReviewBlocked, null);
    assert.ok(!output.includes('\u001B'), 'JSON must never carry colour codes');
  });

  it('projects an empty repository onto the same shape', () => {
    const payload = statsToJson('/repo', repositoryStats([]));

    for (const key of ['successRate', 'duration', 'cost', 'planReviewChangedPlan', 'codeReviewBlocked'] as const) {
      assert.equal(payload[key], null, `${key} should be null`);
    }
    assert.deepEqual(payload.costByPhase, []);
    assert.deepEqual(payload.rounds, { planReview: null, codeReview: null });
  });
});
