'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Bookmark, History, Loader2, RotateCcw, Trash2, UserPlus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { GraphThumbnail } from '@/components/templates/graph-thumbnail';
import { useAccount, useCapabilities } from '@/lib/cloud/account';
import { useCombo } from '@/hooks/use-key-label';
import { api, flushNow } from '@/lib/cloud/sync';
import { withLocalSecrets, withoutSecrets } from '@/lib/cloud/secrets';
import type { VersionSummary } from '@/lib/cloud/types';
import { formatDateTime, timeAgo } from '@/lib/format';
import type { Workflow } from '@/lib/workflow/schema';
import { cn } from '@/lib/utils';

/**
 * Every saved state of a workflow: one taken automatically before each
 * editing session, and any saved by hand with a name. Restoring is one more
 * edit on the canvas, so ⌘Z takes it back.
 */
export function HistorySheet({ workflow, open, onOpenChange, onRestore }: { workflow: Workflow; open: boolean; onOpenChange: (open: boolean) => void; onRestore: (version: Workflow, label: string) => void }) {
  const signedIn = useAccount((state) => state.status === 'signed-in');
  const combo = useCombo();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[92vw] gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2">
            <History className="size-4 text-muted-foreground" /> Version history
          </SheetTitle>
          <SheetDescription>
            {signedIn ? <>Saved automatically before each editing session, and whenever you save one by hand. Restore any of them; {combo('mod', 'Z')} undoes a restore.</> : 'Every earlier state of this workflow, to go back to.'}
          </SheetDescription>
        </SheetHeader>
        {signedIn ? <Versions workflow={workflow} open={open} onRestore={onRestore} /> : <GuestHistory />}
      </SheetContent>
    </Sheet>
  );
}

function GuestHistory() {
  const pathname = usePathname();
  // A deployment without sign-in has nothing to send anyone to.
  const accounts = useCapabilities().enabled;
  return (
    <div className="flex flex-col gap-3 p-4 text-sm text-muted-foreground">
      <p>Version history is kept in your account, so a bad afternoon of edits is never more than a click from undone — on any device.</p>
      {accounts ? (
        <Button className="w-fit" nativeButton={false} render={<Link href={`/sign-up?next=${encodeURIComponent(pathname)}`} />}>
          <UserPlus data-icon="inline-start" /> Create a free account
        </Button>
      ) : (
        <p>Accounts are not switched on for this copy of the studio. Until they are, undo and redo cover the session you are in.</p>
      )}
    </div>
  );
}

