'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Eye, Globe, Loader2, Lock, RefreshCw, Shuffle, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { CopyButton } from '@/components/runs/copy-button';
import { useBrand } from '@/hooks/use-brand';
import { useAccount } from '@/lib/cloud/account';
import { api, CloudError, flushNow } from '@/lib/cloud/sync';
import { withoutSecrets } from '@/lib/cloud/secrets';
import type { ShareSummary } from '@/lib/cloud/types';
import { timeAgo } from '@/lib/format';
import type { Workflow } from '@/lib/workflow/schema';

/**
 * Publish a workflow at a public link anyone can open, test and remix, with a
 * README badge that points at it. The public copy is a snapshot: editing the
 * workflow does not change it until "Update the public copy".
 */
export function ShareDialog({ workflow, open, onOpenChange }: { workflow: Workflow; open: boolean; onOpenChange: (open: boolean) => void }) {
  const signedIn = useAccount((state) => state.status === 'signed-in');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Globe className="size-4 text-muted-foreground" /> Share “{workflow.name}”
          </DialogTitle>
          <DialogDescription>A public page anyone can open, test-run in their own studio and remix — no account needed to look.</DialogDescription>
        </DialogHeader>
        {signedIn ? <ShareBody workflow={workflow} open={open} /> : <GuestShare />}
      </DialogContent>
    </Dialog>
  );
}

function GuestShare() {
  const pathname = usePathname();
  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">Share links live in your account, so they keep working after you close this browser. Create a free account — this workflow comes with you.</p>
      <DialogFooter>
        <Button variant="outline" nativeButton={false} render={<Link href={`/sign-in?next=${encodeURIComponent(pathname)}`} />}>
          Sign in
        </Button>
        <Button nativeButton={false} render={<Link href={`/sign-up?next=${encodeURIComponent(pathname)}`} />}>
          <UserPlus data-icon="inline-start" /> Create an account
        </Button>
      </DialogFooter>
    </div>
  );
}

function ShareBody({ workflow, open }: { workflow: Workflow; open: boolean }) {
  const brand = useBrand();
  const [share, setShare] = useState<ShareSummary | null | undefined>(undefined);
  const [busy, setBusy] = useState<'publish' | 'unpublish' | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api<{ share: ShareSummary | null }>(`/api/workflows/${encodeURIComponent(workflow.id)}/share`)
      .then((result) => {
        if (!cancelled) setShare(result.share);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // Not saved to the account yet is the same as not shared.
        setShare(null);
        if (!(error instanceof CloudError && error.status === 404)) toast.error('Could not check the share link', { description: error instanceof Error ? error.message : undefined });
      });
    return () => {
      cancelled = true;
    };
  }, [open, workflow.id]);

  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const url = share ? `${origin}/s/${share.slug}` : '';
  const badge = share ? `[![${brand.name} workflow: ${workflow.name.replace(/[[\]]/g, '')}](${origin}/api/badge/${share.slug})](${url})` : '';

  const publish = async () => {
    setBusy('publish');
    try {
      await flushNow();
      const result = await api<{ share: ShareSummary }>(`/api/workflows/${encodeURIComponent(workflow.id)}/share`, { method: 'POST', body: { workflow: withoutSecrets(workflow) } });
      const first = share === null;
      setShare(result.share);
      useAccount.setState((state) => ({ shares: { ...state.shares, [workflow.id]: result.share.slug } }));
      toast.success(first ? 'Your workflow is public' : 'Public copy updated', { description: first ? 'Anyone with the link can view and remix it.' : undefined });
    } catch (error) {
      toast.error('Could not publish', { description: error instanceof Error ? error.message : undefined });
    } finally {
      setBusy(null);
    }
  };

  const unpublish = async () => {
    setBusy('unpublish');
    try {
      await api(`/api/workflows/${encodeURIComponent(workflow.id)}/share`, { method: 'DELETE' });
      setShare(null);
      useAccount.setState((state) => {
        const shares = { ...state.shares };
        delete shares[workflow.id];
        return { shares };
      });
      toast.success('No longer shared', { description: 'The link now shows “not found”. Remixes people already made are theirs.' });
    } catch (error) {
      toast.error('Could not stop sharing', { description: error instanceof Error ? error.message : undefined });
    } finally {
      setBusy(null);
    }
  };

  if (share === undefined) {
    return (
      <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Checking…
      </p>
    );
  }

  if (share === null) {
    return (
      <div className="flex flex-col gap-4">
        <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
          <li className="flex gap-2">
            <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> Secrets, links, email addresses, people’s logins and your repository name are removed from the public copy. Choices, numbers and plain text stay.
          </li>
          <li className="flex gap-2">
            <Shuffle className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> Anyone can remix it into their own studio; your workflow is never changed by them.
          </li>
          <li className="flex gap-2">
            <RefreshCw className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> The public copy is a snapshot. Update it whenever you want; stop sharing at any time.
          </li>
        </ul>
        <DialogFooter>
          <Button onClick={() => void publish()} disabled={busy !== null}>
            {busy === 'publish' ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Globe data-icon="inline-start" />}
            Create a public link
          </Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium text-muted-foreground">Public link</p>
        <div className="flex gap-2">
          <Input readOnly value={url} onFocus={(event) => event.currentTarget.select()} className="font-mono text-xs" />
          <CopyButton value={url} />
        </div>
        <p className="flex items-center gap-3 text-xs text-muted-foreground" suppressHydrationWarning>
          <span className="inline-flex items-center gap-1">
            <Eye className="size-3" /> {share.views} {share.views === 1 ? 'view' : 'views'}
          </span>
          <span className="inline-flex items-center gap-1">
            <Shuffle className="size-3" /> {share.remixes} {share.remixes === 1 ? 'remix' : 'remixes'}
          </span>
          <span>updated {timeAgo(share.updatedAt)}</span>
          <a href={url} target="_blank" rel="noreferrer" className="ml-auto font-medium text-foreground underline-offset-4 hover:underline">
            Open
          </a>
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium text-muted-foreground">README badge</p>
        {/* eslint-disable-next-line @next/next/no-img-element -- an SVG badge from our own API, exactly as GitHub will show it */}
        <img src={`/api/badge/${share.slug}`} alt="" className="h-5 w-fit" />
        <div className="flex gap-2">
          <Input readOnly value={badge} onFocus={(event) => event.currentTarget.select()} className="font-mono text-xs" />
          <CopyButton value={badge} />
        </div>
      </div>
      <DialogFooter className="sm:justify-between">
        <Button variant="ghost" onClick={() => void unpublish()} disabled={busy !== null} className="text-destructive hover:text-destructive">
          {busy === 'unpublish' ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
          Stop sharing
        </Button>
        <Button variant="outline" onClick={() => void publish()} disabled={busy !== null}>
          {busy === 'publish' ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
          Update the public copy
        </Button>
      </DialogFooter>
    </div>
  );
}
