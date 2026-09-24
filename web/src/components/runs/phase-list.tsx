'use client';

import { useState } from 'react';
import { motion } from 'motion/react';
import { useCalmMotion } from '@/components/motion/use-calm-motion';
import { TextShimmer } from '@/components/21st/text-shimmer';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import type { RunPhase } from '@/lib/workflow/schema';
import { formatMs, usd } from '@/lib/workflow/simulate';

type Measure = 'time' | 'cost';

interface Props {
  phases: RunPhase[];
  /** The phase playing right now, from the latest `phase` event. Shown as an open row. */
  current?: string | null;
  className?: string;
}

/** Phase names that are review rounds, and what to call a round of each. */
const ROUNDED: Record<string, string> = { REVIEWING_PLAN: 'plan', REVISING_PLAN: 'plan', REVIEWING_CODE: 'code', REVISING_CODE: 'code' };

/**
 * Where the pipeline's time and money went, one bar per phase. The bar is the
 * phase's share of the whole run — by time or by cost, switchable — so the
 * expensive step is obvious at a glance.
 */
export function PhaseList({ phases, current = null, className }: Props) {
  const reduce = useCalmMotion();
  const [measure, setMeasure] = useState<Measure>('time');
  if (phases.length === 0 && current === null) return null;

  const totalMs = phases.reduce((sum, phase) => sum + phase.ms, 0);
  const totalCost = phases.reduce((sum, phase) => sum + (phase.costUsd ?? 0), 0);
  const shown: Measure = totalCost > 0 ? measure : 'time';
  const total = shown === 'time' ? totalMs : totalCost;

  // Number each repeat of a review phase, so "Code review · round 2" says what happened.
  const seen = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const phase of phases) counts.set(phase.phase, (counts.get(phase.phase) ?? 0) + 1);
  const planRounds = counts.get('REVIEWING_PLAN') ?? 0;
  const codeRounds = counts.get('REVIEWING_CODE') ?? 0;

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {totalCost > 0 ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">Bar = share of the run&rsquo;s {shown === 'time' ? 'time' : 'cost'}</p>
          <ToggleGroup
            value={[shown]}
            onValueChange={(next: string[]) => {
              const value = next[0];
              if (value === 'time' || value === 'cost') setMeasure(value);
            }}
            variant="outline"
            size="sm"
            spacing={0}
            aria-label="Measure phases by"
          >
            <ToggleGroupItem value="time" className="px-2.5 text-xs">
              Time
            </ToggleGroupItem>
            <ToggleGroupItem value="cost" className="px-2.5 text-xs">
              Cost
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      ) : null}

      <ul className="flex flex-col gap-3">
        {phases.map((phase, index) => {
          const value = shown === 'time' ? phase.ms : (phase.costUsd ?? 0);
          const share = total === 0 ? 0 : (value / total) * 100;
          const round = (seen.get(phase.phase) ?? 0) + 1;
          seen.set(phase.phase, round);
          const showRound = ROUNDED[phase.phase] !== undefined && (counts.get(phase.phase) ?? 0) > 1;
          const failed = phase.status === 'failed';
          return (
            <li key={`${phase.phase}-${index}`} className="grid gap-1.5">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className={cn('truncate font-medium', failed ? 'text-destructive' : '')}>
                    {phase.label}
                    {showRound ? <span className="font-normal text-muted-foreground"> · round {round}</span> : null}
                  </span>
                  {phase.agent !== undefined ? <span className="shrink-0 truncate text-xs text-muted-foreground">{phase.agent}</span> : null}
                </span>
                <span className="flex shrink-0 items-baseline gap-2 text-xs tabular-nums">
                  <span className={shown === 'time' ? 'text-foreground' : 'text-muted-foreground'}>{formatMs(phase.ms)}</span>
                  <span className={shown === 'cost' ? 'text-foreground' : 'text-muted-foreground'}>{(phase.costUsd ?? 0) > 0 ? usd(phase.costUsd ?? 0) : '—'}</span>
                </span>
              </div>
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-primary/10"
                role="meter"
                aria-label={`${phase.label}: ${Math.round(share)}% of the run's ${shown}`}
                aria-valuenow={Math.round(share)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <motion.div
                  className={cn('h-full rounded-full', failed ? 'bg-destructive' : 'bg-primary')}
                  initial={reduce ? false : { width: 0 }}
                  animate={{ width: `${share === 0 ? 0 : Math.max(1.5, share)}%` }}
                  transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                />
              </div>
            </li>
          );
        })}

        {current !== null ? (
          <li className="grid gap-1.5">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <TextShimmer as="span" duration={1.8} className="truncate font-medium">
                {current}
              </TextShimmer>
              <span className="shrink-0 text-xs text-muted-foreground">playing</span>
            </div>
            <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-primary/10">
              <div className="absolute inset-y-0 left-0 w-1/3 animate-pulse rounded-full bg-primary/40" />
            </div>
          </li>
        ) : null}
      </ul>

      {phases.length > 0 ? (
        <div className="flex flex-col gap-1 border-t pt-3 text-xs text-muted-foreground">
          <div className="flex items-center justify-between">
            <span>Total{current !== null ? ' so far' : ''}</span>
            <span className="tabular-nums text-foreground">
              {formatMs(totalMs)} · {usd(totalCost)}
            </span>
          </div>
          {planRounds + codeRounds > 0 ? (
            <p>
              {planRounds > 0 ? `Plan reviewed in ${planRounds} ${planRounds === 1 ? 'round' : 'rounds'}` : 'No plan review'}
              {' · '}
              {codeRounds > 0 ? `code reviewed in ${codeRounds} ${codeRounds === 1 ? 'round' : 'rounds'}` : 'no code review'}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
