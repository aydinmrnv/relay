'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { BadgeCheck, CloudUpload, KeyRound, Laptop, Loader2, LogIn, MailWarning, ShieldAlert, Trash2, UserPlus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
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
import { AppMark } from '@/components/marketing/primitives';
import { PasswordInput } from '@/components/auth/password-input';
import { SettingBlock } from '@/components/settings/settings-section';
import { authClient, authErrorMessage } from '@/lib/auth-client';
import { useAccount, useCapabilities } from '@/lib/cloud/account';
import { forgetAccount, importableGuestWorkflows, importGuestWorkflows, readGuestBackup, type GuestBackup } from '@/lib/cloud/sync';
import { useStudio } from '@/lib/store';
import { timeAgo } from '@/lib/format';
import { UserAvatar } from './user-avatar';

interface LinkedAccount {
  id: string;
  providerId: string;
  accountId: string;
}

interface SessionRow {
  id: string;
  token: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

/** Settings → Account: who you are, how you sign in, where you are signed in, and leaving. */
export function AccountSettings() {
  const status = useAccount((state) => state.status);
  const user = useAccount((state) => state.user);
  if (status !== 'signed-in' || user === null) return <GuestAccountCard />;
  return (
    <Card className="gap-0 p-0">
      <ProfileBlock />
      <Separator />
      <SignInMethods />
      <Separator />
      <SessionsBlock />
      <ImportFromBrowser />
      <Separator />
      <DeleteAccount />
    </Card>
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
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <CloudUpload className="size-5" aria-hidden />
      </span>
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

function ProfileBlock() {
  const user = useAccount((state) => state.user)!;
  const canEmail = useCapabilities().email;
  const [name, setName] = useState(user.name);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);

  const save = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed === user.name) return;
    setSaving(true);
    const { error } = await authClient.updateUser({ name: trimmed });
    setSaving(false);
    if (error) {
      toast.error('Could not save your name', { description: authErrorMessage(error) });
      return;
    }
    useAccount.setState({ user: { ...user, name: trimmed } });
    toast.success('Name saved');
  };

  const verify = async () => {
    setSending(true);
    const { error } = await authClient.sendVerificationEmail({ email: user.email, callbackURL: '/settings#account' });
    setSending(false);
    if (error) toast.error('Could not send the email', { description: authErrorMessage(error) });
    else toast.success('Check your inbox', { description: `A confirmation link is on its way to ${user.email}.` });
  };

