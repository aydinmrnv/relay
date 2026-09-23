'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { useCalmMotion } from '@/components/motion/use-calm-motion';
import { ChevronRight, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { StatusBadge } from '@/components/app/status-badge';
import { RunResult, RunTrigger } from '@/components/runs/run-bits';
import { formatRunDuration } from '@/components/runs/run-utils';
import { formatUsd, timeAgo } from '@/lib/format';
import type { Run } from '@/lib/workflow/schema';

/** The latest runs, each a link to its timeline. A playing run shows its current step and moves as it plays. */
export function RecentRuns({ runs, total, now, onTest, testLabel, className }: { runs: Run[]; total: number; now: number; onTest?: () => void; testLabel?: string; className?: string }) {
  const reduce = useCalmMotion();
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Recent runs</CardTitle>
        <CardDescription>Simulated end to end: the phases, costs and refusals are what the real pipeline would report.</CardDescription>
        {total > 0 ? (
          <CardAction>
            <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/runs" />}>
              All {total} <ChevronRight data-icon="inline-end" />
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        {runs.length === 0 ? (
          <Empty className="border py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Play />
              </EmptyMedia>
              <EmptyTitle>No runs yet</EmptyTitle>
              <EmptyDescription>A test run plays a workflow here with a sample ticket, so you can see every step before anything real is wired up.</EmptyDescription>
            </EmptyHeader>
            {onTest !== undefined ? (
              <EmptyContent>
                <Button size="sm" onClick={onTest}>
                  <Play data-icon="inline-start" /> {testLabel ?? 'Play a test run'}
                </Button>
              </EmptyContent>
            ) : null}
          </Empty>
        ) : (
          <ul className="-mx-2 flex flex-col">
            {runs.map((run) => (
              <motion.li key={run.id} initial={reduce ? false : { opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
                <Link
                  href={`/runs/${run.id}`}
                  className="group grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 rounded-lg px-2 py-2.5 outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 sm:grid-cols-[6.5rem_minmax(0,1fr)_minmax(0,14rem)_auto]"
                >
                  <StatusBadge status={run.status} className="w-fit" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{run.workflowName}</p>
                    <RunTrigger run={run} className="text-xs" />
                  </div>
                  <RunResult run={run} linkPr={false} className="col-span-3 col-start-1 row-start-2 sm:col-span-1 sm:col-start-3 sm:row-start-1" />
                  <div className="col-start-3 row-start-1 text-right text-xs text-muted-foreground tabular-nums sm:col-start-4">
                    <p className="text-foreground">{formatUsd(run.costUsd)}</p>
                    <p>{run.status === 'running' ? formatRunDuration(run) : timeAgo(run.startedAt, now)}</p>
                  </div>
                </Link>
              </motion.li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
