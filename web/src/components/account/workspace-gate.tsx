'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Loader2, LogIn } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAccount, useWorkspaceReady } from '@/lib/cloud/account';
import { isStudioPath, signInThenTo } from '@/lib/studio-routes';
import { useStudio } from '@/lib/store';

/**
 * Holds the page until the studio knows whose workspace it is showing. A
 * signed-in person waits for one request, so no screen draws a cached copy
 * and then writes it back over newer work from another device. The studio
 * needs an account: the proxy turns signed-out visits away, and a tab whose
 * session ends while it is open (signed out in another tab, or on another
 * device) is shown the way back in instead of the work.
 */
export function WorkspaceGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const hydrated = useStudio((state) => state.hydrated);
  const ready = useWorkspaceReady();
  const loading = useAccount((state) => state.status === 'loading');
  const signedOut = useAccount((state) => state.status === 'guest');
  if (signedOut && isStudioPath(pathname)) return <SignedOut next={pathname} />;
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

function SignedOut({ next }: { next: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-10">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <h1 className="text-lg font-semibold tracking-tight">You are signed out</h1>
        <p className="text-sm text-pretty text-muted-foreground">Sign in to get back to your workflows. Everything you saved is in your account.</p>
        <Button className="mt-1" nativeButton={false} render={<Link href={signInThenTo(next)} />}>
          <LogIn data-icon="inline-start" /> Sign in
        </Button>
      </div>
    </div>
  );
}
