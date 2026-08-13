import type { RelayConfig } from '../storage/config.ts';
import { median } from '../util/stats.ts';
import { displayPhasesFor, type Phase } from './phases.ts';
import type { RunState } from './state.ts';
import { phaseCosts, phaseTimings } from './timeline.ts';

/**
 * What a run will probably cost, measured on this repository's own runs.
 *
 * Every number here was produced by a run that actually happened here: no
 * model pricing table, no token-count model, no extrapolation. That is the
 * only estimate worth showing before spending someone's money — and it is why
 * a repository with no completed runs gets told there is no estimate rather
 * than a confident number invented for the occasion.
 *
 * The estimate is built per phase and then summed, which is what makes it
 * answer the question a flag actually asks: `--fast` drops the planning and
 * review phases from the sum, `--no-tests` drops the suite, and the difference
 * between the two printouts is what that flag buys.
 */

export interface EstimateRange {
  median: number;
  /** The worst the sample produced. An observation, never an extrapolation. */
  worst: number;
}

export interface CostEstimate extends EstimateRange {
  /** Runs in the sample that reported a price at all. */
  sampleSize: number;
  /** Turns across the sample that reported none, so both numbers are floors. */
  unpriced: number;
}

export interface RunEstimate {
  /** The phases the run will execute, in order. */
  phases: readonly Phase[];
  /** Completed runs the estimate is derived from. Zero means there is none. */
  sampleSize: number;
  /** Runs on disk that were left out because they never completed. */
  unfinished: number;
  duration?: EstimateRange;
  cost?: CostEstimate;
  /**
   * Planned phases no run in the sample ever entered — a first code review, a
   * first test suite. Nothing was counted for them, so the estimate is low by
   * however much they turn out to cost.
   */
  unobserved: readonly Phase[];
}

/**
 * The phases this configuration will actually execute.
 *
 * `displayPhasesFor` already drops what the plan mode and code review skip.
 * Tests are the one phase a run still enters with nothing to do, so a run with
 * the suite off must not be charged for the suite's history.
 */
export function plannedPhases(workflow: RelayConfig['workflow']): readonly Phase[] {
  const phases = displayPhasesFor(workflow);
  return workflow.runTests ? phases : phases.filter((phase) => phase !== 'TESTING');
}

/**
 * Estimates duration and cost for a run of this shape from previous ones.
 *
 * Only completed runs are sampled: a run that died in planning says nothing
 * useful about how long a whole run takes. Each sample contributes the time
 * and cost of the phases the planned run will take — so history from full runs
 * still estimates a `--fast` one, using the phases the two have in common.
 */
export function estimateRun(previous: readonly RunState[], workflow: RelayConfig['workflow']): RunEstimate {
  const phases = plannedPhases(workflow);
  const planned = new Set(phases);
  const samples = previous.filter((run) => run.phase === 'COMPLETE');

  const durations: number[] = [];
  const costs: number[] = [];
  const observed = new Set<Phase>();
  let unpriced = 0;

  for (const run of samples) {
    let ms = 0;
    for (const timing of phaseTimings(run)) {
      if (!planned.has(timing.phase)) continue;
      observed.add(timing.phase);
      ms += timing.ms;
    }
    // A completed run whose history somehow yielded nothing is not evidence of
    // an instant run, so it contributes to neither number.
    if (ms > 0) durations.push(ms);

    let usd: number | undefined;
    for (const [phase, cost] of phaseCosts(run)) {
      if (!planned.has(phase)) continue;
      unpriced += cost.unpriced;
      if (cost.usd !== undefined) usd = (usd ?? 0) + cost.usd;
    }
    if (usd !== undefined) costs.push(usd);
  }

  return {
    phases,
    sampleSize: samples.length,
    unfinished: previous.length - samples.length,
    ...(durations.length === 0 ? {} : { duration: range(durations) }),
    ...(costs.length === 0 ? {} : { cost: { ...range(costs), sampleSize: costs.length, unpriced } }),
    unobserved: samples.length === 0 ? [] : phases.filter((phase) => !observed.has(phase)),
  };
}

/**
 * Whether a run of this shape has ever cost more than a threshold.
 *
 * The median is what the question is asked about: a single expensive outlier
 * should not put a confirmation in front of every run for the rest of the
 * repository's life, and the worst case is shown in the question anyway.
 */
export function exceedsThreshold(estimate: RunEstimate, thresholdUsd: number | null): boolean {
  if (thresholdUsd === null || estimate.cost === undefined) return false;
  return estimate.cost.median > thresholdUsd;
}

function range(values: readonly number[]): EstimateRange {
  return { median: median(values), worst: Math.max(...values) };
}
