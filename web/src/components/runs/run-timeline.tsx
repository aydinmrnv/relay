'use client';

import { Fragment } from 'react';
import { CheckCircle2, CircleDashed, CircleDollarSign, FileText, Loader2, MessageSquare, ShieldAlert, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getNodeType } from '@/lib/connectors';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import type { Run, RunEvent, Workflow } from '@/lib/workflow/schema';
import { formatMs } from '@/lib/workflow/simulate';

export function RunTimeline({ run, workflow, compact = false }: { run: Run; workflow?: Workflow; compact?: boolean }) {
  const nodeById = new Map((workflow?.nodes ?? []).map((node) => [node.id, node]));
  const groups: Array<{ nodeId: string | null; events: RunEvent[] }> = [];
  for (const event of run.events) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.nodeId === event.nodeId) last.events.push(event);
    else groups.push({ nodeId: event.nodeId, events: [event] });
  }

  return (
    <ol className={cn('relative flex flex-col', compact ? 'gap-2' : 'gap-4')}>
      {groups.map((group, index) => {
        const node = group.nodeId === null ? undefined : nodeById.get(group.nodeId);
        const def = node === undefined ? undefined : getNodeType(node.data.typeId);
        const finished = group.events.find((event) => event.kind === 'node-finished');
        const status = finished?.status ?? group.events[group.events.length - 1]?.status ?? 'running';
        const title = group.nodeId === null ? 'Run' : def === undefined ? group.nodeId : node?.data.label ?? `${def.connector.name} · ${def.name}`;
        return (
          <li key={`${group.nodeId ?? 'run'}-${index}`} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-full border bg-card', ring(status))}>
                {def === undefined ? <StatusIcon status={status} /> : <ConnectorIcon connector={def.connector} size={13} variant="mark" />}
              </span>
              {index < groups.length - 1 ? <span className="mt-1 w-px flex-1 bg-border" /> : null}
            </div>
            <div className="min-w-0 flex-1 pb-1">
              <div className="flex items-center justify-between gap-2">
                <p className={cn('truncate text-sm font-medium', status === 'skipped' ? 'text-muted-foreground line-through' : '')}>{title}</p>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <StatusIcon status={status} />
                  {finished?.durationMs !== undefined ? formatMs(finished.durationMs) : null}
                </span>
              </div>
              <ul className={cn('mt-1 flex flex-col', compact ? 'gap-0.5' : 'gap-1')}>
                {group.events
                  .filter((event) => event.kind !== 'node-started')
                  .map((event, eventIndex) => (
                    <Fragment key={eventIndex}>
                      <li className="flex items-start gap-1.5 text-xs">
                        <EventIcon event={event} />
                        <span className={cn('min-w-0 flex-1', event.status === 'failed' || event.status === 'refused' ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground')}>
                          {event.message}
                        </span>
                      </li>
                      {!compact && event.detail !== undefined && event.detail.length > 0 ? (
                        <li>
                          <pre className="ml-5 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[11px] text-muted-foreground">{event.detail}</pre>
                        </li>
                      ) : null}
                    </Fragment>
                  ))}
              </ul>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function ring(status: string): string {
  switch (status) {
    case 'done':
    case 'succeeded':
      return 'border-emerald-500/50';
    case 'failed':
      return 'border-red-500/60';
    case 'refused':
      return 'border-amber-500/60';
    case 'running':
      return 'border-blue-500/60';
    case 'waiting':
      return 'border-violet-500/60';
    default:
      return 'border-border';
  }
}

function StatusIcon({ status }: { status: string }) {
  const cls = 'size-3.5';
  switch (status) {
    case 'done':
    case 'succeeded':
      return <CheckCircle2 className={cn(cls, 'text-emerald-600')} />;
    case 'failed':
      return <XCircle className={cn(cls, 'text-red-600')} />;
    case 'refused':
      return <ShieldAlert className={cn(cls, 'text-amber-600')} />;
    case 'running':
      return <Loader2 className={cn(cls, 'animate-spin text-blue-600')} />;
    default:
      return <CircleDashed className={cn(cls, 'text-muted-foreground')} />;
  }
}

function EventIcon({ event }: { event: RunEvent }) {
  const cls = 'mt-0.5 size-3 shrink-0 text-muted-foreground';
  switch (event.kind) {
    case 'phase':
      return event.status === 'running' ? <Loader2 className={cn(cls, 'animate-spin')} /> : event.status === 'failed' ? <XCircle className={cn(cls, 'text-red-500')} /> : <CheckCircle2 className={cn(cls, 'text-emerald-600')} />;
    case 'cost':
      return <CircleDollarSign className={cls} />;
    case 'artifact':
      return <FileText className={cls} />;
    case 'message':
      return <MessageSquare className={cls} />;
    case 'node-finished':
      return event.status === 'failed' || event.status === 'refused' ? <XCircle className={cn(cls, 'text-red-500')} /> : <CheckCircle2 className={cn(cls, 'text-emerald-600')} />;
    default:
      return <CircleDashed className={cls} />;
  }
}
