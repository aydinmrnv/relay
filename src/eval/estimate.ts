/**
 * What a run of the eval will cost, said before it starts.
 *
 * Relay's rule elsewhere is that cost is reported and never guessed, and this
 * file keeps it. Turn counts are exact — they fall out of the state machine, so
 * a configuration's minimum and maximum number of agent turns is arithmetic.
 * Money and wall-clock are not: they come from previously *measured* runs, and
 * when there are none this says so instead of inventing a number.
 */
import { reviewsCode, type RelayConfig } from '../storage/config.ts';
import { formatCost } from '../workflow/usage.ts';
import { formatDuration, pluralize } from '../util/text.ts';
import type { RunState } from '../workflow/state.ts';
import type { ResolvedEvalConfig } from './configs.ts';
import type { EvalResults } from './types.ts';

export interface Range {
  min: number;
  max: number;
}

/**
 * Agent turns one run of a configuration takes, best case to worst.
 *
 * The minimum is everything approving on its first round; the maximum is every
 * round limit spent. Retries and format-reminder resumes are excluded — they
 * are failure handling, not a property of the configuration.
 */
export function estimateTurns(config: RelayConfig): Range {
  const workflow = config.workflow;
  let min = 0;
  let max = 0;

  if (workflow.plan === 'review') {
    const rounds = Math.max(1, workflow.maxPlanReviewRounds);
    // Planner, then at least one review; at worst a review and a revision per
    // round, with no revision after the last one.
    min += 2;
    max += 1 + rounds + Math.max(0, rounds - 1);
    if (workflow.primeReviewers) {
      min += 1;
      max += 1;
    }
  }

  // The implementation turn is the one turn every configuration takes.
  min += 1;
  max += 1;

  if (reviewsCode(config)) {
    const rounds = Math.max(1, workflow.maxCodeReviewRounds);
    min += 1;
    max += rounds + Math.max(0, rounds - 1);
    if (workflow.primeReviewers) {
      min += 1;
      max += 1;
    }
  }

  return { min, max };
}

/** One measured run, reduced to the three numbers an estimate needs. */
export interface CalibrationSample {
  turns: number;
  costUsd?: number;
  wallClockMs: number;
}

export interface Calibration {
  samples: number;
  /** Present only when at least one sample reported a price. */
  usdPerTurn?: number;
  msPerTurn: number;
  /** Samples whose CLI published no cost. A cost built on these is a floor. */
  unpricedSamples: number;
  source: string;
}

/**
 * Averages measured runs into a per-turn rate.
 *
 * Per *turn* rather than per run because the configurations differ mostly in
 * how many turns they take: a rate per run calibrated on `cross-model` would
 * badly overprice `solo`.
 */
export function calibrationFrom(
  samples: readonly CalibrationSample[],
  source: string,
): Calibration | undefined {
  const usable = samples.filter((sample) => sample.turns > 0 && sample.wallClockMs > 0);
  if (usable.length === 0) return undefined;

  const turns = usable.reduce((sum, sample) => sum + sample.turns, 0);
  const wallClock = usable.reduce((sum, sample) => sum + sample.wallClockMs, 0);

  const priced = usable.filter((sample) => sample.costUsd !== undefined);
  const pricedTurns = priced.reduce((sum, sample) => sum + sample.turns, 0);
  const cost = priced.reduce((sum, sample) => sum + (sample.costUsd ?? 0), 0);

  return {
    samples: usable.length,
    ...(pricedTurns > 0 ? { usdPerTurn: cost / pricedTurns } : {}),
    msPerTurn: wallClock / turns,
    unpricedSamples: usable.length - priced.length,
    source,
  };
}

/** Previously recorded eval sessions: the closest thing to a like-for-like prior. */
export function samplesFromResults(sets: readonly EvalResults[]): CalibrationSample[] {
  return sets.flatMap((set) =>
    set.outcomes.map((outcome) => ({
      turns: outcome.turns,
      ...(outcome.usage?.costUsd === undefined ? {} : { costUsd: outcome.usage.costUsd }),
      wallClockMs: outcome.wallClockMs,
    })),
  );
}

