'use client';

import Link from 'next/link';
import { useSyncExternalStore } from 'react';
import { SignIn, SignUp } from '@clerk/nextjs';
import { ArrowRight, Check, Cloud, Laptop } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useCapabilities } from '@/lib/cloud/account';
import { importableGuestWorkflows } from '@/lib/cloud/sync';
import { useStudio } from '@/lib/store';

/** Clerk's card, flattened into the page: the auth shell already frames it. */
const APPEARANCE = {
  elements: {
    rootBox: 'w-full',
    cardBox: 'w-full shadow-none border-0',
    card: 'shadow-none border-0 bg-transparent px-0',
    footer: 'bg-transparent',
  },
};

const noop = () => () => undefined;

/**
 * True only after hydration. Clerk's components render nothing on the
 * server but render themselves at once on a client where Clerk has already
 * loaded, which React reports as a mismatch and answers by re-rendering the
 * whole page; waiting for hydration keeps the two in step.
 */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}

function FormPlaceholder() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="mx-auto h-6 w-48" />
      <Skeleton className="mx-auto h-4 w-64" />
      <Skeleton className="mt-4 h-9 w-full" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-full" />
    </div>
  );
}

/**
 * Sign in or sign up, in one form: "Try it free" and "Sign in" both land
 * here, and an email Clerk does not know carries on into making an account
 * (`withSignUp`) instead of stopping at "no such account".
 */
export function ClerkSignIn({ next }: { next: string }) {
  const hydrated = useHydrated();
  if (!hydrated) return <FormPlaceholder />;
  return (
    <div className="flex flex-col gap-4">
      <SignIn
        routing="path"
        path="/sign-in"
        withSignUp
        appearance={APPEARANCE}
        fallbackRedirectUrl={next}
        signUpUrl={next === '/dashboard' ? '/sign-up' : `/sign-up?next=${encodeURIComponent(next)}`}
        // A new account made from here goes where the visitor was headed, like one made on the sign-up page.
        signUpFallbackRedirectUrl={next === '/dashboard' ? '/onboarding' : next}
      />
      <Agreement />
      <AccountWhy />
    </div>
  );
}

export function ClerkSignUp({ next }: { next: string }) {
  const hydrated = useHydrated();
  return (
    <div className="flex flex-col gap-4">
      {hydrated ? null : <FormPlaceholder />}
      {hydrated ? <SignUp
        routing="path"
        path="/sign-up"
        appearance={APPEARANCE}
        fallbackRedirectUrl={next}
        signInUrl={next === '/onboarding' ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`}
        signInFallbackRedirectUrl="/dashboard"
      /> : null}
      <Agreement />
      <GuestWorkNote />
      <AccountWhy />
    </div>
  );
}

function Agreement() {
  return (
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
  );
}

/**
 * What the account is for, next to the form that makes one: the studio needs
 * it, and Relay Cloud is reached with its session. Your own computer, paired
 * with relay connect, is the other runner; the link compares the two.
 */
function AccountWhy() {
  return (
    <div className="grid gap-1.5 text-xs text-pretty text-muted-foreground">
      <p className="font-medium text-foreground">What your account gives you</p>
      <ul className="grid gap-1">
        <li className="flex gap-1.5">
          <Check className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
          <span>Your workflows, runs and settings in every browser you sign in to, with version history and public share links.</span>
        </li>
        <li className="flex gap-1.5">
          <Cloud className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
          <span>
            <strong className="font-medium text-foreground">Relay Cloud</strong>: a machine of your own that Relay runs and wakes for you, with nothing to install.
          </span>
        </li>
        <li className="flex gap-1.5">
          <Laptop className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
          <span>
            Or your own computer, paired with relay connect, running on the Claude and Codex plans you already have.{' '}
            <Link href="/runners" className="underline underline-offset-4 hover:text-foreground">
              See the two side by side
            </Link>
            .
          </span>
        </li>
      </ul>
    </div>
  );
}

/** Tells a guest their browser work is not lost by signing up. */
function GuestWorkNote() {
  // Through the store, whose server snapshot is empty, so hydration matches.
  const count = useStudio((state) => (state.owner === null ? importableGuestWorkflows({ savedAt: '', workflows: Object.values(state.workflows), runs: [] }).length : 0));
  if (count === 0) return null;
  return (
    <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
      You have {count === 1 ? 'a workflow' : `${count} workflows`} in this browser. You can bring {count === 1 ? 'it' : 'them'} into your account in the next step.
    </p>
  );
}

/**
 * What a sign-in page says when this deployment has no accounts, instead of
 * a form that cannot work. A development copy opens the studio anyway; any
 * other has it closed until its keys and database are set.
 */
export function AccountsUnavailable() {
  const { guests, reason } = useCapabilities();
  if (!guests) {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Sign-in is not available right now</h1>
        <p className="text-sm text-pretty text-muted-foreground">The studio needs an account, and accounts are not switched on here yet, so it is closed for now. Please come back a little later.</p>
        <Button variant="outline" className="mt-2 w-fit" nativeButton={false} render={<Link href="/" />}>
          Back to the site
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">Accounts are not switched on here</h1>
      <p className="text-sm text-pretty text-muted-foreground">This development copy runs without accounts, so the studio opens without signing in and keeps your work in this browser. Deployed, it needs an account.</p>
      {reason === null ? null : <p className="rounded-lg border border-dashed px-3 py-2 font-mono text-xs text-muted-foreground">{reason}</p>}
      <Button className="mt-2 w-fit" nativeButton={false} render={<Link href="/dashboard" />}>
        Open the studio
        <ArrowRight data-icon="inline-end" />
      </Button>
    </div>
  );
}
