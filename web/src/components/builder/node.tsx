'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { AlertTriangle, CheckCircle2, CircleDashed, Copy, Loader2, Plus, ShieldAlert, Trash2, XCircle, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getNodeType, type NodeTypeDef } from '@/lib/connectors';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from '@/components/ui/context-menu';
import { BorderTrail } from '@/components/21st/border-trail';
import { TextShimmer } from '@/components/21st/text-shimmer';
import { useBuilderActions } from './builder-context';
import { PORT_STYLE } from './ports';
import type { CanvasNode } from './types';

/** A few words on how the node is configured, so the canvas reads without opening the inspector. */
function summarize(config: Record<string, unknown>, def: NodeTypeDef): string | null {
  const parts: string[] = [];
  for (const field of def.fields.slice(0, 3)) {
    const value = config[field.key];
    if (value === undefined || value === '' || value === null) continue;
    if (field.type === 'template' || field.type === 'textarea' || field.type === 'json' || field.type === 'secret') continue;
    if (field.type === 'boolean') {
      if (value === true) parts.push(field.label.toLowerCase());
      continue;
    }
    if (field.type === 'number' && field.key.toLowerCase().includes('usd')) {
      parts.push(`$${String(value)}`);
      continue;
    }
    const option = field.options?.find((candidate) => candidate.value === value);
    parts.push(option?.label ?? String(value));
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

function WorkflowNodeView({ id, data, selected }: NodeProps<CanvasNode>) {
  const def = getNodeType(data.typeId);
  const actions = useBuilderActions();
  const status = data.status;

  if (def === undefined) {
    return (
      <div className="wf-node w-68 rounded-xl border border-destructive bg-card p-3 text-sm">
        <p className="font-medium text-destructive">Unknown node</p>
        <p className="text-xs text-muted-foreground">{data.typeId}</p>
      </div>
    );
  }

  if (def.id === 'logic.action.note') {
    return (
      <NodeMenu id={id} def={def}>
        <div
          className={cn(
            'wf-node w-60 rounded-lg border border-amber-300/70 bg-amber-50 p-3 text-xs leading-relaxed text-amber-950 shadow-sm dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100',
            selected ? 'ring-2 ring-amber-400' : '',
          )}
        >
          <p className="whitespace-pre-wrap">{String(data.config['text'] ?? 'Note')}</p>
        </div>
      </NodeMenu>
    );
  }

  const color = def.connector.icon.color;
  const summary = summarize(data.config, def);
  const isTrigger = def.kind === 'trigger';
  const branching = def.outputs.length > 1;

  return (
    <NodeMenu id={id} def={def}>
      <div
        className={cn(
          'wf-node group/node relative w-68 rounded-xl border bg-card shadow-xs transition-[box-shadow,opacity,border-color] duration-200 hover:shadow-md',
          status === 'running' ? 'border-primary/60 shadow-[0_0_0_4px_color-mix(in_oklch,var(--primary)_18%,transparent)]' : '',
          status === 'done' ? 'border-success/60' : '',
          status === 'failed' ? 'border-destructive/70' : '',
          status === 'refused' ? 'border-warning/80' : '',
          status === 'waiting' ? 'border-info/60' : '',
          status === 'skipped' ? 'opacity-45' : '',
          status === 'pending' ? 'opacity-80' : '',
          data.invalid === true && status === undefined ? 'border-destructive/70' : '',
        )}
      >
        {status === 'running' ? <BorderTrail size={70} className="bg-primary" transition={{ repeat: Infinity, duration: 2.4, ease: 'linear' }} /> : null}
        {/* The connector's colour as a thin top rule, so a busy canvas still groups by app at a glance. */}
        <div className="absolute inset-x-3 top-0 h-0.5 rounded-b-full opacity-70" style={{ background: color }} />

        {def.inputs.map((port, index) => (
          <Handle
            key={port.id}
            id={port.id}
            type="target"
            position={Position.Left}
            className={cn('!rounded-full', PORT_STYLE[port.type].dot)}
            style={{ top: handleOffset(index, def.inputs.length) }}
            title={`Takes in ${PORT_STYLE[port.type].noun}`}
          />
        ))}

        <div className="flex items-start gap-2.5 p-3">
          <ConnectorIcon connector={def.connector} size={15} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              {isTrigger ? (
                <span className="inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400">
                  <Zap className="size-2.5 fill-current" /> Trigger
                </span>
              ) : null}
              <span className="truncate">{def.connector.name}</span>
              {data.invalid === true ? <AlertTriangle className="size-3 shrink-0 text-destructive" aria-label="Has a problem" /> : null}
            </div>
            <p className="truncate text-[13px] leading-snug font-semibold">{data.label ?? def.name}</p>
            {status === 'running' && data.phase !== undefined ? (
              <TextShimmer as="p" duration={1.6} className="mt-0.5 truncate text-xs">
                {data.phase}
              </TextShimmer>
            ) : (
              <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">{summary ?? def.description}</p>
            )}
          </div>
          <StatusGlyph status={status} />
        </div>

        {branching ? (
          <div className="flex flex-col gap-1 border-t bg-muted/30 px-3 py-1.5">
            {def.outputs.map((port) => (
              <div key={port.id} className="flex h-4 items-center justify-end gap-1.5 text-[10px] font-medium text-muted-foreground">
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
            className={cn('!rounded-full', PORT_STYLE[port.type].dot)}
            style={branching ? { top: `calc(100% - ${(def.outputs.length - index - 1) * 20 + 14}px)` } : { top: '50%' }}
            title={`Hands on ${PORT_STYLE[port.type].noun}${branching ? ` (${port.label})` : ''}. Drag to connect, or drop on empty canvas to add a node.`}
          />
        ))}

        {def.outputs.length > 0 && !actions.readOnly ? (
          <button
            type="button"
            aria-label={`Add a node after ${data.label ?? def.name}`}
            title="Add the next step"
            onClick={(event) => {
              event.stopPropagation();
              actions.addAfter(id);
            }}
            className="nodrag absolute top-1/2 -right-9 flex size-6 -translate-y-1/2 items-center justify-center rounded-full border bg-card text-muted-foreground opacity-0 shadow-xs transition-all group-hover/node:opacity-100 hover:scale-110 hover:border-primary hover:text-primary focus-visible:opacity-100"
          >
            <Plus className="size-3.5" />
          </button>
        ) : null}
      </div>
    </NodeMenu>
  );
}

/** Right-click on a node: the same things the inspector offers, without leaving the canvas. */
function NodeMenu({ id, def, children }: { id: string; def: NodeTypeDef; children: React.ReactNode }) {
  const actions = useBuilderActions();
  if (actions.readOnly) return <>{children}</>;
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div />}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onClick={() => actions.select(id)}>Edit settings</ContextMenuItem>
        {def.outputs.length > 0 ? (
          <ContextMenuItem onClick={() => actions.addAfter(id)}>
            <Plus /> Add next step
            <ContextMenuShortcut>A</ContextMenuShortcut>
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem onClick={() => actions.duplicate(id)}>
          <Copy /> Duplicate
          <ContextMenuShortcut>⌘D</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => actions.remove(id)}>
          <Trash2 /> Delete
          <ContextMenuShortcut>⌫</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
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
      return <Loader2 className={cn(cls, 'animate-spin text-primary')} aria-label="Running" />;
    case 'done':
      return <CheckCircle2 className={cn(cls, 'text-success')} aria-label="Done" />;
    case 'failed':
      return <XCircle className={cn(cls, 'text-destructive')} aria-label="Failed" />;
    case 'refused':
      return <ShieldAlert className={cn(cls, 'text-warning')} aria-label="Refused" />;
    case 'waiting':
      return <CircleDashed className={cn(cls, 'animate-pulse text-info')} aria-label="Waiting" />;
    case 'skipped':
    case 'pending':
      return <CircleDashed className={cn(cls, 'text-muted-foreground/50')} aria-label={status === 'skipped' ? 'Skipped' : 'Pending'} />;
    default:
      return null;
  }
}

export const WorkflowNode = memo(WorkflowNodeView);
