'use client';

import { memo } from 'react';
import { motion } from 'motion/react';
import { useCalmMotion } from '@/components/motion/use-calm-motion';
import { ChevronRight, Plug, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { CATEGORY_LABELS } from '@/lib/connectors';
import type { Connection } from '@/lib/workflow/schema';
import { cn } from '@/lib/utils';
import { AUTH_ICON, authLabel, isBuiltIn, type ConnectorMatch } from './connector-meta';

const EASE = [0.22, 1, 0.36, 1] as const;

interface Props {
  match: ConnectorMatch;
  connection: Connection | undefined;
  /** Position in the grid, for the entrance stagger. Capped so a long list does not trickle in. */
  index: number;
  onOpen: (id: string) => void;
  onConnect: (id: string) => void;
  onDisconnect: (id: string) => void;
}

/**
 * One app in the catalog grid. The whole card opens the detail sheet (the name
 * is a button stretched over the card), while Connect / Disconnect sit above
 * it so they stay separately clickable and focusable.
 */
export const ConnectorCard = memo(function ConnectorCard({ match, connection, index, onOpen, onConnect, onDisconnect }: Props) {
  const reduce = useCalmMotion();
  const { connector, hits } = match;
  const builtIn = isBuiltIn(connector);
  const AuthIcon = AUTH_ICON[connector.auth];
  const connected = connection !== undefined;

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
          connected ? 'ring-success/40 hover:ring-success/60' : '',
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
              {builtIn ? 'Built in' : CATEGORY_LABELS[connector.category]} · {connector.triggers.length} {connector.triggers.length === 1 ? 'trigger' : 'triggers'} · {connector.actions.length}{' '}
              {connector.actions.length === 1 ? 'action' : 'actions'}
            </p>
          </div>
          <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground/0 transition-colors group-hover/card:text-muted-foreground" aria-hidden />
        </div>

        <p className="line-clamp-2 text-[13px] leading-snug text-muted-foreground">{connector.description}</p>

        {hits.length > 0 ? (
          <p className="-mt-1 truncate text-xs">
            <span className="text-muted-foreground">Matches </span>
            <span className="font-medium">{hits.slice(0, 3).join(', ')}</span>
            {hits.length > 3 ? <span className="text-muted-foreground"> +{hits.length - 3}</span> : null}
          </p>
        ) : null}

        <div className="mt-auto flex min-h-7 items-center justify-between gap-2 border-t border-border/60 pt-3">
          {connected ? (
            <span className="flex min-w-0 items-center gap-1.5 text-xs">
              <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden />
              <span className="truncate text-muted-foreground">
                <span className="font-medium text-success">Connected</span> as {connection.account}
              </span>
            </span>
          ) : (
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <AuthIcon className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{builtIn ? 'Always available' : authLabel(connector)}</span>
            </span>
          )}
          {builtIn ? null : connected ? (
            <Tooltip>
              <TooltipTrigger
                render={<Button size="xs" variant="ghost" className="relative z-10 shrink-0" onClick={() => onDisconnect(connector.id)} />}
              >
                <Unplug data-icon="inline-start" /> Disconnect
              </TooltipTrigger>
              <TooltipContent>Removes the local flag. Nothing breaks: test runs still play, and {connector.name} nodes show their reminder again.</TooltipContent>
            </Tooltip>
          ) : (
            <Button size="xs" variant="outline" className="relative z-10 shrink-0" onClick={() => onConnect(connector.id)}>
              <Plug data-icon="inline-start" /> Connect
            </Button>
          )}
        </div>
      </div>
    </motion.div>
  );
});
