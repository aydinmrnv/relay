'use client';

import Link from 'next/link';
import { Cable, CircleDollarSign, Play, Workflow } from 'lucide-react';
import { NumberTicker } from '@/components/21st/number-ticker';
import { HelpTip } from '@/components/app/help-tip';
import { Stagger, StaggerItem } from '@/components/motion/fade-in';
import { useCalmMotion } from '@/components/motion/use-calm-motion';
import type { Term } from '@/lib/glossary';
import { cn } from '@/lib/utils';

interface Tile {
  href: string;
  label: string;
  icon: React.ReactNode;
  term: Term;
  value: number;
  prefix?: string;
  decimals?: number;
  hint: React.ReactNode;
}

interface Props {
  workflows: number;
  enabled: number;
  broken: number;
  runs: number;
  previousRuns: number;
  successRate: number | null;
  finished: number;
  spend: number;
  connected: number;
  catalog: number;
}

/** The four numbers the dashboard leads with. Each tile opens the page behind it. */
export function KpiTiles(props: Props) {
  const reduce = useCalmMotion();
  const delta = props.runs - props.previousRuns;
  const tiles: Tile[] = [
    {
      href: '/workflows',
      label: 'Workflows',
      icon: <Workflow />,
      term: 'workflow',
      value: props.workflows,
      hint:
        props.workflows === 0 ? (
          'None yet — start from a template'
        ) : (
          <>
            {props.enabled} enabled
            {props.broken > 0 ? <span className="text-destructive"> · {props.broken} need fixes</span> : ' · all valid'}
          </>
        ),
    },
    {
      href: '/runs',
      label: 'Runs this week',
      icon: <Play />,
      term: 'run',
      value: props.runs,
      hint:
        props.successRate === null ? (
          'No finished runs in the last 7 days'
        ) : (
          <>
            {props.successRate}% of {props.finished} succeeded
            {props.previousRuns > 0 || delta !== 0 ? <span> · {delta === 0 ? 'same as' : `${delta > 0 ? '+' : '−'}${Math.abs(delta)} vs`} last week</span> : null}
          </>
        ),
    },
    {
      href: '/runs',
      label: 'Simulated spend, 7 days',
      icon: <CircleDollarSign />,
      term: 'cost',
      value: props.spend,
      prefix: '$',
      decimals: 2,
      hint: props.runs === 0 ? 'Nothing played this week' : `≈ $${(props.spend / Math.max(1, props.runs)).toFixed(2)} per run · nothing was billed`,
    },
    {
      href: '/integrations',
      label: 'Connected apps',
      icon: <Cable />,
      term: 'connection',
      value: props.connected,
      hint: props.connected === 0 ? `None of ${props.catalog} yet — connect one` : `of ${props.catalog} in the catalog · markers, not real logins`,
    },
  ];

  return (
    <Stagger className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {tiles.map((tile) => (
        <StaggerItem key={tile.label} className="h-full">
          <div className="group relative flex h-full flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10 transition-shadow hover:ring-foreground/20">
            {/* The whole tile is a link, drawn underneath so the help button above it stays its own control. */}
            <Link href={tile.href} className="absolute inset-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/50" aria-label={`${tile.label}: open ${tile.href.slice(1)}`} />
            <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
              <span className="flex items-center gap-2 [&_svg]:size-4">
                {tile.icon}
                {tile.label}
              </span>
              <HelpTip term={tile.term} className="relative z-10" />
            </div>
            <p className="text-3xl font-semibold tracking-tight">
              {tile.prefix}
              {/* The ticker counts up on a spring; with reduced motion the number is simply there. */}
              {reduce === true ? (
                tile.value.toLocaleString('en-US', { minimumFractionDigits: tile.decimals ?? 0, maximumFractionDigits: tile.decimals ?? 0 })
              ) : (
                <NumberTicker value={tile.value} decimalPlaces={tile.decimals ?? 0} className={cn('tracking-tight text-foreground normal-nums dark:text-foreground')} />
              )}
            </p>
            <p className="text-xs text-muted-foreground">{tile.hint}</p>
          </div>
        </StaggerItem>
      ))}
    </Stagger>
  );
}
