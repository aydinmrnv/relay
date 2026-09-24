import { getNodeType } from '@/lib/connectors';
import type { Run, Workflow } from '@/lib/workflow/schema';
import { validateWorkflow } from '@/lib/workflow/validate';
import { isLive, outcomeReason } from '@/components/runs/run-utils';

/**
 * Everything the dashboard shows, computed from the store in one place so the
 * tiles, the chart and the lists agree on what "this week" and "today" mean.
 */

const DAY = 86_400_000;

export type Outcome = 'succeeded' | 'refused' | 'failed' | 'cancelled';
export const OUTCOMES: Outcome[] = ['succeeded', 'refused', 'failed', 'cancelled'];

export interface DayBucket {
  /** yyyy-mm-dd in local time. */
  key: string;
  /** Short axis label, e.g. "Sep 21". */
  label: string;
  /** Long label for tooltips and the table, e.g. "Mon, Sep 21". */
  long: string;
  succeeded: number;
  refused: number;
  failed: number;
  cancelled: number;
  total: number;
}

function localKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function startOfToday(now: number): Date {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Finished runs per local day for the last `days` days, oldest first. Live runs have no outcome yet and are left out. */
export function dailyOutcomes(runs: Run[], now: number, days = 14): DayBucket[] {
  const today = startOfToday(now);
  const buckets: DayBucket[] = [];
  const byKey = new Map<string, DayBucket>();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    // Built from calendar fields, not by subtracting 24h, so a DST change cannot skip or repeat a day.
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    const bucket: DayBucket = {
      key: localKey(date),
      label: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      long: date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
      succeeded: 0,
      refused: 0,
      failed: 0,
      cancelled: 0,
      total: 0,
    };
    buckets.push(bucket);
    byKey.set(bucket.key, bucket);
  }
  for (const run of runs) {
    if (isLive(run.status)) continue;
    const bucket = byKey.get(localKey(new Date(run.startedAt)));
    if (bucket === undefined) continue;
    bucket[run.status] += 1;
    bucket.total += 1;
  }
  return buckets;
}

export interface WeekStats {
  runs: number;
  finished: number;
  succeeded: number;
  successRate: number | null;
  spend: number;
  previousRuns: number;
}

export function weekStats(runs: Run[], now: number): WeekStats {
  const weekAgo = now - 7 * DAY;
  const twoWeeksAgo = now - 14 * DAY;
  let count = 0;
  let finished = 0;
  let succeeded = 0;
  let spend = 0;
  let previousRuns = 0;
  for (const run of runs) {
    const at = new Date(run.startedAt).getTime();
    if (at > weekAgo) {
      count += 1;
      spend += run.costUsd;
      if (!isLive(run.status)) finished += 1;
      if (run.status === 'succeeded') succeeded += 1;
    } else if (at > twoWeeksAgo) {
      previousRuns += 1;
    }
  }
  return { runs: count, finished, succeeded, successRate: finished === 0 ? null : Math.round((succeeded / finished) * 100), spend, previousRuns };
}

export interface SpendRow {
  workflowId: string;
  name: string;
  spend: number;
  runs: number;
}

/** Simulated spend per workflow over the last 7 days, largest first; the tail folds into one row. */
export function spendByWorkflow(runs: Run[], workflows: Record<string, Workflow>, now: number, limit = 5): { rows: SpendRow[]; other: SpendRow | null; total: number } {
  const weekAgo = now - 7 * DAY;
  const map = new Map<string, SpendRow>();
  for (const run of runs) {
    if (new Date(run.startedAt).getTime() <= weekAgo) continue;
    const row = map.get(run.workflowId) ?? { workflowId: run.workflowId, name: workflows[run.workflowId]?.name ?? run.workflowName, spend: 0, runs: 0 };
    row.spend += run.costUsd;
    row.runs += 1;
    map.set(run.workflowId, row);
  }
  const sorted = [...map.values()].filter((row) => row.spend > 0).sort((a, b) => b.spend - a.spend);
  const total = sorted.reduce((sum, row) => sum + row.spend, 0);
  if (sorted.length <= limit) return { rows: sorted, other: null, total };
  const rest = sorted.slice(limit - 1);
  return {
    rows: sorted.slice(0, limit - 1),
    other: { workflowId: '', name: `${rest.length} other workflows`, spend: rest.reduce((sum, row) => sum + row.spend, 0), runs: rest.reduce((sum, row) => sum + row.runs, 0) },
    total,
  };
}

