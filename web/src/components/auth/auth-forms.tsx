'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowRight, CheckCircle2, Loader2, MailCheck } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSeparator } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { AppMark } from '@/components/marketing/primitives';
import { authClient, authErrorMessage } from '@/lib/auth-client';
import { setSessionHint, useCapabilities } from '@/lib/cloud/account';
import { importableGuestWorkflows, signedIn } from '@/lib/cloud/sync';
import { useStudio } from '@/lib/store';
import { useBrand } from '@/hooks/use-brand';
import { safeNext } from '@/lib/safe-next';
import { PasswordChecklist, PasswordInput } from './password-input';

function Heading({ title, description }: { title: string; description: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-1.5">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function ErrorLine({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <Alert variant="destructive" className="py-2">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function GitHubButton({ next, newUser, disabled }: { next: string; newUser: string; disabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    // The browser leaves for GitHub now; the hint makes the page it comes back to ask who signed in.
    setSessionHint(true);
    const { error: failure } = await authClient.signIn.social({ provider: 'github', callbackURL: next, newUserCallbackURL: newUser, errorCallbackURL: '/sign-in?error=github' });
    if (failure) {
      setSessionHint(false);
      setError(authErrorMessage(failure, 'GitHub sign-in could not start.'));
      setBusy(false);
    }
  };
  return (
    <>
      <Button type="button" variant="outline" size="lg" className="w-full" onClick={() => void go()} disabled={disabled || busy}>
        {busy ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <AppMark connector="github" size={16} />}
        Continue with GitHub
      </Button>
      <ErrorLine message={error} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Sign up                                                              */
/* ------------------------------------------------------------------ */

export function SignUpForm({ next, initialError }: { next: string | null; initialError?: string | null }) {
  const router = useRouter();
  const brand = useBrand();
  const capabilities = useCapabilities();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const destination = safeNext(next, '/onboarding');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password.length < 8) {
      setError('Use at least 8 characters for your password.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: failure } = await authClient.signUp.email({ name: name.trim() || email.split('@')[0] || 'Builder', email: email.trim(), password, callbackURL: '/dashboard' });
    if (failure) {
      setError(authErrorMessage(failure, 'Could not create the account.'));
      setBusy(false);
      return;
    }
    await signedIn();
    router.replace(destination);
  };

  return (
    <>
      <Heading
        title={`Create your ${brand.name} account`}
        description="Free while in beta. Your workflows follow you to any browser, and you get sharing and version history."
      />
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        {capabilities.github ? (
          <>
            <GitHubButton next={destination === '/onboarding' ? '/dashboard' : destination} newUser="/onboarding" disabled={busy} />
            <FieldSeparator>or with email</FieldSeparator>
          </>
        ) : null}
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input id="name" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Ada Lovelace" maxLength={80} autoFocus />
          </Field>
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input id="email" type="email" autoComplete="email" inputMode="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required />
          </Field>
          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <PasswordInput id="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} maxLength={128} />
            {password.length > 0 ? <PasswordChecklist password={password} /> : <FieldDescription>At least 8 characters.</FieldDescription>}
          </Field>
        </FieldGroup>
        <ErrorLine message={error} />
        <Button type="submit" size="lg" className="w-full" disabled={busy || email.trim().length === 0 || password.length === 0}>
          {busy ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
          Create account
          {busy ? null : <ArrowRight data-icon="inline-end" />}
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          By creating an account you agree to the{' '}
          <Link href="/terms" className="underline underline-offset-4 hover:text-foreground">
            terms
          </Link>{' '}
          and{' '}
          <Link href="/privacy" className="underline underline-offset-4 hover:text-foreground">
            privacy policy
          </Link>
          .
        </p>
      </form>
      <GuestWorkNote />
      <p className="mt-6 text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link href={next === null ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`} className="font-medium text-foreground underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}

/** Tells a guest their browser work is not lost by signing up. */
function GuestWorkNote() {
  // Through the store, whose server snapshot is empty, so hydration matches.
  const count = useStudio((state) => (state.owner === null ? importableGuestWorkflows({ savedAt: '', workflows: Object.values(state.workflows), runs: [] }).length : 0));
  if (count === 0) return null;
  return (
    <p className="mt-4 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
      You have {count === 1 ? 'a workflow' : `${count} workflows`} in this browser. You can bring {count === 1 ? 'it' : 'them'} into your account in the next step.
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* Sign in                                                              */
/* ------------------------------------------------------------------ */

export function SignInForm({ next, initialError }: { next: string | null; initialError?: string | null }) {
  const router = useRouter();
  const capabilities = useCapabilities();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const destination = safeNext(next, '/dashboard');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: failure } = await authClient.signIn.email({ email: email.trim(), password, rememberMe: true });
    if (failure) {
      setError(authErrorMessage(failure, 'Could not sign in.'));
      setBusy(false);
      return;
    }
    await signedIn();
    router.replace(destination);
  };

  return (
    <>
      <Heading title="Welcome back" description="Sign in to pick up your workflows where you left them." />
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        {capabilities.github ? (
          <>
            <GitHubButton next={destination} newUser="/onboarding" disabled={busy} />
            <FieldSeparator>or with email</FieldSeparator>
          </>
        ) : null}
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input id="email" type="email" autoComplete="email" inputMode="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required autoFocus />
          </Field>
          <Field>
            <div className="flex items-center justify-between gap-2">
              <FieldLabel htmlFor="password">Password</FieldLabel>
              {capabilities.email ? (
                <Link href="/forgot-password" className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                  Forgot it?
                </Link>
              ) : null}
            </div>
            <PasswordInput id="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          </Field>
        </FieldGroup>
        <ErrorLine message={error} />
        <Button type="submit" size="lg" className="w-full" disabled={busy || email.trim().length === 0 || password.length === 0}>
          {busy ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
          Sign in
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted-foreground">
        New here?{' '}
        <Link href={next === null ? '/sign-up' : `/sign-up?next=${encodeURIComponent(next)}`} className="font-medium text-foreground underline-offset-4 hover:underline">
          Create an account
        </Link>
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Password reset                                                       */
/* ------------------------------------------------------------------ */

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: failure } = await authClient.requestPasswordReset({ email: email.trim(), redirectTo: '/reset-password' });
    setBusy(false);
    if (failure) {
      setError(authErrorMessage(failure, 'Could not send the link.'));
      return;
    }
    setSent(true);
  };

  if (sent) {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <MailCheck className="size-6" aria-hidden />
        </span>
        <h1 className="text-2xl font-semibold tracking-tight">Check your inbox</h1>
        <p className="text-sm text-muted-foreground">
          If an account uses <span className="font-medium text-foreground">{email}</span>, a link to choose a new password is on its way. It works once, for an hour.
        </p>
        <Button variant="outline" className="mt-2" nativeButton={false} render={<Link href="/sign-in" />}>
          Back to sign in
        </Button>
      </div>
    );
  }

  return (
    <>
      <Heading title="Reset your password" description="Enter the email you signed up with and we will send you a link." />
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input id="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required autoFocus />
        </Field>
        <ErrorLine message={error} />
        <Button type="submit" size="lg" className="w-full" disabled={busy || email.trim().length === 0}>
          {busy ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
          Send the link
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted-foreground">
        Remembered it?{' '}
        <Link href="/sign-in" className="font-medium text-foreground underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}

export function ResetPasswordForm({ token, initialError }: { token: string | null; initialError: string | null }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(token === null ? 'This link is missing its token. Ask for a new one.' : initialError);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (token === null) return;
    if (password.length < 8) {
      setError('Use at least 8 characters.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: failure } = await authClient.resetPassword({ newPassword: password, token });
    setBusy(false);
    if (failure) {
      setError(authErrorMessage(failure, 'Could not change the password.'));
      return;
    }
    setDone(true);
  };

  if (done) {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-success/15 text-success">
          <CheckCircle2 className="size-6" aria-hidden />
        </span>
        <h1 className="text-2xl font-semibold tracking-tight">Password changed</h1>
        <p className="text-sm text-muted-foreground">Every other session was signed out. Sign in with the new password.</p>
        <Button className="mt-2" nativeButton={false} render={<Link href="/sign-in" />}>
          Sign in
        </Button>
      </div>
    );
  }

  return (
    <>
      <Heading title="Choose a new password" description="Pick something you do not use anywhere else." />
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        <Field>
          <FieldLabel htmlFor="password">New password</FieldLabel>
          <PasswordInput id="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} autoFocus disabled={token === null} />
          {password.length > 0 ? <PasswordChecklist password={password} /> : null}
        </Field>
        <ErrorLine message={error} />
        <Button type="submit" size="lg" className="w-full" disabled={busy || token === null || password.length === 0}>
          {busy ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}
          Change password
        </Button>
      </form>
      {token === null || initialError !== null ? (
        <p className="mt-6 text-center text-sm">
          <Link href="/forgot-password" className="font-medium underline-offset-4 hover:underline">
            Send a new link
          </Link>
        </p>
      ) : null}
    </>
  );
}

/** What a page says when this deployment has no accounts, instead of a form that cannot work. */
export function AccountsUnavailable() {
  const reason = useCapabilities().reason;
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">Accounts are not switched on here</h1>
      <p className="text-sm text-muted-foreground">This copy of the studio runs without accounts. Everything still works, and your work is kept in this browser.</p>
      {reason === null ? null : <p className="rounded-lg border border-dashed px-3 py-2 font-mono text-xs text-muted-foreground">{reason}</p>}
      <Button className="mt-2 w-fit" nativeButton={false} render={<Link href="/dashboard" />}>
        Open the studio
        <ArrowRight data-icon="inline-end" />
      </Button>
    </div>
  );
}
