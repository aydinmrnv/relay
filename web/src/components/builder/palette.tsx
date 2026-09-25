'use client';

import { useMemo, useState } from 'react';
import { Check, ChevronRight, Search, X, Zap } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { HelpTip } from '@/components/app/help-tip';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { CATEGORY_LABELS, CONNECTORS, connectorsByCategory, NODE_TYPES, searchNodeTypes, type Connector, type NodeTypeDef } from '@/lib/connectors';
import { useStudio } from '@/lib/store';
import { cn } from '@/lib/utils';

export const DRAG_MIME = 'application/x-workflow-node';

type KindFilter = 'all' | 'trigger' | 'action';

/** The core nodes, in the order a workflow usually uses them, with a word on when to reach for each. */
const BLOCKS: Array<{ title: string; hint: string; ids: string[] }> = [
  { title: 'Start', hint: 'Every workflow begins with one trigger.', ids: ['logic.trigger.manual', 'schedule.trigger.cron', 'http.trigger.webhook'] },
  { title: 'Guardrails', hint: 'Put these in front of the pipeline. Each refuses by default.', ids: ['gates.action.budget', 'gates.action.allowlist', 'gates.action.approval', 'gates.action.kill-switch', 'gates.action.concurrency'] },
  { title: 'Agents', hint: 'Where the code gets written, reviewed and tested.', ids: ['pipeline.action.run', 'pipeline.action.fast', 'pipeline.action.estimate'] },
  { title: 'Deliver', hint: 'How far a finished run carries its work.', ids: ['delivery.action.deliver', 'delivery.action.comment-summary'] },
  {
    title: 'Logic & glue',
    hint: 'Branch, wait, call anything with a URL, leave notes.',
    ids: ['logic.action.condition', 'logic.action.ai-step', 'logic.action.filter', 'logic.action.merge-paths', 'schedule.action.delay', 'schedule.action.business-hours', 'http.action.request', 'logic.action.note'],
  },
];

const NODE_BY_ID = new Map(NODE_TYPES.map((def) => [def.id, def]));

