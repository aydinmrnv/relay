'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useClerk } from '@clerk/nextjs';
import { toast } from 'sonner';
import { CloudUpload, Loader2, LogIn, ShieldAlert, Trash2, UserPlus, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { SettingBlock } from '@/components/settings/settings-section';
import { useAccount } from '@/lib/cloud/account';
import { api, forgetAccount, importableGuestWorkflows, importGuestWorkflows, readGuestBackup, type GuestBackup } from '@/lib/cloud/sync';
import { timeAgo } from '@/lib/format';
import { useStudio } from '@/lib/store';
import { UserAvatar } from './user-avatar';

/**
 * Settings → Account. Profile, email addresses, password, connected
 * accounts, two-factor and devices are Clerk's own profile, opened as a
 * modal; here, what only the studio knows: guest work to bring in, and
 * deleting the account together with everything in it.
 */
export function AccountSettings() {
  const status = useAccount((state) => state.status);
  const user = useAccount((state) => state.user);
  if (status !== 'signed-in' || user === null) return <GuestAccountCard />;
  return (
    <Card className="gap-0 p-0">
      <ProfileSummary />
      <Separator />
      <ImportFromBrowser />
      <DeleteAccount />
    </Card>
  );
}

/** Deleting goes through the studio, so studio data goes with the account; Clerk's own delete button is hidden. */
export const PROFILE_APPEARANCE = { elements: { profileSection__danger: 'hidden' } };

function ProfileSummary() {
  const clerk = useClerk();
  const user = useAccount((state) => state.user)!;
  return (
    <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <UserAvatar user={user} size="lg" />
        <div className="min-w-0">
          <p className="truncate font-medium">{user.name}</p>
          <p className="truncate text-sm text-muted-foreground">{user.email}</p>
          <p className="text-xs text-muted-foreground" suppressHydrationWarning>
            Member since {new Date(user.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-1.5 sm:items-end">
        <Button variant="outline" onClick={() => clerk.openUserProfile({ appearance: PROFILE_APPEARANCE })}>
          <UserRound data-icon="inline-start" /> Manage account
        </Button>
        <p className="text-xs text-muted-foreground">Name, email, password, sign-in methods, two-factor and devices.</p>
      </div>
    </div>
  );
}

function GuestAccountCard() {
  const status = useAccount((state) => state.status);
  if (status === 'disabled') {
    return (
      <Card className="p-5 text-sm text-muted-foreground">
        This copy of the studio runs without accounts. Everything is kept in this browser; use “Your data” below to back it up or move it.
      </Card>
    );
  }
  return (
    <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
      <CloudUpload className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex-1">
        <p className="font-medium">You are using the studio as a guest</p>
        <p className="text-sm text-muted-foreground">A free account keeps your workflows and runs in any browser, adds public share links and version history, and nothing here is lost: you can bring it along when you sign up.</p>
      </div>
      <div className="flex gap-2">
        <Button nativeButton={false} render={<Link href="/sign-up?next=/settings" />}>
          <UserPlus data-icon="inline-start" /> Create account
        </Button>
        <Button variant="outline" nativeButton={false} render={<Link href="/sign-in?next=/settings" />}>
          <LogIn data-icon="inline-start" /> Sign in
        </Button>
      </div>
    </Card>
  );
}

function ImportFromBrowser() {
  const inAccount = useStudio((state) => state.workflows);
  const [backup, setBackup] = useState<GuestBackup | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // localStorage is only there after mounting; read it once, then.
    const timer = setTimeout(() => setBackup(readGuestBackup()), 0);
    return () => clearTimeout(timer);
  }, []);

  const candidates = useMemo(() => importableGuestWorkflows(backup, inAccount), [backup, inAccount]);
  const chosen = new Set(candidates.map((workflow) => workflow.id).filter((id) => !excluded.has(id)));
  const setChosen = (update: (current: Set<string>) => Set<string>) => {
    const next = update(chosen);
    setExcluded(new Set(candidates.map((workflow) => workflow.id).filter((id) => !next.has(id))));
  };

  if (candidates.length === 0) return null;

  const run = async () => {
    setBusy(true);
    try {
      const result = await importGuestWorkflows([...chosen]);
      toast.success(`Brought ${result.workflows} ${result.workflows === 1 ? 'workflow' : 'workflows'} into your account`, { description: result.skipped.length > 0 ? `Skipped: ${result.skipped.join('; ')}` : undefined });
    } catch (error) {
      toast.error('Could not import', { description: error instanceof Error ? error.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="p-5">
        <SettingBlock title="From before you signed in" description="Workflows you made as a guest in this browser. Bring any of them into your account.">
          <ul className="flex flex-col gap-1.5">
            {candidates.map((workflow) => (
              <li key={workflow.id}>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={chosen.has(workflow.id)}
                    onCheckedChange={(checked) =>
                      setChosen((current) => {
                        const next = new Set(current);
                        if (checked === true) next.add(workflow.id);
                        else next.delete(workflow.id);
                        return next;
                      })
                    }
                  />
                  <span className="flex-1 truncate">{workflow.name}</span>
                  <span className="text-xs text-muted-foreground" suppressHydrationWarning>
                    edited {timeAgo(workflow.updatedAt)}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <Button size="sm" className="mt-3 w-fit" onClick={() => void run()} disabled={busy || chosen.size === 0}>
            {busy ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <CloudUpload data-icon="inline-start" />}
            Import {chosen.size} {chosen.size === 1 ? 'workflow' : 'workflows'}
          </Button>
        </SettingBlock>
      </div>
      <Separator />
    </>
  );
}

function DeleteAccount() {
  const router = useRouter();
  const clerk = useClerk();
  const user = useAccount((state) => state.user)!;
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/api/account', { method: 'DELETE', body: { confirm: confirm.trim().toLowerCase() } });
    } catch (failure) {
      setBusy(false);
      setError(failure instanceof Error ? failure.message : 'Could not delete the account.');
      return;
    }
    setOpen(false);
    forgetAccount();
    await clerk.signOut().catch(() => undefined);
    toast.success('Your account and everything in it was deleted.');
    router.push('/');
  };

  return (
    <div className="p-5">
      <SettingBlock
        title="Delete your account"
        description="Deletes your account and every workflow, run, saved version and share link in it, immediately and for good. Download your data first if you want a copy."
        aside={
          <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
            <Trash2 data-icon="inline-start" /> Delete account
          </Button>
        }
      >
        {null}
      </SettingBlock>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <ShieldAlert />
            </AlertDialogMedia>
            <AlertDialogTitle>Delete {user.email || 'your account'}?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone. Workflows exported to a repository keep running there; everything stored here is gone.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="delete-confirm">
              Type <span className="font-mono">delete</span> to confirm
            </Label>
            <Input id="delete-confirm" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="off" />
            {error === null ? null : <p className="text-sm text-destructive">{error}</p>}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep my account</AlertDialogCancel>
            <Button variant="destructive" onClick={() => void remove()} disabled={busy || confirm.trim().toLowerCase() !== 'delete'}>
              {busy ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
              Delete for good
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
