'use client';

import Link from 'next/link';
import { Play, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { StatusBadge } from '@/components/app/status-badge';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { useStudio } from '@/lib/store';
import { getConnector } from '@/lib/connectors';
import { formatDateTime, formatDuration, formatUsd } from '@/lib/format';

export default function RunsPage() {
  const runs = useStudio((state) => state.runs);
  const hydrated = useStudio((state) => state.hydrated);
  const clearRuns = useStudio((state) => state.clearRuns);

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Runs</h1>
          <p className="text-sm text-muted-foreground">Every simulated run, newest first. Click one for the phase-by-phase log.</p>
        </div>
        {runs.length > 0 ? (
          <Button variant="outline" onClick={clearRuns}>
            <Trash2 data-icon="inline-start" /> Clear history
          </Button>
        ) : null}
      </div>
      {!hydrated ? null : runs.length === 0 ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Play />
            </EmptyMedia>
            <EmptyTitle>No runs yet</EmptyTitle>
            <EmptyDescription>Open a workflow and press Test run.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Workflow</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead className="text-right">Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => {
                const connector = getConnector(run.trigger.connectorId);
                return (
                  <TableRow key={run.id}>
                    <TableCell>
                      <Link href={`/runs/${run.id}`} className="flex items-center gap-2">
                        <StatusBadge status={run.status} />
                        <span className="font-mono text-xs text-muted-foreground">{run.shortId}</span>
                      </Link>
                    </TableCell>
                    <TableCell className="font-medium">
                      <Link href={`/runs/${run.id}`}>{run.workflowName}</Link>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        {connector === undefined ? null : <ConnectorIcon connector={connector} size={14} variant="mark" />}
                        <span className="max-w-64 truncate">{String(run.trigger.payload['title'] ?? run.trigger.label)}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {run.prUrl !== undefined ? (
                        <a href={run.prUrl} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline">
                          PR #{run.prUrl.split('/').pop()}
                        </a>
                      ) : run.branch !== undefined ? (
                        <span className="font-mono text-xs">{run.branch}</span>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatUsd(run.costUsd)}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{formatDuration(run.startedAt, run.finishedAt)}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{formatDateTime(run.startedAt)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
