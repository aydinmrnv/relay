'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CloudOff, Loader2, LogIn, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAccount, useWorkspaceReady } from '@/lib/cloud/account';
import { loadAccount } from '@/lib/cloud/sync';
import { isStudioPath, signInThenTo } from '@/lib/studio-routes';
import { resetLocalData, useStudio } from '@/lib/store';

/**
 * Holds the studio's screens until the studio knows whose workspace it is
 * showing. A signed-in person waits for one request, so no screen draws a
 * cached copy and then writes it back over newer work from another device.
 * The studio needs an account: the proxy turns signed-out visits away, and a
 * tab whose session ends while it is open (signed out in another tab, or on
 * another device) is shown the way back in instead of the work.
 *
 * The docs under the same layout (`/guide`, `/runners`) are public pages and
 * wait for nothing: they are in the server's HTML, for someone reading with
 * scripts off and for a crawler alike.
 */
export function WorkspaceGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const hydrated = useStudio((state) => state.hydrated);
  const ready = useWorkspaceReady();
  const status = useAccount((state) => state.status);
  const stuck = useStuck(hydrated);
  if (!isStudioPath(pathname)) return children;
  if (status === 'guest') return <SignedOut next={pathname} />;
  if (status === 'unreachable') return <Unreachable />;
  if (hydrated && ready) return children;
  if (stuck) return <StorageStuck />;
  return (
    <div className="flex flex-1 items-center justify-center p-10" aria-busy="true">
      {status === 'loading' ? (
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading your workspace…
        </span>
      ) : null}
    </div>
  );
}

/** True when what this browser saved has still not been read several seconds in: it is not going to be. */
function useStuck(hydrated: boolean): boolean {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (hydrated) return;
    const timer = setTimeout(() => setStuck(true), 6000);
    return () => clearTimeout(timer);
  }, [hydrated]);
  return stuck && !hydrated;
}

function Notice({ title, children, actions }: { title: string; children: React.ReactNode; actions: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center p-10">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-pretty text-muted-foreground">{children}</p>
        <div className="mt-1 flex flex-wrap justify-center gap-2">{actions}</div>
      </div>
    </div>
  );
}

function SignedOut({ next }: { next: string }) {
  return (
    <Notice
      title="You are signed out"
      actions={
        <Button nativeButton={false} render={<Link href={signInThenTo(next)} />}>
          <LogIn data-icon="inline-start" /> Sign in
        </Button>
      }
    >
      Sign in to get back to your workflows. Everything you saved is in your account.
    </Notice>
  );
}

/** Signed in, but the workspace did not arrive. Not signed out: say what happened, and keep trying. */
function Unreachable() {
  const reason = useAccount((state) => state.loadError);
  const [trying, setTrying] = useState(false);
  const retry = async () => {
    setTrying(true);
    await loadAccount();
    setTrying(false);
  };
  return (
    <Notice
      title="Could not load your workspace"
      actions={
        <Button onClick={() => void retry()} disabled={trying}>
          {trying ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <CloudOff data-icon="inline-start" />} Try again
        </Button>
      }
    >
      You are signed in, and your work is safe in your account, but the server holding it did not answer{reason === null ? '' : ` (${reason.replace(/\.$/, '')})`}. The studio keeps trying in the background.
    </Notice>
  );
}

/** What this browser saved cannot be read at all, so the studio would otherwise wait for ever. */
function StorageStuck() {
  return (
    <Notice
      title="This browser’s saved studio data cannot be read"
      actions={
        <Button variant="destructive" onClick={resetLocalData}>
          <RotateCcw data-icon="inline-start" /> Reset local data
        </Button>
      }
    >
      Something stored for the studio in this browser is damaged. Resetting clears only what this browser kept; whatever is in your account is loaded again when you sign in.
    </Notice>
  );
}
