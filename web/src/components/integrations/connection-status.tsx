'use client';

import { Blocks, CircleAlert, CircleCheck, CircleDashed, Globe, Laptop, Plug, type LucideIcon } from 'lucide-react';
import { STATE_LABEL, type ConnectionState } from '@/lib/connectors/connection-state';
import type { Connection } from '@/lib/workflow/schema';
import { cn } from '@/lib/utils';

export const STATE_ICON: Record<ConnectionState, LucideIcon> = {
  builtin: Blocks,
  open: Globe,
  runner: Laptop,
  verified: CircleCheck,
  failing: CircleAlert,
  // Dashed: drawn, but not filled in. A marker is not a sign-in.
  marked: CircleDashed,
  missing: Plug,
};

/** Text colour per state. Green is kept for what an app actually confirmed. */
export function stateTone(state: ConnectionState, needed = false): string {
  switch (state) {
    case 'verified':
      return 'text-success';
    case 'failing':
      return 'text-destructive';
    case 'missing':
      return needed ? 'text-amber-700 dark:text-warning' : 'text-muted-foreground';
    default:
      return 'text-muted-foreground';
  }
}

/**
 * One line: an icon, what state the app is in, and who it is connected as.
 * `needed` colours "Not connected" as a to-do, for apps a workflow uses.
 */
export function ConnectionStatus({ state, connection, needed = false, compact = false, className }: { state: ConnectionState; connection?: Connection | undefined; needed?: boolean; compact?: boolean; className?: string }) {
  const Icon = STATE_ICON[state];
  const account = connection !== undefined && (state === 'verified' || state === 'failing' || state === 'marked') ? connection.account : null;
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 text-xs', className)}>
      <Icon className={cn('size-3.5 shrink-0', stateTone(state, needed))} aria-hidden />
      <span className="truncate">
        <span className={cn('font-medium', state === 'verified' || state === 'failing' ? 'text-foreground' : stateTone(state, needed))}>{STATE_LABEL[state]}</span>
        {account === null || compact ? null : <span className="text-muted-foreground"> · {account}</span>}
      </span>
    </span>
  );
}