  return (
    <div className="flex flex-col gap-5 p-5">
      <div className="flex items-center gap-3">
        <UserAvatar user={user} size="lg" />
        <div className="min-w-0">
          <p className="truncate font-medium">{user.name}</p>
          <p className="flex items-center gap-1.5 truncate text-sm text-muted-foreground">
            {user.email}
            {user.emailVerified ? (
              <Badge variant="secondary" className="gap-1 text-success">
                <BadgeCheck className="size-3" /> Verified
              </Badge>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground" suppressHydrationWarning>
            Member since {new Date(user.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
          </p>
        </div>
      </div>
      <SettingBlock title="Name" description="Shown on workflows you share." htmlFor="account-name">
        <div className="flex max-w-md gap-2">
          <Input id="account-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} onKeyDown={(event) => event.key === 'Enter' && void save()} />
          <Button variant="outline" onClick={() => void save()} disabled={saving || name.trim().length === 0 || name.trim() === user.name}>
            {saving ? <Loader2 className="animate-spin" /> : 'Save'}
          </Button>
        </div>
      </SettingBlock>
      {!user.emailVerified && canEmail ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5 text-sm">
          <MailWarning className="size-4 text-warning" aria-hidden />
          <span className="flex-1">Confirm your email so you can reset your password if you ever need to.</span>
          <Button size="sm" variant="outline" onClick={() => void verify()} disabled={sending}>
            {sending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
            Send the link again
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function SignInMethods() {
  const github = useCapabilities().github;
  const [accounts, setAccounts] = useState<LinkedAccount[] | null>(null);
  const [changing, setChanging] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void authClient.listAccounts().then(({ data }) => {
      if (!cancelled) setAccounts((data as LinkedAccount[] | null) ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const hasPassword = accounts?.some((account) => account.providerId === 'credential') ?? false;
  const hasGitHub = accounts?.some((account) => account.providerId === 'github') ?? false;

  const linkGitHub = async () => {
    const { error } = await authClient.linkSocial({ provider: 'github', callbackURL: '/settings#account' });
    if (error) toast.error('Could not link GitHub', { description: authErrorMessage(error) });
  };

  return (
    <div className="flex flex-col gap-4 p-5">
      <SettingBlock title="Sign-in methods" description="Ways to get into this account.">
        {accounts === null ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Checking…
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            <li className="flex items-center gap-3 rounded-lg border px-3 py-2 text-sm">
              <KeyRound className="size-4 text-muted-foreground" aria-hidden />
              <span className="flex-1">Email and password</span>
              {hasPassword ? (
                <Button size="sm" variant="outline" onClick={() => setChanging((value) => !value)}>
                  {changing ? 'Cancel' : 'Change password'}
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">Not set</span>
              )}
            </li>
            {github || hasGitHub ? (
              <li className="flex items-center gap-3 rounded-lg border px-3 py-2 text-sm">
                <AppMark connector="github" size={16} />
                <span className="flex-1">GitHub</span>
                {hasGitHub ? (
                  <Badge variant="secondary">Linked</Badge>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => void linkGitHub()}>
                    Link GitHub
                  </Button>
                )}
              </li>
            ) : null}
          </ul>
        )}
      </SettingBlock>
      {changing ? <ChangePassword onDone={() => setChanging(false)} /> : null}
    </div>
  );
}

function ChangePassword({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [revokeOthers, setRevokeOthers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (next.length < 8) {
      setError('Use at least 8 characters.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: failure } = await authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: revokeOthers });
    setBusy(false);
    if (failure) {
      setError(authErrorMessage(failure, 'Could not change the password.'));
      return;
    }
    toast.success('Password changed', { description: revokeOthers ? 'Every other session was signed out.' : undefined });
    onDone();
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex max-w-md flex-col gap-3 rounded-lg border bg-muted/30 p-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="current-password">Current password</Label>
        <PasswordInput id="current-password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-password">New password</Label>
        <PasswordInput id="new-password" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} required minLength={8} />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={revokeOthers} onCheckedChange={(checked) => setRevokeOthers(checked === true)} />
        Sign out everywhere else
      </label>
      {error === null ? null : <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" className="w-fit" disabled={busy || current.length === 0 || next.length === 0}>
        {busy ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
        Change password
      </Button>
    </form>
  );
}

function describeAgent(userAgent: string | null | undefined): string {
  if (userAgent === null || userAgent === undefined || userAgent.length === 0) return 'Unknown device';
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Chrome\//.test(userAgent) ? 'Chrome' : /Firefox\//.test(userAgent) ? 'Firefox' : /Safari\//.test(userAgent) ? 'Safari' : 'A browser';
  const os = /iPhone|iPad/.test(userAgent) ? 'iOS' : /Android/.test(userAgent) ? 'Android' : /Mac OS X/.test(userAgent) ? 'macOS' : /Windows/.test(userAgent) ? 'Windows' : /Linux/.test(userAgent) ? 'Linux' : 'another system';
  return `${browser} on ${os}`;
}

function SessionsBlock() {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [list, mine] = await Promise.all([authClient.listSessions(), authClient.getSession()]);
    setSessions(((list.data as SessionRow[] | null) ?? []).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))));
    setCurrent(mine.data?.session.id ?? null);
  };

  useEffect(() => {
    let cancelled = false;
    void Promise.all([authClient.listSessions(), authClient.getSession()]).then(([list, mine]) => {
      if (cancelled) return;
      setSessions(((list.data as SessionRow[] | null) ?? []).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))));
      setCurrent(mine.data?.session.id ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const revokeOthers = async () => {
    setBusy(true);
    const { error } = await authClient.revokeOtherSessions();
    setBusy(false);
    if (error) toast.error('Could not sign out the other sessions', { description: authErrorMessage(error) });
    else toast.success('Signed out everywhere else');
    await load();
  };

  const others = (sessions ?? []).filter((session) => session.id !== current).length;

  return (
    <div className="p-5">
      <SettingBlock
        title="Where you are signed in"
        description="Every browser with a session on this account."
        aside={
          others > 0 ? (
            <Button size="sm" variant="outline" onClick={() => void revokeOthers()} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
              Sign out the others
            </Button>
          ) : null
        }
      >
        {sessions === null ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {sessions.map((session) => (
              <li key={session.id} className="flex items-center gap-3 rounded-lg border px-3 py-2 text-sm">
                <Laptop className="size-4 text-muted-foreground" aria-hidden />
                <span className="flex-1">
                  {describeAgent(session.userAgent)}
                  <span className="block text-xs text-muted-foreground" suppressHydrationWarning>
                    {session.ipAddress ?? 'unknown address'} · active {timeAgo(new Date(session.updatedAt).toISOString())}
                  </span>
                </span>
                {session.id === current ? <Badge variant="secondary">This browser</Badge> : null}
              </li>
            ))}
          </ul>
        )}
      </SettingBlock>
    </div>
  );
}

/** A guest's workflows from before signing in, still in this browser, that are not in the account yet. */
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
      <Separator />
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
    </>
  );
}

function DeleteAccount() {
  const router = useRouter();
  const user = useAccount((state) => state.user)!;
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    const { error: failure } = await authClient.deleteUser(password.length > 0 ? { password } : {});
    setBusy(false);
    if (failure) {
      setError(
        failure.code === 'SESSION_EXPIRED' || failure.code === 'SESSION_NOT_FRESH'
          ? 'For safety, sign out and back in, then delete the account within a day.'
          : authErrorMessage(failure, 'Could not delete the account.'),
      );
      return;
    }
    setOpen(false);
    forgetAccount();
    toast.success('Your account and everything in it was deleted.');
    router.push('/');
  };

  return (
    <div className="p-5">
      <SettingBlock
        title="Delete your account"
        description="Deletes your account, every workflow, run, saved version and share link in it, immediately and for good. Download your data first if you want a copy."
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
            <AlertDialogTitle>Delete {user.email}?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone. Workflows exported to a repository keep running there; everything stored here is gone.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="delete-password">Your password (leave empty if you only use GitHub)</Label>
              <PasswordInput id="delete-password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="delete-confirm">
                Type <span className="font-mono">delete</span> to confirm
              </Label>
              <Input id="delete-confirm" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="off" />
            </div>
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
