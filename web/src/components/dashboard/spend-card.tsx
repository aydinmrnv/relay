'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { useCalmMotion } from '@/components/motion/use-calm-motion';
import { ShieldCheck, TriangleAlert } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { HelpTip } from '@/components/app/help-tip';
import { formatUsd } from '@/lib/format';
import { cn } from '@/lib/utils';
import { FALLBACK_DAILY_CEILING, type Ceiling, type SpendRow } from './derive';

interface Props {
  today: number;
  ceiling: Ceiling;
  rows: SpendRow[];
  other: SpendRow | null;
  weekTotal: number;
  className?: string;
}

/**
 * Today's simulated spend against the tightest Budget gate, and where this
 * week's spend went. Nothing here is billed; the point is to see what the
 * guardrails would see before a real run spends real money.
 */
export function SpendCard({ today, ceiling, rows, other, weekTotal, className }: Props) {
  const reduce = useCalmMotion();
  const ratio = ceiling.usd <= 0 ? 1 : today / ceiling.usd;
  const percent = Math.min(100, Math.round(ratio * 100));
  // The fill carries severity; the track is a lighter step of the same hue so the state reads across the whole bar.
  const tone = ratio >= 1 ? { fill: 'bg-destructive', track: 'bg-destructive/15' } : ratio >= 0.75 ? { fill: 'bg-warning', track: 'bg-warning/20' } : { fill: 'bg-primary', track: 'bg-primary/12' };
  const max = Math.max(...rows.map((row) => row.spend), other?.spend ?? 0, 0.01);

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          Spend <HelpTip term="cost" />
        </CardTitle>
        <CardDescription>What the coding CLIs would report. Simulated — nothing here was billed.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <section aria-labelledby="spend-today" className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <h3 id="spend-today" className="flex items-center gap-1.5 text-sm font-medium">
              Today <HelpTip term="budget" />
            </h3>
            <p className="text-sm">
              <span className="font-semibold">{formatUsd(today)}</span>
              <span className="text-muted-foreground"> of {formatUsd(ceiling.usd)}</span>
            </p>
          </div>
          <div className={cn('h-2 w-full overflow-hidden rounded-full', tone.track)} role="meter" aria-labelledby="spend-today" aria-valuenow={Math.round(today * 100) / 100} aria-valuemin={0} aria-valuemax={ceiling.usd}>
            <motion.div
              className={cn('h-full rounded-full', tone.fill)}
              initial={reduce ? false : { width: 0 }}
              animate={{ width: `${today === 0 ? 0 : Math.max(2, percent)}%` }}
              transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
          <p className="text-xs text-pretty text-muted-foreground">
            {ceiling.source !== undefined ? (
              <>
                Against the lowest daily ceiling on a Budget gate, set in{' '}
                <Link href={`/workflows/${ceiling.source.id}`} className="font-medium text-foreground underline-offset-4 hover:underline">
                  {ceiling.source.name}
                </Link>
                . {ratio >= 1 ? 'That gate would refuse new runs now.' : `${percent}% used; it refuses runs past the ceiling, never queues them.`}
              </>
            ) : (
              <>No workflow has a Budget gate, so this measures against {formatUsd(FALLBACK_DAILY_CEILING)}, the templates&rsquo; default. Add a Budget gate to set your own.</>
            )}
          </p>
          {ceiling.unguarded > 0 ? (
            <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-warning">
              <TriangleAlert className="mt-px size-3.5 shrink-0" />
              {ceiling.unguarded} enabled {ceiling.unguarded === 1 ? 'workflow runs' : 'workflows run'} the pipeline with no Budget gate in front.
            </p>
          ) : ceiling.guarded > 0 ? (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="mt-px size-3.5 shrink-0 text-success" />
              Every enabled pipeline sits behind a Budget gate.
            </p>
          ) : null}
        </section>

        <section aria-labelledby="spend-week" className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <h3 id="spend-week" className="text-sm font-medium">
              By workflow, last 7 days
            </h3>
            <span className="text-sm text-muted-foreground tabular-nums">{formatUsd(weekTotal)}</span>
          </div>
          {rows.length === 0 ? (
            <p className="text-xs text-muted-foreground">No spend this week. Only workflows with an agent pipeline or an AI step report a cost.</p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {[...rows, ...(other === null ? [] : [other])].map((row) => (
                <li key={row.workflowId || 'other'}>
                  <SpendBar row={row} max={max} reduce={reduce === true} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </CardContent>
    </Card>
  );
}

/** One workflow's share: a single-hue bar (these are names, not a scale) with the value at its end. */
function SpendBar({ row, max, reduce }: { row: SpendRow; max: number; reduce: boolean }) {
  const width = Math.max(2, (row.spend / max) * 100);
  const body = (
    <>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="truncate font-medium text-foreground group-hover:underline group-hover:underline-offset-4">{row.name}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {row.runs} {row.runs === 1 ? 'run' : 'runs'} · <span className="text-foreground">{formatUsd(row.spend)}</span>
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-primary/10">
        <motion.div className={cn('h-full rounded-full', row.workflowId === '' ? 'bg-muted-foreground/50' : 'bg-primary')} initial={reduce ? false : { width: 0 }} animate={{ width: `${width}%` }} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }} />
      </div>
    </>
  );
  if (row.workflowId === '') return <div>{body}</div>;
  return (
    <Link href={`/runs?workflow=${encodeURIComponent(row.workflowId)}`} className="group block rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50" aria-label={`${row.name}: ${formatUsd(row.spend)} over ${row.runs} runs. Open its runs.`}>
      {body}
    </Link>
  );
}
