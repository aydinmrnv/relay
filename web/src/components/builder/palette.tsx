'use client';

import { useMemo, useState } from 'react';
import { ChevronRight, GripVertical, Search, Zap } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { CATEGORY_LABELS, connectorsByCategory, NODE_TYPES, searchNodeTypes, type Connector, type NodeTypeDef } from '@/lib/connectors';
import { useStudio } from '@/lib/store';
import { cn } from '@/lib/utils';

export const DRAG_MIME = 'application/x-workflow-node';

interface Props {
  onAdd: (def: NodeTypeDef) => void;
}

export function Palette({ onAdd }: Props) {
  const [query, setQuery] = useState('');
  const [openConnector, setOpenConnector] = useState<string | null>('pipeline');
  const connections = useStudio((state) => state.connections);
  const groups = useMemo(() => connectorsByCategory(), []);
  const results = useMemo(() => searchNodeTypes(query, 60), [query]);
  const searching = query.trim().length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${NODE_TYPES.length} nodes…`} className="h-8 pl-7 text-sm" />
        </div>
        <p className="mt-1.5 px-0.5 text-[10px] text-muted-foreground">Drag onto the canvas, or click to add.</p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-2">
          {searching ? (
            results.length === 0 ? (
              <p className="p-3 text-center text-xs text-muted-foreground">No node matches “{query}”.</p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {results.map((def) => (
                  <NodeRow key={def.id} def={def} onAdd={onAdd} showConnector />
                ))}
              </ul>
            )
          ) : (
            groups.map((group) => (
              <div key={group.category} className="mb-3">
                <p className="mb-1 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{group.label}</p>
                <ul className="flex flex-col gap-0.5">
                  {group.connectors.map((connector) => (
                    <ConnectorGroup
                      key={connector.id}
                      connector={connector}
                      open={openConnector === connector.id}
                      onOpenChange={(open) => setOpenConnector(open ? connector.id : null)}
                      connected={connections[connector.id] !== undefined}
                      onAdd={onAdd}
                    />
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function ConnectorGroup({ connector, open, onOpenChange, connected, onAdd }: { connector: Connector; open: boolean; onOpenChange: (open: boolean) => void; connected: boolean; onAdd: (def: NodeTypeDef) => void }) {
  const defs = NODE_TYPES.filter((def) => def.connectorId === connector.id);
  return (
    <li>
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted">
          <ChevronRight className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open ? 'rotate-90' : '')} />
          <ConnectorIcon connector={connector} size={12} />
          <span className="flex-1 truncate">{connector.name}</span>
          {connected ? <span className="size-1.5 rounded-full bg-emerald-500" title="Connected" /> : null}
          <span className="text-[10px] text-muted-foreground">{defs.length}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="ml-3 flex flex-col gap-0.5 border-l py-1 pl-1">
            {defs.map((def) => (
              <NodeRow key={def.id} def={def} onAdd={onAdd} />
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function NodeRow({ def, onAdd, showConnector = false }: { def: NodeTypeDef; onAdd: (def: NodeTypeDef) => void; showConnector?: boolean }) {
  return (
    <li>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(DRAG_MIME, def.id);
                event.dataTransfer.effectAllowed = 'move';
              }}
              onClick={() => onAdd(def)}
              className="flex w-full cursor-grab items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-muted active:cursor-grabbing"
            />
          }
        >
          <GripVertical className="size-3 shrink-0 text-muted-foreground/60" />
          {showConnector ? <ConnectorIcon connector={def.connector} size={11} variant="mark" /> : null}
          {def.kind === 'trigger' ? <Zap className="size-3 shrink-0 text-amber-500" /> : null}
          <span className="flex-1 truncate">
            {showConnector ? <span className="text-muted-foreground">{def.connector.name} · </span> : null}
            {def.name}
          </span>
          {def.kind === 'trigger' ? (
            <Badge variant="outline" className="h-4 px-1 text-[9px]">
              trigger
            </Badge>
          ) : null}
        </TooltipTrigger>
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
