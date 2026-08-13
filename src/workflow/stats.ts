import { reviewsCode } from '../storage/config.ts';
import { median, percentile } from '../util/stats.ts';
import { DISPLAY_PHASES, isTerminal, type Phase } from './phases.ts';
import type { RunState } from './state.ts';
import { phaseCosts, runElapsedMs } from './timeline.ts';
import { unpricedTurns } from './usage.ts';

/**
 * What Relay has actually done in one repository.
 *
 * Every claim the product makes about itself — that a second model reading the
 * plan is worth the rounds it spends, that a code review catches things — is
 * measurable on the user's own work, and this is where it gets measured. The
 * numbers are read from run state, so they describe what happened rather than
 * what any agent said happened.
 *
 * Two sampling rules run through it. Duration is taken from completed runs
 * only, because a run that died in planning took no meaningful time; cost is
 * taken from every run that reported one, because a run that failed still
 * spent the money it spent.
 */

export interface Distribution {
  median: number;
  p90: number;
  /** Runs the distribution was computed over. */
  runs: number;
}

export interface CostDistribution extends Distribution {
  total: number;
  /** Turns across the sample that reported no price, so the totals are floors. */
  unpriced: number;
}

export interface PhaseCostStats {
  phase: Phase;
  median: number;
  total: number;
  /** Runs that reported a cost for this phase. */
  runs: number;
}

export interface RoundStats {
  median: number;
  max: number;
  /** Runs that ran the phase at all. */
  runs: number;
}

/** A count against the runs it could have happened in. */
export interface Frequency {
  runs: number;
  of: number;
}

export interface RepositoryStats {
  runs: number;
  complete: number;
  failed: number;
  cancelled: number;
  /** Runs that have not reached a terminal phase — in flight, or abandoned. */
  running: number;
  /** Completed over finished. Absent until a run has finished. */
  successRate?: number;
  duration?: Distribution;
  cost?: CostDistribution;
  costByPhase: PhaseCostStats[];
  rounds: { planReview?: RoundStats; codeReview?: RoundStats };
  /** Runs whose plan review sent the plan back, over runs that reviewed a plan. */
  planChanged?: Frequency;
  /** Runs whose code review requested changes, over runs that reviewed a diff. */
  codeBlocked?: Frequency;
}

export function repositoryStats(runs: readonly RunState[]): RepositoryStats {
  const complete = runs.filter((run) => run.phase === 'COMPLETE');
  const failed = runs.filter((run) => run.phase === 'FAILED');
  const cancelled = runs.filter((run) => run.phase === 'CANCELLED');
  const finished = complete.length + failed.length + cancelled.length;

  const durations = complete.map(runElapsedMs).filter((ms) => Number.isFinite(ms) && ms > 0);

  const costs: number[] = [];
  let unpriced = 0;
  for (const run of runs) {
    const total = run.usage?.total;
    if (total === undefined) continue;
    if (total.costUsd !== undefined) costs.push(total.costUsd);
    unpriced += unpricedTurns(total);
  }

  return {
    runs: runs.length,
    complete: complete.length,
    failed: failed.length,
    cancelled: cancelled.length,
    running: runs.filter((run) => !isTerminal(run.phase)).length,
    ...(finished === 0 ? {} : { successRate: complete.length / finished }),
    ...(durations.length === 0 ? {} : { duration: distribution(durations) }),
    ...(costs.length === 0
      ? {}
      : { cost: { ...distribution(costs), total: costs.reduce((sum, value) => sum + value, 0), unpriced } }),
    costByPhase: costByPhase(runs),
    rounds: {
      ...roundsFor('planReview', runs),
      ...roundsFor('codeReview', runs),
    },
    ...frequency('planChanged', runs),
    ...frequency('codeBlocked', runs),
  };
}

/**
 * Cost attributed to each phase, in workflow order. This is the table that
 * makes `maxPlanReviewRounds` an informed choice: a repository where plan
 * review is a third of the bill and never changes the plan is a repository
 * that should turn it down.
 */
function costByPhase(runs: readonly RunState[]): PhaseCostStats[] {
  const perPhase = new Map<Phase, number[]>();
  for (const run of runs) {
    for (const [phase, cost] of phaseCosts(run)) {
      if (cost.usd === undefined) continue;
      const values = perPhase.get(phase) ?? [];
      values.push(cost.usd);
      perPhase.set(phase, values);
    }
  }

  return DISPLAY_PHASES.flatMap((phase) => {
    const values = perPhase.get(phase);
    if (values === undefined || values.length === 0) return [];
    return [
      {
        phase,
        median: median(values),
        total: values.reduce((sum, value) => sum + value, 0),
        runs: values.length,
      },
    ];
  });
}

/**
 * Rounds consumed by a review phase, counted only over the runs that ran it.
 * Folding in the runs that skipped the phase would report a median of zero for
 * a review that always takes a round when it happens.
 */
function roundsFor(kind: 'planReview' | 'codeReview', runs: readonly RunState[]): { planReview?: RoundStats; codeReview?: RoundStats } {
  const ran = runs.filter((run) =>
    kind === 'planReview' ? run.config.workflow.plan === 'review' : reviewsCode(run.config),
  );
  if (ran.length === 0) return {};

  const values = ran.map((run) => run.rounds[kind]);
  return { [kind]: { median: median(values), max: Math.max(...values), runs: ran.length } };
}

/**
 * How often a review did the thing it exists to do. The denominator is runs
 * that actually held that review, so turning a review off lowers the sample
 * rather than quietly improving the rate.
 */
function frequency(
  kind: 'planChanged' | 'codeBlocked',
  runs: readonly RunState[],
): { planChanged?: Frequency; codeBlocked?: Frequency } {
  const reviewKind = kind === 'planChanged' ? 'plan' : 'code';
  const reviewed = runs.filter((run) => run.reviews.some((review) => review.kind === reviewKind));
  if (reviewed.length === 0) return {};

  const changed = reviewed.filter((run) =>
    run.reviews.some((review) => review.kind === reviewKind && review.decision === 'request_changes'),
  );
  return { [kind]: { runs: changed.length, of: reviewed.length } };
}

function distribution(values: readonly number[]): Distribution {
  return { median: median(values), p90: percentile(values, 0.9), runs: values.length };
}
