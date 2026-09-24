'use client';

import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { HOSTED_DEMO } from '@/lib/hosted';
import { useCompanion } from '@/lib/companion/client';
import { cn } from '@/lib/utils';

/** One line on every screen of the hosted demo: what is real here, and how to make the rest real. */
export function DemoBanner({ className }: { className?: string }) {
  const connected = useCompanion((state) => state.status === 'connected');
  if (!HOSTED_DEMO || connected) return null;
  return (
    <div className={cn('border-b bg-primary/[0.06] text-xs', className)}>
      <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 px-4 py-1.5 text-center">
        <span className="inline-flex items-center gap-1.5 font-medium text-primary">
          <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-primary" />
          Live demo
        </span>
        <span className="text-muted-foreground">Everything runs in your browser and test runs are simulated.</span>
        <Link href="/connect" className="inline-flex items-center gap-0.5 font-medium text-foreground underline-offset-4 hover:underline">
          Connect your machine to run for real
          <ArrowUpRight className="size-3" aria-hidden />
        </Link>
      </div>
    </div>
  );
}
