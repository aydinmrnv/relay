'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, ShieldAlert, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getNodeType, type PortSpec } from '@/lib/connectors';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import type { CanvasNode } from './types';

const PORT_COLOR: Record<PortSpec['type'], string> = {
  event: 'bg-zinc-400 dark:bg-zinc-500',
  issue: 'bg-sky-500',
  run: 'bg-violet-500',
  change: 'bg-blue-600',
  message: 'bg-pink-500',
  any: 'bg-zinc-300 dark:bg-zinc-600',
};

export const PORT_LEGEND: Array<{ type: PortSpec['type']; label: string }> = [
  { type: 'issue', label: 'ticket' },
  { type: 'run', label: 'run' },
  { type: 'change', label: 'PR / branch' },
  { type: 'event', label: 'event' },
  { type: 'any', label: 'anything' },
];

function summarize(config: Record<string, unknown>, def: ReturnType<typeof getNodeType>): string | null {
  if (def === undefined) return null;
  const parts: string[] = [];
  for (const field of def.fields.slice(0, 3)) {
    const value = config[field.key];
    if (value === undefined || value === '' || value === null) continue;
    if (field.type === 'template' || field.type === 'textarea' || field.type === 'json') continue;
    if (field.type === 'boolean') {
      if (value === true) parts.push(field.label.toLowerCase());
      continue;
    }
    const option = field.options?.find((candidate) => candidate.value === value);
    parts.push(option?.label ?? String(value));
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

function WorkflowNodeView({ data, selected }: NodeProps<CanvasNode>) {
  const def = getNodeType(data.typeId);
  const status = data.status;
  const isNote = def?.id === 'logic.action.note';

  if (def === undefined) {
    return (
      <div className="wf-node w-64 rounded-xl border border-destructive bg-card p-3 text-sm">
        <p className="font-medium text-destructive">Unknown node</p>
        <p className="text-xs text-muted-foreground">{data.typeId}</p>
      </div>
    );
  }

  if (isNote) {
    return (
      <div className={cn('wf-node w-60 rounded-lg border border-amber-300/60 bg-amber-50 p-3 text-xs text-amber-900 shadow-sm dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100', selected ? 'ring-2 ring-amber-400' : '')}>
        <p className="whitespace-pre-wrap">{String(data.config['text'] ?? 'Note')}</p>
      </div>
    );
  }

  const color = def.connector.icon.color;
  const summary = summarize(data.config, def);
  const isTrigger = def.kind === 'trigger';

  return (
    <div
      className={cn(
        'wf-node group relative w-64 rounded-xl border bg-card shadow-sm transition-shadow',
        isTrigger ? 'border-l-4' : '',
        status === 'running' ? 'shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_25%,transparent)]' : '',
        status === 'failed' || status === 'refused' ? 'border-red-500/60' : '',
        status === 'done' ? 'border-emerald-500/50' : '',
        status === 'skipped' ? 'opacity-50' : '',
        data.invalid === true ? 'border-red-500/70' : '',
      )}
      style={isTrigger ? { borderLeftColor: color } : undefined}
    >
      {def.inputs.map((port, index) => (
        <Handle
          key={port.id}
          id={port.id}
          type="target"
          position={Position.Left}
          className={cn('!rounded-full', PORT_COLOR[port.type])}
          style={{ top: handleOffset(index, def.inputs.length) }}
          title={`${port.label} (${port.type})`}
        />
      ))}
      <div className="flex items-start gap-2.5 p-3">
        <ConnectorIcon connector={def.connector} size={16} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{isTrigger ? 'Trigger' : def.connector.name}</p>
            {data.invalid === true ? <AlertTriangle className="size-3 text-red-500" /> : null}
          </div>
          <p className="truncate text-sm font-medium leading-tight">{data.label ?? def.name}</p>
          {status === 'running' && data.phase !== undefined ? (
            <p className="mt-0.5 truncate text-xs text-primary">{data.phase}</p>
          ) : summary !== null ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{summary}</p>
          ) : (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{isTrigger ? def.connector.name : def.description}</p>
          )}
        </div>
        <StatusGlyph status={status} />
      </div>
      {def.outputs.length > 1 ? (
        <div className="flex flex-col gap-1 border-t px-3 py-1.5">
          {def.outputs.map((port) => (
            <div key={port.id} className="flex items-center justify-end text-[10px] text-muted-foreground">
              {port.label}
            </div>
          ))}
        </div>
      ) : null}
      {def.outputs.map((port, index) => (
        <Handle
          key={port.id}
          id={port.id}
          type="source"
          position={Position.Right}
          className={cn('!rounded-full', PORT_COLOR[port.type])}
          style={def.outputs.length > 1 ? { top: `calc(100% - ${(def.outputs.length - index - 1) * 20 + 14}px)` } : { top: '50%' }}
          title={`${port.label} (${port.type})`}
        />
      ))}
    </div>
  );
}

function handleOffset(index: number, total: number): string {
  if (total <= 1) return '50%';
  const step = 100 / (total + 1);
  return `${step * (index + 1)}%`;
}

function StatusGlyph({ status }: { status: CanvasNode['data']['status'] }) {
  const cls = 'mt-0.5 size-4 shrink-0';
  switch (status) {
    case 'running':
      return <Loader2 className={cn(cls, 'animate-spin text-primary')} />;
    case 'done':
      return <CheckCircle2 className={cn(cls, 'text-emerald-600')} />;
    case 'failed':
      return <XCircle className={cn(cls, 'text-red-600')} />;
    case 'refused':
      return <ShieldAlert className={cn(cls, 'text-amber-600')} />;
    case 'waiting':
      return <CircleDashed className={cn(cls, 'animate-pulse text-violet-600')} />;
    case 'skipped':
    case 'pending':
      return <CircleDashed className={cn(cls, 'text-muted-foreground/50')} />;
    default:
      return null;
  }
}

export const WorkflowNode = memo(WorkflowNodeView);
