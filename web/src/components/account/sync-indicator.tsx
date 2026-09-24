'use client';

import { usePathname } from 'next/navigation';
import { Check, CloudOff, Loader2, TriangleAlert } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAccount } from '@/lib/cloud/account';
import { useSyncStatus } from '@/lib/cloud/sync';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Whether the account has everything this browser has: saved, saving, or waiting for the network. */
export function SyncIndicator({ className }: { className?: string }) {
  const pathname = usePathname();
  const signedIn = useAccount((state) => state.status === 'signed-in');
  const state = useSyncStatus((status) => status.state);
  const message = useSyncStatus((status) => status.message);
  const lastSavedAt = useSyncStatus((status) => status.lastSavedAt);
  const pending = useSyncStatus((status) => status.pendingCount);
  // The builder has its own save state, which says the same thing next to the canvas.
  if (!signedIn || pathname.startsWith('/workflows/')) return null;

  const saving = state === 'saving' || (pending > 0 && state !== 'offline' && state !== 'error');
  const label = saving ? 'Saving…' : state === 'offline' ? 'Offline' : state === 'error' ? 'Not saved' : 'Saved';
  const detail =
    state === 'offline' || state === 'error'
      ? (message ?? 'Changes are kept in this browser and sent when the server is reachable.')
      : saving
        ? 'Sending your latest changes to your account.'
        : lastSavedAt === null
          ? 'Everything here is saved to your account.'
          : `Saved to your account ${timeAgo(new Date(lastSavedAt).toISOString())}.`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              'hidden h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground sm:inline-flex',
              (state === 'offline' || state === 'error') && 'text-warning',
              className,
            )}
            aria-live="polite"
          />
        }
      >
        {saving ? <Loader2 className="size-3.5 animate-spin" /> : state === 'offline' ? <CloudOff className="size-3.5" /> : state === 'error' ? <TriangleAlert className="size-3.5" /> : <Check className="size-3.5 text-success" />}
        {label}
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{detail}</TooltipContent>
    </Tooltip>
  );
}
