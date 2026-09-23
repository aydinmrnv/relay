'use client';

import Link from 'next/link';
import { use } from 'react';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useStudio } from '@/lib/store';
import { StatusBadge } from '@/components/app/status-badge';
import { RunTimeline } from '@/components/runs/run-timeline';
import { PhaseList } from '@/components/runs/phase-list';
import { formatDateTime, formatDuration, formatUsd } from '@/lib/format';

export default function RunDetailPage({ params }: PageProps<'/runs/[id]'>) {
  const { id } = use(params);
  const run = useStudio((state) => state.runs.find((candidate) => candidate.id === id));
  const workflow = useStudio((state) => (run === undefined ? undefined : state.workflows[run.workflowId]));
  const hydrated = useStudio((state) => state.hydrated);

  if (!hydrated) return null;
  if (run === undefined) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">That run is not in this browser’s history.</p>
        <Button variant="outline" nativeButton={false} render={<Link href="/runs" />}>
          <ArrowLeft data-icon="inline-start" /> All runs
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="icon-sm" nativeButton={false} render={<Link href="/runs" />} aria-label="Back">
            <ArrowLeft />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">{run.workflowName}</h1>
              <StatusBadge status={run.status} />
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              <span className="font-mono">{run.shortId}</span> · {run.trigger.label} · started {formatDateTime(run.startedAt)} · {formatDuration(run.startedAt, run.finishedAt)}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          {workflow !== undefined ? (
            <Button variant="outline" nativeButton={false} render={<Link href={`/workflows/${workflow.id}`} />}>
              Open workflow
            </Button>
          ) : null}
          {run.prUrl !== undefined ? (
            <Button nativeButton={false} render={<a href={run.prUrl} target="_blank" rel="noreferrer" />}>
              Pull request <ExternalLink data-icon="inline-end" />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Fact label="Cost" value={formatUsd(run.costUsd)} hint="what the CLIs reported, summed per phase" />
        <Fact label="Diff" value={run.diff === undefined ? '—' : `+${run.diff.additions} −${run.diff.deletions}`} hint={run.diff === undefined ? 'no code written' : `${run.diff.files} files, computed from git`} />
        <Fact label="Tests" value={run.tests === undefined ? 'skipped' : run.tests.passed ? 'passed' : 'failed'} hint={run.tests === undefined ? '' : run.tests.command} />
        <Fact label="Branch" value={run.branch ?? '—'} hint={run.prUrl === undefined ? 'not published' : 'pushed and opened as PR'} mono />
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Timeline</CardTitle>
            <CardDescription>Every node the run touched, in order, with what it did.</CardDescription>
          </CardHeader>
          <CardContent>
            <RunTimeline run={run} workflow={workflow} />
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Pipeline phases</CardTitle>
            <CardDescription>{run.phases.length === 0 ? 'The pipeline did not run.' : 'Where the time and money went.'}</CardDescription>
          </CardHeader>
          <CardContent>
            <PhaseList phases={run.phases} />
            {run.trigger.payload !== undefined ? (
              <details className="mt-6 text-xs">
                <summary className="cursor-pointer text-muted-foreground">Trigger payload</summary>
                <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-muted p-3 font-mono text-[11px]">{JSON.stringify(run.trigger.payload, null, 2)}</pre>
              </details>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Fact({ label, value, hint, mono }: { label: string; value: string; hint: string; mono?: boolean }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className={mono ? 'truncate font-mono text-sm' : 'text-xl tabular-nums'}>{value}</CardTitle>
      </CardHeader>
      <CardContent className="truncate text-xs text-muted-foreground">{hint}</CardContent>
    </Card>
  );
}