export function Palette({ onAdd }: { onAdd: (def: NodeTypeDef) => void }) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [openConnector, setOpenConnector] = useState<string | null>(null);
  const connections = useStudio((state) => state.connections);
  const groups = useMemo(() => connectorsByCategory().filter((group) => group.category !== 'core'), []);
  const connected = useMemo(() => CONNECTORS.filter((connector) => connections[connector.id] !== undefined && connector.category !== 'core'), [connections]);
  const searching = query.trim().length > 0;
  const results = useMemo(() => (searching ? searchNodeTypes(query, 80).filter((def) => kind === 'all' || def.kind === kind) : []), [query, kind, searching]);
  const keep = (def: NodeTypeDef) => kind === 'all' || def.kind === kind;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-2 border-b p-2.5">
        <div className="flex items-center justify-between px-0.5">
          <p className="flex items-center gap-1.5 text-xs font-semibold">
            Nodes <HelpTip title="Nodes">Triggers start a workflow; actions do something. Drag one onto the canvas or click to add it. Press A on the canvas to search and add in place.</HelpTip>
          </p>
          <span className="text-[10px] text-muted-foreground tabular-nums">{NODE_TYPES.length.toLocaleString()} available</span>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search apps, triggers, actions…" className="h-8 pr-7 pl-8 text-sm" aria-label="Search nodes" />
          {searching ? (
            <button type="button" aria-label="Clear search" onClick={() => setQuery('')} className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm text-muted-foreground hover:text-foreground">
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
        <ToggleGroup value={[kind]} onValueChange={(value) => setKind((value[0] as KindFilter | undefined) ?? 'all')} variant="outline" size="sm" className="w-full">
          <ToggleGroupItem value="all" className="flex-1 text-xs">
            All
          </ToggleGroupItem>
          <ToggleGroupItem value="trigger" className="flex-1 text-xs">
            Triggers
          </ToggleGroupItem>
          <ToggleGroupItem value="action" className="flex-1 text-xs">
            Actions
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-2.5">
          {searching ? (
            results.length === 0 ? (
              <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                <p>No {kind === 'all' ? 'node' : kind} matches “{query}”.</p>
                <p className="mt-1">Anything with an API can still be reached with the HTTP request node.</p>
              </div>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {results.map((def) => (
                  <NodeRow key={def.id} def={def} onAdd={onAdd} showConnector />
                ))}
              </ul>
            )
          ) : (
            <>
              {BLOCKS.map((block) => {
                const defs = block.ids.map((id) => NODE_BY_ID.get(id)).filter((def): def is NodeTypeDef => def !== undefined && keep(def));
                if (defs.length === 0) return null;
                return (
                  <section key={block.title}>
                    <SectionTitle title={block.title} hint={block.hint} />
                    <ul className="flex flex-col gap-0.5">
                      {defs.map((def) => (
                        <NodeRow key={def.id} def={def} onAdd={onAdd} rich />
                      ))}
                    </ul>
                  </section>
                );
              })}
              {connected.length > 0 ? (
                <section>
                  <SectionTitle title="Your connected apps" hint="Apps you marked as connected on the Integrations page." />
                  <ul className="flex flex-col gap-0.5">
                    {connected.map((connector) => (
                      <ConnectorGroup key={connector.id} connector={connector} open={openConnector === connector.id} onOpenChange={(open) => setOpenConnector(open ? connector.id : null)} connected keep={keep} onAdd={onAdd} />
                    ))}
                  </ul>
                </section>
              ) : null}
              {groups.map((group) => (
                <section key={group.category}>
                  <SectionTitle title={group.label} />
                  <ul className="flex flex-col gap-0.5">
                    {group.connectors.map((connector) => (
                      <ConnectorGroup
                        key={connector.id}
                        connector={connector}
                        open={openConnector === connector.id}
                        onOpenChange={(open) => setOpenConnector(open ? connector.id : null)}
                        connected={connections[connector.id] !== undefined}
                        keep={keep}
                        onAdd={onAdd}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </>
          )}
        </div>
      </ScrollArea>
      <p className="border-t px-3 py-2 text-[10px] leading-snug text-muted-foreground">Drag onto the canvas, or click to add next to the selected node.</p>
    </div>
  );
}

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-1 px-1">
      <p className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{title}</p>
      {hint === undefined ? null : <p className="text-[11px] leading-snug text-muted-foreground/80">{hint}</p>}
    </div>
  );
}

function ConnectorGroup({ connector, open, onOpenChange, connected, keep, onAdd }: { connector: Connector; open: boolean; onOpenChange: (open: boolean) => void; connected: boolean; keep: (def: NodeTypeDef) => boolean; onAdd: (def: NodeTypeDef) => void }) {
  const defs = NODE_TYPES.filter((def) => def.connectorId === connector.id && keep(def));
  if (defs.length === 0) return null;
  return (
    <li>
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm transition-colors hover:bg-muted">
          <ChevronRight className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open ? 'rotate-90' : '')} />
          <ConnectorIcon connector={connector} size={12} />
          <span className="flex-1 truncate">{connector.name}</span>
          {connected ? <Check className="size-3 text-muted-foreground" aria-label="Connected" /> : null}
          <span className="text-[10px] text-muted-foreground tabular-nums">{defs.length}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="ml-3.5 flex flex-col gap-0.5 border-l py-1 pl-1.5">
            {defs.map((def) => (
              <NodeRow key={def.id} def={def} onAdd={onAdd} />
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function NodeRow({ def, onAdd, showConnector = false, rich = false }: { def: NodeTypeDef; onAdd: (def: NodeTypeDef) => void; showConnector?: boolean; rich?: boolean }) {
  const row = (
    <button
      type="button"
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_MIME, def.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => onAdd(def)}
      className={cn(
        'group/row flex w-full cursor-grab items-start gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-muted active:cursor-grabbing',
        rich ? 'py-1.5' : 'items-center py-1 text-xs',
      )}
    >
      {rich || showConnector ? <ConnectorIcon connector={def.connector} size={rich ? 12 : 10} className={rich ? 'mt-0.5' : ''} /> : null}
      <span className="min-w-0 flex-1">
        <span className={cn('flex items-center gap-1', rich ? 'text-[13px] font-medium' : '')}>
          {def.kind === 'trigger' ? <Zap className="size-3 shrink-0 text-muted-foreground" aria-label="Trigger" /> : null}
          <span className="truncate">
            {showConnector ? <span className="text-muted-foreground">{def.connector.name} · </span> : null}
            {def.name}
          </span>
        </span>
        {rich ? <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-muted-foreground">{def.description}</span> : null}
      </span>
    </button>
  );
  if (rich) return <li>{row}</li>;
  return (
    <li>
      <Tooltip>
        <TooltipTrigger render={row} />
        <TooltipContent side="right" className="max-w-64">
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">
              {def.connector.name} · {def.name}
            </span>
            <span className="text-background/80">{def.description}</span>
            <span className="text-background/60">{CATEGORY_LABELS[def.connector.category]}</span>
          </div>
        </TooltipContent>
      </Tooltip>
    </li>
  );
}
