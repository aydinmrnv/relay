'use client';

import { ThemeProvider } from 'next-themes';
import { useEffect } from 'react';
import { MotionConfig, MotionGlobalConfig } from 'motion/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { useStudio } from '@/lib/store';
import { useAgentsPoller } from '@/hooks/use-agent-accounts';
import { useCompanion } from '@/lib/companion/client';
import { attachMachineRun } from '@/lib/run-launcher';
import { CapabilitiesContext, useAccount } from '@/lib/cloud/account';
import { startAccount } from '@/lib/cloud/sync';
import type { AuthCapabilities } from '@/lib/cloud/types';

export function Providers({ capabilities, children }: { capabilities: AuthCapabilities; children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <CapabilitiesContext value={capabilities}>
      <MotionPreference>
        <TooltipProvider delay={200}>
          <AccountBoot capabilities={capabilities} />
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
function AccountBoot({ capabilities }: { capabilities: AuthCapabilities }) {
  const hydrated = useStudio((state) => state.hydrated);
  useEffect(() => {
    if (hydrated) void startAccount(capabilities);
    // Capabilities are fixed for the life of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);
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
  useEffect(() => {
    if (!hydrated || !connected) return;
    for (const run of runs) if (run.source === 'machine' && run.status === 'running') void attachMachineRun(run);
  }, [hydrated, connected, runs]);
  return null;
}