export const FALLBACK_DAILY_CEILING = 40;

export interface Ceiling {
  /** The tightest daily ceiling set on any Budget gate, or the fallback. */
  usd: number;
  /** Which workflow set it; undefined when falling back. */
  source?: { id: string; name: string };
  /** How many workflows have a Budget gate at all. */
  guarded: number;
  /** Enabled workflows whose pipeline has no Budget gate in front of it. */
  unguarded: number;
}

/**
 * The daily spending ceiling to measure today's spend against: the lowest
 * `maxDailyCostUsd` on any Budget gate, because that is where the first gate
 * starts refusing runs.
 */
export function dailyCeiling(workflows: Workflow[]): Ceiling {
  let best: Ceiling['source'];
  let usd = Number.POSITIVE_INFINITY;
  let guarded = 0;
  let unguarded = 0;
  for (const workflow of workflows) {
    const gates = workflow.nodes.filter((node) => getNodeType(node.data.typeId)?.id === 'gates.action.budget');
    const hasPipeline = workflow.nodes.some((node) => getNodeType(node.data.typeId)?.connectorId === 'pipeline');
    if (gates.length === 0) {
      if (workflow.enabled && hasPipeline) unguarded += 1;
      continue;
    }
    guarded += 1;
    for (const gate of gates) {
      const raw = gate.data.config['maxDailyCostUsd'];
      const value = raw === undefined || raw === null || raw === '' ? 25 : Number(raw);
      if (Number.isFinite(value) && value < usd) {
        usd = value;
        best = { id: workflow.id, name: workflow.name };
      }
    }
  }
  return best === undefined ? { usd: FALLBACK_DAILY_CEILING, guarded, unguarded } : { usd, source: best, guarded, unguarded };
}

export function spendToday(runs: Run[], now: number): number {
  const start = startOfToday(now).getTime();
  return runs.reduce((sum, run) => (new Date(run.startedAt).getTime() >= start ? sum + run.costUsd : sum), 0);
}

export type AttentionItem =
  | { kind: 'run'; id: string; href: string; status: 'failed' | 'refused'; title: string; reason: string; at: string; shortId: string }
  | { kind: 'workflow'; id: string; href: string; title: string; reason: string; errors: number };

/** Failed or refused runs from the last 7 days, newest first, then workflows that would not validate. */
export function attentionItems(runs: Run[], workflows: Workflow[], now: number): AttentionItem[] {
  const weekAgo = now - 7 * DAY;
  const items: AttentionItem[] = [];
  for (const run of runs) {
    if (run.status !== 'failed' && run.status !== 'refused') continue;
    if (new Date(run.startedAt).getTime() <= weekAgo) continue;
    items.push({ kind: 'run', id: run.id, href: `/runs/${run.id}`, status: run.status, title: run.workflowName, reason: outcomeReason(run), at: run.startedAt, shortId: run.shortId });
  }
  for (const workflow of workflows) {
    const result = validateWorkflow(workflow);
    if (result.ok) continue;
    const first = result.issues.find((issue) => issue.level === 'error');
    items.push({ kind: 'workflow', id: workflow.id, href: `/workflows/${workflow.id}`, title: workflow.name, reason: first?.message ?? 'The workflow does not validate.', errors: result.errors });
  }
  return items;
}