/**
 * This repository's own run history, used when no eval has been recorded yet.
 *
 * Weaker than an eval sample — real issues are larger than fixtures — so the
 * estimate built from it will run high. That is the right direction for a
 * number whose job is to stop someone spending more than they meant to.
 */
export function samplesFromRuns(states: readonly RunState[]): CalibrationSample[] {
  const samples: CalibrationSample[] = [];
  for (const state of states) {
    const turns = state.usage?.total.turns ?? 0;
    const finished = state.finishedAt ?? state.updatedAt;
    const wallClockMs = new Date(finished).getTime() - new Date(state.createdAt).getTime();
    if (turns <= 0 || !Number.isFinite(wallClockMs) || wallClockMs <= 0) continue;
    samples.push({
      turns,
      ...(state.usage?.total.costUsd === undefined ? {} : { costUsd: state.usage.total.costUsd }),
      wallClockMs,
    });
  }
  return samples;
}

export interface ConfigEstimate {
  name: string;
  runs: number;
  turnsPerRun: Range;
  turns: Range;
}

export interface EvalEstimate {
  runs: number;
  turns: Range;
  perConfig: ConfigEstimate[];
  costUsd?: Range;
  /** Sum over every run: what a sequential eval takes end to end. */
  wallClockMs?: Range;
  /** Where the money and time numbers came from, or why there are none. */
  basis: string;
}

export function estimateEval(
  configs: readonly ResolvedEvalConfig[],
  options: { fixtures: number; repeats: number; concurrency?: number; calibration?: Calibration | undefined },
): EvalEstimate {
  const runsPerConfig = options.fixtures * options.repeats;

  const perConfig = configs.map(({ spec, config }) => {
    const turnsPerRun = estimateTurns(config);
    return {
      name: spec.name,
      runs: runsPerConfig,
      turnsPerRun,
      turns: { min: turnsPerRun.min * runsPerConfig, max: turnsPerRun.max * runsPerConfig },
    };
  });

  const turns = perConfig.reduce<Range>(
    (total, entry) => ({ min: total.min + entry.turns.min, max: total.max + entry.turns.max }),
    { min: 0, max: 0 },
  );

  const estimate: EvalEstimate = {
    runs: runsPerConfig * configs.length,
    turns,
    perConfig,
    basis: 'no measured runs are available yet, so cost and wall-clock are unknown',
  };

  const calibration = options.calibration;
  if (calibration === undefined) return estimate;

  const concurrency = Math.max(1, options.concurrency ?? 1);
  estimate.wallClockMs = {
    min: (turns.min * calibration.msPerTurn) / concurrency,
    max: (turns.max * calibration.msPerTurn) / concurrency,
  };

  if (calibration.usdPerTurn !== undefined) {
    estimate.costUsd = { min: turns.min * calibration.usdPerTurn, max: turns.max * calibration.usdPerTurn };
  }

  const unpriced =
    calibration.usdPerTurn === undefined
      ? 'none of them reported a price, so cost is unknown'
      : calibration.unpricedSamples > 0
        ? `${calibration.unpricedSamples} of them reported no price, so the cost shown is a floor`
        : 'all of them reported a price';

  estimate.basis = `${pluralize(calibration.samples, 'measured run')} from ${calibration.source}; ${unpriced}`;
  return estimate;
}

export function formatRange(range: Range, format: (value: number) => string): string {
  const low = format(range.min);
  const high = format(range.max);
  return low === high ? low : `${low} – ${high}`;
}

export function formatCount(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

export function formatCostRange(range: Range): string {
  return formatRange(range, formatCost);
}

export function formatWallClockRange(range: Range): string {
  return formatRange(range, formatDuration);
}
