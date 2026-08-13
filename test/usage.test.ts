import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  addUsage,
  budgetBreach,
  emptyRunUsage,
  formatCost,
  formatTokens,
  formatUsage,
  recordTurnUsage,
  unpricedTurns,
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
    assert.deepEqual(run.total, { inputTokens: 0, outputTokens: 0, turns: 0, pricedTurns: 0 });
    assert.deepEqual(run.byPhase, {});
  });

  it('counts the turns that reported no price, so a cost can be read as a floor', () => {
    let totals = addUsage(zeroTotals(), { inputTokens: 10, outputTokens: 5, costUsd: 0.4 });
    totals = addUsage(totals, { inputTokens: 10, outputTokens: 5 });
    totals = addUsage(totals, { inputTokens: 10, outputTokens: 5 });

    assert.equal(totals.turns, 3);
    assert.equal(totals.pricedTurns, 1);
    assert.equal(unpricedTurns(totals), 2);
  });

  it('reports no unpriced turns for a bucket recorded before Relay counted them', () => {
    // Absent is "not known", never "none": a caveat invented from missing data
    // would appear on every run that predates the field.
    assert.equal(unpricedTurns({ inputTokens: 10, outputTokens: 5, turns: 4, costUsd: 1 }), 0);
  });
});

describe('budget ceiling', () => {
  it('does not trip without a ceiling', () => {
    const usage = recordTurnUsage(undefined, 'PLANNING', { inputTokens: 10, outputTokens: 5, costUsd: 99 });
    assert.equal(budgetBreach(usage, null), undefined);
  });

  it('trips only once spending is past the ceiling, never at it', () => {
    const at = recordTurnUsage(undefined, 'PLANNING', { inputTokens: 10, outputTokens: 5, costUsd: 1 });
    assert.equal(budgetBreach(at, 1), undefined);

    const past = recordTurnUsage(at, 'IMPLEMENTING', { inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
    assert.deepEqual(budgetBreach(past, 1), { spentUsd: 1.01, maxCostUsd: 1, unpriced: 0 });
  });

  it('never treats an unreported cost as zero, so it cannot stop a run over nothing', () => {
    // A Codex-only run has real tokens and no price. A ceiling has nothing to
    // compare against, so it must not intervene.
    const usage = recordTurnUsage(undefined, 'IMPLEMENTING', { inputTokens: 500_000, outputTokens: 90_000 });
    assert.equal(budgetBreach(usage, 0.01), undefined);
  });

  it('reports the unpriced turns alongside the breach, because the bill is higher', () => {
    let usage = recordTurnUsage(undefined, 'PLANNING', { inputTokens: 10, outputTokens: 5, costUsd: 2 });
    usage = recordTurnUsage(usage, 'IMPLEMENTING', { inputTokens: 10, outputTokens: 5 });

    assert.deepEqual(budgetBreach(usage, 1), { spentUsd: 2, maxCostUsd: 1, unpriced: 1 });
  });

  it('has nothing to check before the first turn', () => {
    assert.equal(budgetBreach(undefined, 1), undefined);
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