function Versions({ workflow, open, onRestore }: { workflow: Workflow; open: boolean; onRestore: (version: Workflow, label: string) => void }) {
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, Workflow>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // Why the list could not be loaded: not the same thing as a list with nothing in it.
  const [loadError, setLoadError] = useState<string | null>(null);
  // Versions whose graph could not be fetched, so the preview can say so instead of spinning.
  const [unavailable, setUnavailable] = useState<Record<string, true>>({});
  // The version whose delete button has been pressed once, and asks to be pressed again.
  const [confirming, setConfirming] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const result = await api<{ versions: VersionSummary[] }>(`/api/workflows/${encodeURIComponent(workflow.id)}/versions`);
      setVersions(result.versions);
    } catch (error) {
      setVersions(null);
      setLoadError(error instanceof Error ? error.message : 'The server did not answer.');
    }
  }, [workflow.id]);

  useEffect(() => {
    if (!open) return;
    // Send any pending edits first, so the list includes the snapshot they may have triggered.
    const timer = setTimeout(() => void flushNow().then(refresh), 0);
    return () => clearTimeout(timer);
  }, [open, refresh]);

  const fetchVersion = async (id: string): Promise<Workflow | null> => {
    if (previews[id] !== undefined) return previews[id];
    setUnavailable((current) => {
      if (current[id] === undefined) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    try {
      const result = await api<{ workflow: Workflow }>(`/api/workflows/${encodeURIComponent(workflow.id)}/versions/${encodeURIComponent(id)}`);
      setPreviews((current) => ({ ...current, [id]: result.workflow }));
      return result.workflow;
    } catch (error) {
      setUnavailable((current) => ({ ...current, [id]: true }));
      toast.error('Could not open that version', { description: error instanceof Error ? error.message : undefined });
      return null;
    }
  };

  const toggle = async (id: string) => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    await fetchVersion(id);
  };

  const restore = async (version: VersionSummary) => {
    setBusy(version.id);
    const data = await fetchVersion(version.id);
    setBusy(null);
    if (data === null) return;
    onRestore(withLocalSecrets(data, workflow), version.label ?? `the version from ${timeAgo(version.createdAt)}`);
  };

  const remove = async (version: VersionSummary) => {
    // A saved version cannot be brought back, so the first press only arms the button.
    if (confirming !== version.id) {
      setConfirming(version.id);
      return;
    }
    setConfirming(null);
    setBusy(version.id);
    try {
      await api(`/api/workflows/${encodeURIComponent(workflow.id)}/versions/${encodeURIComponent(version.id)}`, { method: 'DELETE' });
      setVersions((list) => (list ?? []).filter((entry) => entry.id !== version.id));
    } catch (error) {
      toast.error('Could not delete that version', { description: error instanceof Error ? error.message : undefined });
    } finally {
      setBusy(null);
    }
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const result = await api<{ version: VersionSummary }>(`/api/workflows/${encodeURIComponent(workflow.id)}/versions`, { method: 'POST', body: { label: label.trim() || 'Saved version', workflow: withoutSecrets(workflow) } });
      setVersions((list) => [result.version, ...(list ?? [])]);
      setPreviews((current) => ({ ...current, [result.version.id]: workflow }));
      setLabel('');
      toast.success('Version saved', { description: result.version.label ?? undefined });
    } catch (error) {
      toast.error('Could not save a version', { description: error instanceof Error ? error.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form onSubmit={(event) => void save(event)} className="flex gap-2 border-b p-4">
        <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Name this version, e.g. “before adding approvals”" maxLength={120} aria-label="Version name" />
        <Button type="submit" disabled={saving}>
          {saving ? <Loader2 className="animate-spin" /> : <Bookmark />}
          Save
        </Button>
      </form>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loadError !== null ? (
          <div className="flex flex-col items-start gap-2 p-3 text-sm">
            <p className="text-pretty text-muted-foreground">
              <span className="font-medium text-foreground">The history could not be loaded.</span> {loadError} The versions are still in your account.
            </p>
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              <RotateCcw data-icon="inline-start" /> Try again
            </Button>
          </div>
        ) : versions === null ? (
          <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </p>
        ) : versions.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">No versions yet. The first is taken automatically the next time you start editing after a break, or save one now.</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {versions.map((version) => (
              <li key={version.id} className={cn('rounded-lg border border-transparent', expanded === version.id && 'border-border bg-muted/40')}>
                <button type="button" onClick={() => void toggle(version.id)} className="flex w-full items-start gap-3 rounded-lg p-2.5 text-left hover:bg-muted/60" aria-expanded={expanded === version.id}>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <span className="truncate">{version.label ?? 'Before an editing session'}</span>
                      {version.auto ? null : <Badge variant="secondary">named</Badge>}
                    </span>
                    <span className="block text-xs text-muted-foreground" title={formatDateTime(version.createdAt)} suppressHydrationWarning>
                      {timeAgo(version.createdAt)} · {version.nodeCount} nodes, {version.edgeCount} connections
                    </span>
                  </span>
                </button>
                {expanded === version.id ? (
                  <div className="flex flex-col gap-2 px-2.5 pb-2.5">
                    {unavailable[version.id] === true ? (
                      <div className="flex h-32 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-xs text-muted-foreground">
                        This version could not be loaded.
                        <Button size="xs" variant="outline" onClick={() => void fetchVersion(version.id)}>
                          Try again
                        </Button>
                      </div>
                    ) : previews[version.id] === undefined ? (
                      <div className="flex h-32 items-center justify-center rounded-lg border border-dashed">
                        <Loader2 className="size-4 animate-spin text-muted-foreground" />
                      </div>
                    ) : (
                      <GraphThumbnail workflow={previews[version.id]!} className="h-32" />
                    )}
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => void restore(version)} disabled={busy !== null}>
                        {busy === version.id ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <RotateCcw data-icon="inline-start" />}
                        Restore this version
                      </Button>
                      <Button
                        size="sm"
                        variant={confirming === version.id ? 'destructive' : 'ghost'}
                        className={cn('ml-auto', confirming === version.id ? '' : 'text-muted-foreground')}
                        onClick={() => void remove(version)}
                        onBlur={() => setConfirming((current) => (current === version.id ? null : current))}
                        disabled={busy !== null}
                        aria-label={confirming === version.id ? 'Press again to delete this version for good' : 'Delete this version'}
                      >
                        <Trash2 /> {confirming === version.id ? 'Delete for good?' : null}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
