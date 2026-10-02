'use client';

import { memo } from 'react';
import { motion } from 'motion/react';
import { useCalmMotion } from '@/components/motion/use-calm-motion';
import { ChevronRight, CircleDashed, Plug, Settings2, Workflow, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { CATEGORY_LABELS } from '@/lib/connectors';
import { connectionState, nothingToConnect, type AppUsage, type ConnectionState } from '@/lib/connectors/connection-state';
import { credentialSpec } from '@/lib/connectors/credentials';
import type { Connection } from '@/lib/workflow/schema';
import { cn } from '@/lib/utils';
import { ConnectionStatus } from './connection-status';
import { AUTH_ICON, authLabel, isBuiltIn, templatesUsing, type ConnectorMatch } from './connector-meta';

const EASE = [0.22, 1, 0.36, 1] as const;

interface Props {
  match: ConnectorMatch;
  connection: Connection | undefined;
  /** The workflows that use this app, if any. */
  usage: AppUsage | undefined;
  /** Position in the grid, for the entrance stagger. Capped so a long list does not trickle in. */
  index: number;
  onOpen: (id: string) => void;
  onConnect: (id: string) => void;
  onDisconnect: (id: string) => void;
}

/**
 * One app in the catalog grid. The whole card opens the detail sheet (the name
 * is a button stretched over the card), while its one action sits above it so
 * it stays separately clickable and focusable.
 */
export const ConnectorCard = memo(function ConnectorCard({ match, connection, usage, index, onOpen, onConnect, onDisconnect }: Props) {
  const reduce = useCalmMotion();
  const { connector, hits } = match;
  const builtIn = isBuiltIn(connector);
  const AuthIcon = AUTH_ICON[connector.auth];
  const state = connectionState(connector, connection);
  const real = credentialSpec(connector.id) !== undefined;
  const used = usage?.workflows ?? [];
  const templates = templatesUsing(connector.id).length;

  return (
    <motion.div
      className="h-full"
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: EASE, delay: Math.min(index, 18) * 0.025 }}
    >
      <div
        className={cn(
          'group/card relative flex h-full flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10 transition-[translate,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md hover:shadow-foreground/5 hover:ring-foreground/20 has-[[data-card-open]:focus-visible]:ring-2 has-[[data-card-open]:focus-visible]:ring-ring motion-reduce:hover:translate-y-0',
          state === 'verified' ? 'ring-success/40 hover:ring-success/60' : state === 'failing' ? 'ring-destructive/50 hover:ring-destructive/70' : '',
        )}
      >
        <div className="flex items-start gap-3">
          <ConnectorIcon connector={connector} size={18} />
          <div className="min-w-0 flex-1">
            <button
              type="button"
              data-card-open
              onClick={() => onOpen(connector.id)}
              className="block max-w-full truncate text-left text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-xl after:content-['']"
            >
              {connector.name}
            </button>
            <p className="truncate text-xs text-muted-foreground">
              {builtIn ? 'Built in' : CATEGORY_LABELS[connector.category]}
              {templates === 0 ? '' : ` · in ${templates} ${templates === 1 ? 'template' : 'templates'}`}
            </p>
          </div>
          <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground/0 transition-colors group-hover/card:text-muted-foreground" aria-hidden />
        </div>

        {/* What people use it for, not what its API can do: that is what a card is for. */}
        <p className="line-clamp-2 text-[13px] leading-snug text-muted-foreground">{connector.uses[0] ?? connector.description}</p>

        {hits.length > 0 ? (
          <p className="-mt-1 truncate text-xs">
            <span className="text-muted-foreground">Matches </span>
            <span className="font-medium">{hits.slice(0, 3).join(', ')}</span>
            {hits.length > 3 ? <span className="text-muted-foreground"> +{hits.length - 3}</span> : null}
          </p>
        ) : null}

        {used.length === 0 ? null : (
          <p className="-mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={used.map((workflow) => workflow.name).join(', ')}>
            <Workflow className="size-3 shrink-0" aria-hidden />
            <span className="truncate">
              In <span className="font-medium text-foreground">{used[0]!.name}</span>
              {used.length > 1 ? ` and ${used.length - 1} more` : ''}
            </span>
          </p>
        )}

        <div className="mt-auto flex min-h-7 items-center justify-between gap-2 border-t border-border/60 pt-3">
          {state === 'missing' || nothingToConnect(state) ? (
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <AuthIcon className="size-3.5 shrink-0" aria-hidden />
              {/* An app with no sign-in built yet says so on the card, not only in its sheet: "OAuth sign-in" on its own reads as something that works. */}
              <span className="truncate">{builtIn ? 'Always available' : state === 'runner' ? 'Runs on your runner' : state === 'open' || real ? authLabel(connector) : `Planned: ${authLabel(connector).toLowerCase()}`}</span>
            </span>
          ) : (
            <ConnectionStatus state={state} connection={connection} />
          )}
          <CardAction state={state} real={real} name={connector.name} onConnect={() => onConnect(connector.id)} onOpen={() => onOpen(connector.id)} onUnmark={() => onDisconnect(connector.id)} />
        </div>
      </div>
    </motion.div>
  );
});

/** The one thing to do from the card: connect, fix, manage, or take a marker back. */
function CardAction({ state, real, name, onConnect, onOpen, onUnmark }: { state: ConnectionState; real: boolean; name: string; onConnect: () => void; onOpen: () => void; onUnmark: () => void }) {
  const button = 'relative z-10 shrink-0';
  switch (state) {
    case 'missing':
      return (
        <Button size="xs" variant="outline" className={button} onClick={onConnect}>
          {real ? <Plug data-icon="inline-start" /> : <CircleDashed data-icon="inline-start" />} {real ? 'Connect' : 'Mark ready'}
        </Button>
      );
    case 'marked':
      return real ? (
        <Button size="xs" variant="outline" className={button} onClick={onConnect}>
          <Plug data-icon="inline-start" /> Connect for real
        </Button>
      ) : (
        <Tooltip>
          <TooltipTrigger render={<Button size="xs" variant="ghost" className={button} onClick={onUnmark} />}>Unmark</TooltipTrigger>
          <TooltipContent>Removes the marker. Nothing breaks: test runs still play, and {name} nodes ask to be connected again.</TooltipContent>
        </Tooltip>
      );
    case 'failing':
      return (
        <Button size="xs" variant="outline" className={cn(button, 'border-destructive/40 text-destructive hover:text-destructive')} onClick={onOpen}>
          <Wrench data-icon="inline-start" /> Fix
        </Button>
      );
    case 'verified':
      return (
        <Button size="xs" variant="ghost" className={button} onClick={onOpen}>
          <Settings2 data-icon="inline-start" /> Manage
        </Button>
      );
    default:
      return null;
  }
}
