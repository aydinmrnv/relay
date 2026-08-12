import type { AgentUsage } from '../agents/types.ts';
import type { Phase } from './phases.ts';

/**
 * Token and cost totals for a bucket of agent turns — a phase, or a whole run.
 *
 * `costUsd` is absent, not zero, when nothing in the bucket reported a price:
 * Codex does not publish one, so a run driven mostly by Codex has real token
 * counts and only a partial cost. Reporting `$0.00` there would be a lie.
 */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  /** Agent turns folded into these totals. */
  turns: number;
}

export interface RunUsage {
  total: UsageTotals;
  byPhase: Partial<Record<Phase, UsageTotals>>;
}

export function zeroTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, turns: 0 };
}

export function emptyRunUsage(): RunUsage {
  return { total: zeroTotals(), byPhase: {} };
}

/** Folds one turn into a bucket, leaving cost absent until one is reported. */
export function addUsage(totals: UsageTotals, usage: AgentUsage): UsageTotals {
  const costUsd = usage.costUsd === undefined ? totals.costUsd : (totals.costUsd ?? 0) + usage.costUsd;
  return {
    inputTokens: totals.inputTokens + usage.inputTokens,
    outputTokens: totals.outputTokens + usage.outputTokens,
    turns: totals.turns + 1,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

/**
 * Records a turn against both the run total and the phase it ran in. Returns
 * the (possibly newly created) accumulator so callers can assign it to state.
 */
export function recordTurnUsage(current: RunUsage | undefined, phase: Phase, usage: AgentUsage): RunUsage {
  const run = current ?? emptyRunUsage();
  run.total = addUsage(run.total, usage);
  run.byPhase[phase] = addUsage(run.byPhase[phase] ?? zeroTotals(), usage);
  return run;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

/** Sub-cent costs keep four decimals; a rounded `$0.00` reads as free. */
export function formatCost(usd: number): string {
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** e.g. `12.3k in / 4.1k out · $0.42 · 6 turns`. */
export function formatUsage(totals: UsageTotals): string {
  const parts = [`${formatTokens(totals.inputTokens)} in / ${formatTokens(totals.outputTokens)} out`];
  if (totals.costUsd !== undefined) parts.push(formatCost(totals.costUsd));
  parts.push(`${totals.turns} turn${totals.turns === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
