'use client';

import Link from 'next/link';
import { ChevronDown, ChevronUp, ExternalLink, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { StatusBadge } from '@/components/app/status-badge';
import { RunTimeline } from '@/components/runs/run-timeline';
import type { Run, Workflow } from '@/lib/workflow/schema';
import { formatUsd } from '@/lib/format';

interface Props {
  run: Run | null;
  workflow: Workflow;
  running: boolean;
  open: boolean;
  onToggle: () => void;
  onCancel: () => void;
}

export function RunPanel({ run, workflow, running, open, onToggle, onCancel }: Props) {
  return (
    <div className="flex flex-col border-t bg-card">
      <div className="flex h-9 items-center gap-2 px-3">
        <button type="button" onClick={onToggle} className="flex items-center gap-1.5 text-xs font-medium">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          Test run
        </button>
        {run === null ? (
          <span className="text-xs text-muted-foreground">Press “Test run” to simulate this workflow. It costs nothing.</span>
        ) : (
          <>
            <StatusBadge status={run.status} className="h-5" />
            <span className="truncate text-xs text-muted-foreground">
              {run.trigger.label} · {String(run.trigger.payload['title'] ?? '')}
            </span>
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">{formatUsd(run.costUsd)}</span>
            {run.prUrl !== undefined ? (
              <a href={run.prUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-primary">
                PR <ExternalLink className="size-3" />
              </a>
            ) : null}
            {running ? (
              <Button size="xs" variant="outline" onClick={onCancel}>
                <Square data-icon="inline-start" /> Stop
              </Button>
            ) : (
              <Button size="xs" variant="ghost" nativeButton={false} render={<Link href={`/runs/${run.id}`} />}>
                Details
              </Button>
            )}
          </>
        )}
      </div>
      {open && run !== null ? (
        <ScrollArea className="h-56 border-t">
          <div className="p-3">
            <RunTimeline run={run} workflow={workflow} compact />
          </div>
        </ScrollArea>
      ) : null}
    </div>
  );
}
