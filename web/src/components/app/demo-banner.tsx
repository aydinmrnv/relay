'use client';

import { ArrowUpRight } from 'lucide-react';
import { HOSTED_DEMO } from '@/lib/hosted';
import { useBrand } from '@/hooks/use-brand';
import { REPO_URL } from '@/components/marketing/primitives';
import { cn } from '@/lib/utils';

/** One line on every screen of the hosted demo: what is real here, and where the real thing is. */
export function DemoBanner({ className }: { className?: string }) {
  const brand = useBrand();
  if (!HOSTED_DEMO) return null;
  return (
    <div className={cn('border-b bg-primary/[0.06] text-xs', className)}>
      <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 px-4 py-1.5 text-center">
        <span className="inline-flex items-center gap-1.5 font-medium text-primary">
          <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-primary" />
          Live demo
        </span>
        <span className="text-muted-foreground">Everything runs in your browser. Runs are simulated and nothing leaves this tab.</span>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-0.5 font-medium text-foreground underline-offset-4 hover:underline"
        >
          Run {brand.name} for real with the CLI
          <ArrowUpRight className="size-3" aria-hidden />
        </a>
      </div>
    </div>
  );
}
