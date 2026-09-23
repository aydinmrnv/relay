'use client';

import { ThemeProvider } from 'next-themes';
import { useEffect } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { useStudio } from '@/lib/store';
import { useAgentsPoller } from '@/hooks/use-agent-accounts';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <TooltipProvider delay={200}>
        <SeedOnce />
        <BrandTitle />
        <AgentsPoller />
        {children}
        <Toaster richColors position="bottom-right" />
      </TooltipProvider>
    </ThemeProvider>
  );
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
