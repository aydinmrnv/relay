'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowUpRight } from 'lucide-react';
import { HOSTED_DEMO } from '@/lib/hosted';
import { useCompanion } from '@/lib/companion/client';
import { useAccount } from '@/lib/cloud/account';
import { cn } from '@/lib/utils';

/**
 * One line at the top of the studio with the single most useful next step:
 * finish onboarding, make an account (the studio needs one), or — once
 * both are done — pick a runner so runs stop being simulated.
 */
export function DemoBanner({ className, site = false }: { className?: string; site?: boolean }) {
  const pathname = usePathname();
  const connected = useCompanion((state) => state.status === 'connected');
  const status = useAccount((state) => state.status);
  const onboarded = useAccount((state) => state.onboardedAt !== null);

  if (!site && status === 'signed-in' && !onboarded && pathname !== '/onboarding') {
    return (
      <Line className={className} dot="Welcome" text="Two minutes of setup tailors the studio to how you work and builds your first workflow." href="/onboarding" action="Finish setting up" />
    );
  }
  if (!site && status === 'guest') {
    return <Line className={className} dot="Not signed in" text="Make a free account to build, test and run workflows." href="/sign-in" action="Try it free" />;
  }
  if (!HOSTED_DEMO || connected) return null;
  return <Line className={className} dot={site ? 'Free beta' : 'Simulated runs'} text="Test runs are played back in your browser at no cost." href="/runners" action="Choose where your agents run" />;
}

function Line({ className, dot, text, href, action }: { className?: string; dot: string; text: string; href: string; action: string }) {
  return (
    <div className={cn('border-b bg-muted/60 text-xs', className)}>
      <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 px-4 py-1.5 text-center">
        <span className="font-medium text-foreground">{dot}</span>
        <span className="text-muted-foreground">{text}</span>
        <Link href={href} className="inline-flex items-center gap-0.5 font-medium text-foreground underline-offset-4 hover:underline">
          {action}
          <ArrowUpRight className="size-3" aria-hidden />
        </Link>
      </div>
    </div>
  );
}
