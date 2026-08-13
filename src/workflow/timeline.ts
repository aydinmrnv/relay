import { DISPLAY_PHASES, displayPhaseFor, isTerminal, type Phase } from './phases.ts';
import type { RunState } from './state.ts';
import { unpricedTurns } from './usage.ts';

export interface PhaseTiming {
  phase: Phase;
  /** Total wall-clock time in the phase, summed across revision rounds. */
  ms: number;
  /** How many times the run entered it — 2 means one revision round. */
  visits: number;
}

/**
 * How long each phase took, reconstructed from the run's own transition history
 * rather than from a timer the renderer happened to keep. A resumed run and a
 * run inspected days later therefore report the same numbers as a live one.
 *
 * Revision phases are folded into the review they belong to, matching the
 * progress display: `REVISING_PLAN` time is plan-review time.
 */
export function phaseTimings(state: RunState): PhaseTiming[] {
  const totals = new Map<Phase, { ms: number; visits: number }>();
  const history = state.history;
  const end = new Date(state.finishedAt ?? state.updatedAt).getTime();

  for (const [index, entry] of history.entries()) {
    const display = displayPhaseFor(entry.phase);
    if (display === undefined) continue;

    const startedAt = new Date(entry.at).getTime();
    const next = history[index + 1];
    const finishedAt = next === undefined ? end : new Date(next.at).getTime();
    if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) continue;

    const current = totals.get(display) ?? { ms: 0, visits: 0 };
    totals.set(display, {
      ms: current.ms + Math.max(0, finishedAt - startedAt),
      visits: current.visits + 1,
    });
  }

  // Emitted in workflow order, not in the order the map happened to fill.
  return DISPLAY_PHASES.flatMap((phase) => {
    const total = totals.get(phase);
    return total === undefined ? [] : [{ phase, ms: total.ms, visits: total.visits }];
  });
}

export interface PhaseCost {
  /** Reported cost, absent when nothing in the phase published a price. */
  usd?: number;
  /** Turns in the phase that reported none, so `usd` is a floor. */
  unpriced: number;
}

/**
 * What each phase cost, folded the same way its duration is: a revision round
 * is part of the review that asked for it. Keyed by display phase, so a caller
 * comparing two runs is comparing the same buckets whatever rounds each took.
 */
export function phaseCosts(state: RunState): Map<Phase, PhaseCost> {
  const totals = new Map<Phase, PhaseCost>();
  for (const [phase, usage] of Object.entries(state.usage?.byPhase ?? {})) {
    const display = displayPhaseFor(phase as Phase);
    if (display === undefined || usage === undefined) continue;

    const current = totals.get(display) ?? { unpriced: 0 };
    const usd = usage.costUsd === undefined ? current.usd : (current.usd ?? 0) + usage.costUsd;
    totals.set(display, {
      ...(usd === undefined ? {} : { usd }),
      unpriced: current.unpriced + unpricedTurns(usage),
    });
  }
  return totals;
}

/** Wall-clock time a run has been alive, finished or not. */
export function runElapsedMs(state: RunState): number {
  return new Date(state.finishedAt ?? state.updatedAt).getTime() - new Date(state.createdAt).getTime();
}

/** The phase a failed run died in, or undefined when it did not fail. */
export function failedPhase(state: RunState): Phase | undefined {
  if (state.phase !== 'FAILED') return undefined;
  return state.error?.phase ?? lastNonTerminal(state);
}

function lastNonTerminal(state: RunState): Phase | undefined {
  for (let index = state.history.length - 1; index >= 0; index -= 1) {
    const phase = state.history[index]?.phase;
    if (phase !== undefined && !isTerminal(phase)) return phase;
  }
  return undefined;
}
