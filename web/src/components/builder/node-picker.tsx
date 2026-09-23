'use client';

import { useMemo, useState } from 'react';
import { Zap } from 'lucide-react';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { getNodeType, NODE_TYPES, searchNodeTypes, type NodeTypeDef, type PortSpec } from '@/lib/connectors';
import { portsCompatible } from '@/lib/workflow/validate';
import { useStudio } from '@/lib/store';
import { PORT_STYLE } from './ports';

/** What the picker is adding after, when it was opened from a node or a dragged connection. */
export interface PickerSource {
  nodeId: string;
  port: PortSpec;
  /** Label of the node, for the dialog title. */
  label: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: PickerSource | null;
  /** True when the workflow has no trigger yet, so triggers lead the list. */
  needsTrigger: boolean;
  onPick: (def: NodeTypeDef) => void;
}

/** The likeliest next steps after each kind of output, in the order people reach for them. */
const SUGGESTED: Record<PortSpec['type'] | 'start', string[]> = {
  start: ['logic.trigger.manual', 'github-issues.trigger.issue-labelled', 'linear.trigger.issue-assigned', 'schedule.trigger.cron', 'http.trigger.webhook', 'sentry.trigger.issue-created'],
  issue: ['gates.action.budget', 'gates.action.allowlist', 'gates.action.approval', 'pipeline.action.run', 'pipeline.action.fast', 'logic.action.ai-step', 'logic.action.condition'],
  run: ['delivery.action.deliver', 'delivery.action.comment-summary', 'slack.action.post-run-summary', 'http.action.post-run-json', 'logic.action.condition'],
  change: ['slack.action.share-pr', 'slack.action.post-message', 'linear.action.attach-pr', 'linear.action.comment', 'discord.action.share-pr', 'http.action.request'],
  event: ['logic.action.condition', 'logic.action.ai-step', 'slack.action.post-message', 'http.action.request', 'schedule.action.delay'],
  message: ['slack.action.post-message', 'discord.action.send-message'],
  any: ['gates.action.budget', 'pipeline.action.run', 'logic.action.condition', 'slack.action.post-message', 'http.action.request'],
};

/** The input a node would be connected on, given what flows out of the source. */
export function compatibleInput(def: NodeTypeDef, port: PortSpec | null): PortSpec | undefined {
  if (port === null) return def.inputs[0];
  return def.inputs.find((input) => portsCompatible(port.type, input.type));
}

export function NodePicker({ open, onOpenChange, source, needsTrigger, onPick }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[18%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl" showCloseButton={false}>
        <DialogHeader className="border-b px-4 pt-4 pb-3">
          <DialogTitle className="text-base">{source === null ? 'Add a node' : `Add a step after “${source.label}”`}</DialogTitle>
          <DialogDescription className="text-xs">
            {source === null
              ? 'Pick a trigger to start the workflow, or an action to do something. It lands in the middle of the canvas.'
              : `It hands on ${PORT_STYLE[source.port.type].noun}, so only nodes that accept it are listed. The new node is connected for you.`}
          </DialogDescription>
        </DialogHeader>
        {/* Keyed on the source so the query starts empty each time the picker opens for a different node. */}
        {open ? <PickerList key={source?.nodeId ?? 'none'} source={source} needsTrigger={needsTrigger} onPick={onPick} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function PickerList({ source, needsTrigger, onPick }: Omit<Props, 'open' | 'onOpenChange'>) {
  const [query, setQuery] = useState('');
  const connections = useStudio((state) => state.connections);
  const port = source?.port ?? null;

  const fits = (def: NodeTypeDef) => (source === null ? true : def.kind === 'action' && compatibleInput(def, port) !== undefined);

  const suggested = useMemo(() => {
    const ids = source === null ? (needsTrigger ? SUGGESTED.start : SUGGESTED.any) : SUGGESTED[source.port.type];
    return ids.map((id) => getNodeType(id)).filter((def): def is NodeTypeDef => def !== undefined && (source === null || (def.kind === 'action' && compatibleInput(def, port) !== undefined)));
  }, [source, needsTrigger, port]);

  const results = useMemo(() => {
    const trimmed = query.trim();
    if (trimmed.length > 0) return searchNodeTypes(trimmed, 120).filter(fits).slice(0, 40);
    return [];
    // `fits` only depends on source and port.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, source, port]);

  const fromConnected = useMemo(() => {
    const ids = new Set(Object.keys(connections));
    return NODE_TYPES.filter((def) => ids.has(def.connectorId) && fits(def)).slice(0, 24);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections, source, port]);

  const searching = query.trim().length > 0;

  return (
    <Command shouldFilter={false} className="rounded-none! p-0">
      <CommandInput value={query} onValueChange={setQuery} placeholder="Search 1,800+ triggers and actions: “slack”, “budget”, “pull request”…" autoFocus />
      <CommandList className="max-h-[min(60vh,440px)] p-1">
        <CommandEmpty>Nothing that fits here matches “{query}”. Try the HTTP request node for anything else.</CommandEmpty>
        {searching ? (
          <CommandGroup heading={`${results.length} match${results.length === 1 ? '' : 'es'}`}>
            {results.map((def) => (
              <PickerItem key={def.id} def={def} onPick={onPick} />
            ))}
          </CommandGroup>
        ) : (
          <>
            {suggested.length > 0 ? (
              <CommandGroup heading={source === null ? (needsTrigger ? 'Start with a trigger' : 'Common building blocks') : 'Suggested next steps'}>
                {suggested.map((def) => (
                  <PickerItem key={def.id} def={def} onPick={onPick} />
                ))}
              </CommandGroup>
            ) : null}
            {fromConnected.length > 0 ? (
              <CommandGroup heading="From your connected apps">
                {fromConnected.map((def) => (
                  <PickerItem key={def.id} def={def} onPick={onPick} />
                ))}
              </CommandGroup>
            ) : null}
          </>
        )}
      </CommandList>
      <div className="flex items-center justify-between border-t px-3 py-2 text-[11px] text-muted-foreground">
        <span>↑↓ to move · ↵ to add · Esc to close</span>
        <span>Tip: drag from any port onto empty canvas to open this</span>
      </div>
    </Command>
  );
}

function PickerItem({ def, onPick }: { def: NodeTypeDef; onPick: (def: NodeTypeDef) => void }) {
  return (
    <CommandItem value={def.id} onSelect={() => onPick(def)} className="items-start gap-3 py-2">
      <ConnectorIcon connector={def.connector} size={13} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium">{def.name}</span>
          {def.kind === 'trigger' ? (
            <Badge variant="outline" className="h-4 gap-0.5 px-1 text-[9px] text-amber-600 dark:text-amber-400">
              <Zap className="size-2.5! fill-current" /> trigger
            </Badge>
          ) : null}
        </div>
        <p className="line-clamp-1 text-xs text-muted-foreground">
          <span className="text-foreground/70">{def.connector.name}</span> · {def.description}
        </p>
      </div>
    </CommandItem>
  );
}
