'use client';

import { ThemeProvider } from 'next-themes';
import { useEffect, useState } from 'react';
import { useAuth, useUser } from '@clerk/nextjs';
import { MotionConfig, MotionGlobalConfig } from 'motion/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { useStudio } from '@/lib/store';
import { useAgentsPoller } from '@/hooks/use-agent-accounts';
import { useCompanion } from '@/lib/companion/client';
import { attachMachineRun } from '@/lib/run-launcher';
import { CapabilitiesContext, useAccount } from '@/lib/cloud/account';
import { accountChanged, setTokenGetter, startAccount } from '@/lib/cloud/sync';
import type { AccountUser, AuthCapabilities } from '@/lib/cloud/types';

/**
 * `clerk` says whether the layout rendered a ClerkProvider around this.
 * Accounts need it, whatever the server says at run time: Clerk's hooks
 * cannot run without their provider.
 */
export function Providers({ capabilities: rendered, clerk, children }: { capabilities: AuthCapabilities; clerk: boolean; children: React.ReactNode }) {
  const built = clerk ? rendered : { ...rendered, enabled: false };
  // What the page was rendered with; replaced if the running server says otherwise.
  const [capabilities, setCapabilities] = useState(built);
  useEffect(() => {
    // Relay Cloud needs an account: its hub knows people by their Clerk session.
    useCompanion.getState().setCloudHub(capabilities.enabled ? (capabilities.cloudHub ?? null) : null);
  }, [capabilities]);
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <CapabilitiesContext value={capabilities}>
      <MotionPreference>
        <TooltipProvider delay={200}>
          <AccountBoot capabilities={built} onRuntime={(runtime) => setCapabilities(clerk ? runtime : { ...runtime, enabled: false })} />
          {clerk && capabilities.enabled ? <ClerkBridge /> : null}
          <SeedOnce />
          <BrandTitle />
          <AgentsPoller />
          <MachineRunsFollower />
          {children}
          <Toaster richColors position="bottom-right" />
        </TooltipProvider>
      </MotionPreference>
      </CapabilitiesContext>
    </ThemeProvider>
  );
}

/**
 * The animation setting from Settings. `reduced` sets motion's global skip
 * flag, so every animation jumps to its end state instead of playing — the
 * only choice that also works where the browser is not painting frames.
 */
function MotionPreference({ children }: { children: React.ReactNode }) {
  const hydrated = useStudio((state) => state.hydrated);
  const preference = useStudio((state) => state.settings.motion);
  useEffect(() => {
    // The hydrating render still sees the default setting; acting on it would
    // switch skipping off again just after the store switched it on.
    if (hydrated) MotionGlobalConfig.skipAnimations = preference === 'reduced';
  }, [hydrated, preference]);
  return <MotionConfig reducedMotion={preference === 'full' ? 'never' : preference === 'reduced' ? 'always' : 'user'}>{children}</MotionConfig>;
}

/** Keeps the tab title in step with whatever the product is called today. */
function BrandTitle() {
  const hydrated = useStudio((state) => state.hydrated);
  const name = useStudio((state) => state.brand.name);
  useEffect(() => {
    if (!hydrated) return;
    const base = document.title.includes(' · ') ? document.title.split(' · ').slice(0, -1).join(' · ') : '';
    document.title = base.length > 0 ? `${base} · ${name}` : name;
  }, [hydrated, name]);
  return null;
}

/**
 * Once the saved studio is back from localStorage, decide whether this is a
 * guest or an account, and load the account's workspace if it is one.
 */
function AccountBoot({ capabilities, onRuntime }: { capabilities: AuthCapabilities; onRuntime: (capabilities: AuthCapabilities) => void }) {
  const hydrated = useStudio((state) => state.hydrated);
  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    // Start at once with what the page was rendered with — right in every
    // normal deployment — and start again only if the server disagrees.
    void startAccount(capabilities);
    fetch('/api/capabilities')
      .then((response) => (response.ok ? (response.json() as Promise<AuthCapabilities>) : null))
      .then((runtime) => {
        if (cancelled || runtime === null) return;
        const sameHub = (runtime.cloudHub ?? null) === (capabilities.cloudHub ?? null);
        if (runtime.enabled === capabilities.enabled && sameHub) return;
        onRuntime(runtime);
        if (runtime.enabled !== capabilities.enabled) void startAccount(runtime);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // Once per page: capabilities do not change while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);
  return null;
}

/**
 * Clerk decides who is signed in. This passes its answer to the studio on
 * load and on every change — signing in or out here or in another tab — and
 * lends the sync layer Clerk's token getter for its requests.
 */
function ClerkBridge() {
  const { isLoaded, userId, getToken } = useAuth();
  const { user } = useUser();
  const hydrated = useStudio((state) => state.hydrated);

  useEffect(() => {
    setTokenGetter(() => getToken());
    return () => setTokenGetter(null);
  }, [getToken]);

  useEffect(() => {
    if (!hydrated || !isLoaded) return;
    if (typeof userId !== 'string') {
      void accountChanged(null);
      return;
    }
    // The user object follows the session a moment later.
    if (user === null || user === undefined || user.id !== userId) return;
    const email = user.primaryEmailAddress;
    const person: AccountUser = {
      id: user.id,
      name: user.fullName?.trim() || user.username || email?.emailAddress.split('@')[0] || 'You',
      email: email?.emailAddress ?? '',
      emailVerified: email?.verification?.status === 'verified',
      image: user.hasImage ? user.imageUrl : null,
      createdAt: (user.createdAt ?? new Date()).toISOString(),
    };
    void accountChanged(person);
  }, [hydrated, isLoaded, userId, user]);
  return null;
}

/**
 * Fills a guest's empty browser with the starter workflows and a few demo
 * runs, once. An account starts empty on purpose: onboarding makes its first
 * workflow, and nobody's account should fill up with examples.
 */
function SeedOnce() {
  const hydrated = useStudio((state) => state.hydrated);
  const seeded = useStudio((state) => state.seeded);
  const owner = useStudio((state) => state.owner);
  const guest = useAccount((state) => state.status === 'guest' || state.status === 'disabled');
  const seedDemo = useStudio((state) => state.seedDemo);
  useEffect(() => {
    if (hydrated && guest && owner === null && !seeded) void seedDemo();
  }, [hydrated, guest, owner, seeded, seedDemo]);
  return null;
}

/** Keeps the vendor CLIs' sign-in state fresh for every screen that shows it. */
function AgentsPoller() {
  useAgentsPoller();
  return null;
}

/**
 * Runs on the paired machine outlive the tab that started them. Once the
 * machine answers, any still marked running are followed again from their
 * first line; the launcher ignores the ones already being followed.
 */
function MachineRunsFollower() {
  const hydrated = useStudio((state) => state.hydrated);
  const runs = useStudio((state) => state.runs);
  const connected = useCompanion((state) => state.status === 'connected');
  const target = useCompanion((state) => state.target);
  useEffect(() => {
    if (!hydrated || !connected) return;
    for (const run of runs) {
      if (run.source === 'machine' && run.status === 'running' && (run.machine?.runner ?? 'machine') === target) void attachMachineRun(run);
    }
  }, [hydrated, connected, target, runs]);
  return null;
}
