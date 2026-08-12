import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  addUsage,
  emptyRunUsage,
  formatCost,
  formatTokens,
  formatUsage,
  recordTurnUsage,
  zeroTotals,
} from '../src/workflow/usage.ts';

describe('usage accumulation', () => {
  it('sums tokens and cost across turns', () => {
    let totals = zeroTotals();
    totals = addUsage(totals, { inputTokens: 100, outputTokens: 20, costUsd: 0.5 });
    totals = addUsage(totals, { inputTokens: 300, outputTokens: 30, costUsd: 0.25 });

    assert.equal(totals.inputTokens, 400);
    assert.equal(totals.outputTokens, 50);
    assert.equal(totals.costUsd, 0.75);
    assert.equal(totals.turns, 2);
  });

  it('leaves cost absent when no turn reported one', () => {
    // Codex publishes no price, so a Codex-only bucket must not claim $0.00.
    const totals = addUsage(zeroTotals(), { inputTokens: 10, outputTokens: 5 });
    assert.equal(totals.costUsd, undefined);
    assert.ok(!('costUsd' in totals));
  });

  it('reports the partial cost when only some turns priced themselves', () => {
    let totals = addUsage(zeroTotals(), { inputTokens: 10, outputTokens: 5 });
    totals = addUsage(totals, { inputTokens: 10, outputTokens: 5, costUsd: 0.4 });
    assert.equal(totals.costUsd, 0.4);
    assert.equal(totals.turns, 2);
  });

  it('splits a run total across the phases that spent it', () => {
    let run = recordTurnUsage(undefined, 'PLANNING', { inputTokens: 1000, outputTokens: 100, costUsd: 0.1 });
    run = recordTurnUsage(run, 'REVIEWING_PLAN', { inputTokens: 500, outputTokens: 50, costUsd: 0.05 });
    run = recordTurnUsage(run, 'REVIEWING_PLAN', { inputTokens: 500, outputTokens: 50, costUsd: 0.05 });

    assert.equal(run.total.inputTokens, 2000);
    assert.equal(run.total.turns, 3);
    assert.equal(run.total.costUsd, 0.2);

    assert.equal(run.byPhase.PLANNING?.turns, 1);
    assert.equal(run.byPhase.REVIEWING_PLAN?.turns, 2);
    assert.equal(run.byPhase.REVIEWING_PLAN?.inputTokens, 1000);
    assert.equal(run.byPhase.IMPLEMENTING, undefined);
  });

  it('starts empty rather than undefined', () => {
    const run = emptyRunUsage();
    assert.deepEqual(run.total, { inputTokens: 0, outputTokens: 0, turns: 0 });
    assert.deepEqual(run.byPhase, {});
  });
});

describe('usage formatting', () => {
  it('abbreviates large token counts and leaves small ones exact', () => {
    assert.equal(formatTokens(0), '0');
    assert.equal(formatTokens(999), '999');
    assert.equal(formatTokens(1500), '1.5k');
    assert.equal(formatTokens(2_500_000), '2.50M');
  });

  it('keeps sub-cent costs visible instead of rounding them to nothing', () => {
    assert.equal(formatCost(0.0004), '$0.0004');
    assert.equal(formatCost(0), '$0.00');
    assert.equal(formatCost(1.239), '$1.24');
  });

  it('omits cost from the line entirely when none was reported', () => {
    const line = formatUsage({ inputTokens: 12_300, outputTokens: 4100, turns: 6 });
    assert.equal(line, '12.3k in / 4.1k out · 6 turns');
    assert.ok(!line.includes('$'));
  });

  it('includes cost when there is one', () => {
    assert.equal(
      formatUsage({ inputTokens: 1000, outputTokens: 100, costUsd: 0.42, turns: 1 }),
      '1.0k in / 100 out · $0.42 · 1 turn',
    );
  });
});
