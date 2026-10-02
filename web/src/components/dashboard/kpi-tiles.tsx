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
  /** The part of `spend` real runs reported. */
  realSpend: number;
  connected: number;
  /** Real connections the app accepted, markers, real ones it refused, and apps workflows use with no connection. */
  connections: { verified: number; marked: number; failing: number; missing: number };
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
    // Two different kinds of money. What test runs "cost" was never spent;
    // what real runs cost came out of somebody's Claude or ChatGPT plan. Once
    // there is any of the second, it leads, and the first is named beside it.
    props.realSpend > 0
      ? {
          href: '/runs',
          label: 'Real spend, 7 days',
          icon: <CircleDollarSign />,
          term: 'cost',
          value: props.realSpend,
          prefix: '$',
          decimals: 2,
          hint: `Reported by the coding CLIs, on your own plans${props.spend - props.realSpend > 0.005 ? ` · plus $${(props.spend - props.realSpend).toFixed(2)} simulated in test runs` : ''}`,
        }
      : {
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
      hint: <ConnectionsHint {...props.connections} catalog={props.catalog} />,
    },
  ];

  return (
    // One ruled strip rather than four floating cards: the rules are the 1px gaps showing the border colour through.
    <Stagger className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2 xl:grid-cols-4">
      {tiles.map((tile) => (
        <StaggerItem key={tile.label} className="h-full bg-card">
          <div className="group relative flex h-full flex-col gap-3 p-4 transition-colors hover:bg-muted/40">
            {/* The whole tile is a link, drawn underneath so the help button above it stays its own control. */}
            <Link href={tile.href} className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset" aria-label={`${tile.label}: open ${tile.href.slice(1)}`} />
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

function ConnectionsHint({ verified, marked, failing, missing, catalog }: Props['connections'] & { catalog: number }) {
  if (verified + marked + failing === 0) return missing > 0 ? <span className="text-amber-700 dark:text-warning">{missing} your workflows use, none connected</span> : <>None of {catalog} yet — connect one</>;
  const parts: React.ReactNode[] = [];
  if (failing > 0) parts.push(<span key="failing" className="text-destructive">{failing} failing</span>);
  if (verified > 0) parts.push(<span key="verified">{verified} live</span>);
  if (marked > 0) parts.push(<span key="marked">{marked} marked ready</span>);
  if (missing > 0) parts.push(<span key="missing" className="text-amber-700 dark:text-warning">{missing} still needed</span>);
  return (
    <>
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 ? ' · ' : null}
          {part}
        </span>
      ))}
    </>
  );
}
