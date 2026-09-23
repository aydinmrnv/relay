'use client';

import { ThemeProvider } from 'next-themes';
import { useEffect } from 'react';
import { MotionConfig, MotionGlobalConfig } from 'motion/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { useStudio } from '@/lib/store';
import { useAgentsPoller } from '@/hooks/use-agent-accounts';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <MotionPreference>
        <TooltipProvider delay={200}>
          <SeedOnce />
          <BrandTitle />
          <AgentsPoller />
          {children}
          <Toaster richColors position="bottom-right" />
        </TooltipProvider>
      </MotionPreference>
    </ThemeProvider>
  );
}

/**
 * The animation setting from Settings. `reduced` sets motion's global skip
 * flag, so every animation jumps to its end state instead of playing — the
 * only choice that also works where the browser is not painting frames.
 */
function MotionPreference({ children }: { children: React.ReactNode }) {
  const preference = useStudio((state) => state.settings.motion);
  useEffect(() => {
    MotionGlobalConfig.skipAnimations = preference === 'reduced';
  }, [preference]);
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

/** Fills an empty browser with the starter workflows and a few demo runs, once. */
function SeedOnce() {
  const hydrated = useStudio((state) => state.hydrated);
  const seeded = useStudio((state) => state.seeded);
  const seedDemo = useStudio((state) => state.seedDemo);
  useEffect(() => {
    if (hydrated && !seeded) void seedDemo();
  }, [hydrated, seeded, seedDemo]);
  return null;
}

/** Keeps the vendor CLIs' sign-in state fresh for every screen that shows it. */
function AgentsPoller() {
  useAgentsPoller();
  return null;
}
