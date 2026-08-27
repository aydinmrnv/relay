import type { RunState } from '../workflow/state.ts';
import { formatCost, unpricedTurns } from '../workflow/usage.ts';

/**
 * What the server has spent today, and whether it may spend more.
 *
 * The per-run budget is enforced inside the run, by the engine, at every phase
 * boundary. This is the other half: a ceiling on the day, enforced *before* a
 * run starts, because a run that has already begun cannot be un-started and a
 * daily cap that only notices afterwards is a report rather than a budget.
 */

/** The UTC day a timestamp falls in, as `YYYY-MM-DD`. */
export function dayOf(at: string | Date): string {
  const date = typeof at === 'string' ? new Date(at) : at;
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

/** Runs that started without a person — the ones this budget is about. */
export function unattendedRuns(runs: readonly RunState[]): RunState[] {
  return runs.filter((run) => run.trigger !== undefined);
}

export interface DailySpend {
  day: string;
  /** Dollars finished unattended runs reported today. */
  spentUsd: number;
  /** Turns in that sample that published no price, so `spentUsd` is a floor. */
  unpriced: number;
  runs: number;
}

/**
 * What unattended runs have cost in this repository today.
 *
 * The scope is deliberate and worth stating out loud: this counts what *Relay
 * started on its own*, not what the account spent. A person running `relay run`
 * all afternoon does not use up the daemon's budget, and the daemon does not
 * get to blame them for stopping. The cap is on the thing the cap can control.
 *
 * Every unattended run counts, whatever became of it — a run that failed in
 * implementation still spent the money it spent, and a budget that forgave
 * failures would be a budget an expensive failure loop could not exhaust.
 */
export function dailySpend(runs: readonly RunState[], now: Date = new Date()): DailySpend {
  const day = dayOf(now);
  let spentUsd = 0;
  let unpriced = 0;
  let counted = 0;

  for (const run of unattendedRuns(runs)) {
    if (dayOf(run.createdAt) !== day) continue;
    counted += 1;
    const total = run.usage?.total;
    if (total === undefined) continue;
    if (total.costUsd !== undefined) spentUsd += total.costUsd;
    unpriced += unpricedTurns(total);
  }

  return { day, spentUsd, unpriced, runs: counted };
}

export interface BudgetVerdict {
  ok: boolean;
  /** Spend already reported, plus the per-run cap held for each run in flight. */
  committedUsd: number;
  /** One sentence for the log, whichever way it went. */
  detail: string;
}

export interface BudgetInput {
  spend: DailySpend;
  /** Unattended runs this server currently has in flight. */
  inFlight: number;
  maxRunCostUsd: number;
  maxDailyCostUsd: number;
}

/**
 * Whether one more run fits inside the day.
 *
 * A run in flight has usually reported nothing yet, so counting only what has
 * been *reported* would let a server start ten runs at once and discover the
 * overspend afterwards. Instead each in-flight run reserves its full per-run
 * cap: the server never commits to spending more than the day allows, and the
 * reservation is released as the run finishes and its real cost lands in
 * `spend` instead.
 *
 * That makes the check conservative — a day of cheap runs leaves budget on the
 * table while they are running — which is the correct direction to be wrong in
 * for a number whose whole job is to bound a stranger's ability to spend.
 */
export function budgetAllows(input: BudgetInput): BudgetVerdict {
  const { spend, inFlight, maxRunCostUsd, maxDailyCostUsd } = input;
  const committedUsd = spend.spentUsd + inFlight * maxRunCostUsd;
  const wouldCommit = committedUsd + maxRunCostUsd;
  const floor = spend.unpriced === 0 ? '' : ` (${spend.unpriced} turn(s) reported no price, so today's spend is a floor)`;

  if (wouldCommit > maxDailyCostUsd) {
    return {
      ok: false,
      committedUsd,
      detail:
        `daily budget reached: ${formatCost(spend.spentUsd)} spent today across ${spend.runs} unattended run(s)` +
        (inFlight === 0 ? '' : `, ${formatCost(inFlight * maxRunCostUsd)} held for ${inFlight} in flight`) +
        `, and another run could take it to ${formatCost(wouldCommit)} of ${formatCost(maxDailyCostUsd)}${floor}`,
    };
  }

  return {
    ok: true,
    committedUsd,
    detail: `${formatCost(committedUsd)} of ${formatCost(maxDailyCostUsd)} committed today${floor}`,
  };
}
