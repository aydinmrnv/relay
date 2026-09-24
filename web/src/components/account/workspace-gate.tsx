'use client';

import { Loader2 } from 'lucide-react';
import { useAccount, useWorkspaceReady } from '@/lib/cloud/account';
import { useStudio } from '@/lib/store';

/**
 * Holds the page until the studio knows whose workspace it is showing. A
 * guest waits for nothing; a signed-in person waits for one request, so no
 * screen draws a cached copy and then writes it back over newer work from
 * another device.
 */
export function WorkspaceGate({ children }: { children: React.ReactNode }) {
  const hydrated = useStudio((state) => state.hydrated);
  const ready = useWorkspaceReady();
  const loading = useAccount((state) => state.status === 'loading');
  if (hydrated && ready) return children;
  return (
    <div className="flex flex-1 items-center justify-center p-10" aria-busy="true">
      {loading ? (
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading your workspace…
        </span>
      ) : null}
    </div>
  );
}
