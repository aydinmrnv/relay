'use client';

import Link from 'next/link';
import { ArrowRight, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useBrand } from '@/hooks/use-brand';
import { cn } from '@/lib/utils';
import { PILL, Reveal, SectionHeading, useStudioEntry } from './primitives';

export function Pricing() {
  const brand = useBrand();
  const entry = useStudioEntry();
  return (
    <section id="pricing" className="scroll-mt-20 border-t py-16 sm:py-24">
      <div className="container max-w-6xl">
        <SectionHeading
          eyebrow="Pricing"
          title="Free to build. Your infrastructure to run."
          description="Make a free account and build as much as you like. When you run for real, usage stays on the plans you already have."
        />
        {/* Two columns of one table, split by a rule: they are two halves of one answer, not two products to choose between. */}
        <div className="mt-12 grid overflow-hidden rounded-xl border bg-card shadow-panel md:grid-cols-2">
          <Reveal className="h-full">
            <article className="flex h-full flex-col p-6 sm:p-8">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-semibold">The studio</h3>
                <span className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground">Build and test</span>
              </div>
              <p className="mt-6 flex items-baseline gap-2">
                <span className="text-5xl font-semibold tracking-[-0.04em]">$0</span>
                <span className="text-sm text-muted-foreground">with a free account</span>
              </p>
              <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                Design a workflow, inspect every step, and try it with simulated runs.
              </p>
              <ul className="my-6 space-y-3 border-t pt-6">
                {[
                  'Unlimited workflows and templates',
                  'Visual builder and connector catalog',
                  'Describe a workflow in a sentence',
                  'Spend forecasts and free simulated test runs',
                  'Sync across browsers, share links and version history',
                  'Export config and GitHub Actions',
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2.5 text-sm">
                    <Check className="mt-0.5 size-4 shrink-0 text-foreground" strokeWidth={2.25} />
                    {item}
                  </li>
                ))}
              </ul>
              <Button className={cn('mt-auto w-full', PILL)} nativeButton={false} render={<Link href={entry.href} />}>
                {entry.label}
                <ArrowRight data-icon="inline-end" />
              </Button>
            </article>
          </Reveal>
          <Reveal className="h-full" delay={0.06}>
            <article className="flex h-full flex-col border-t p-6 sm:p-8 md:border-t-0 md:border-l">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-semibold">Real runs</h3>
                <span className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground">Your plans, your runner</span>
              </div>
              <p className="mt-6 flex items-baseline gap-2">
                <span className="text-5xl font-semibold tracking-[-0.04em]">$0</span>
                <span className="text-sm text-muted-foreground">paid to {brand.name}</span>
              </p>
              <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                Pair your own computer with relay connect, run on a Relay Cloud machine we make for you, or export to your repository. Your providers bill their own usage.
              </p>
              <ul className="my-6 space-y-3 border-t pt-6">
                {[
                  'Use your Claude Code and Codex sign-ins',
                  'Run on your computer or on a machine of your own, in an isolated worktree',
                  'Automate with your GitHub Actions minutes',
                  'Keep your config and changes in your repo',
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2.5 text-sm">
                    <Check className="mt-0.5 size-4 shrink-0 text-foreground" strokeWidth={2.25} />
                    {item}
                  </li>
                ))}
              </ul>
              <Button className={cn('mt-auto w-full', PILL)} variant="outline" nativeButton={false} render={<Link href="/runners" />}>
                Your computer or Relay Cloud?
                <ArrowRight data-icon="inline-end" />
              </Button>
            </article>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
