'use client';

import Link from 'next/link';
import { ArrowRight, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useBrand } from '@/hooks/use-brand';
import { Reveal, SectionHeading } from './primitives';

export function Pricing() {
  const brand = useBrand();
  return (
    <section id="pricing" className="scroll-mt-20 border-t py-16 sm:py-24">
      <div className="container max-w-6xl">
        <SectionHeading
          eyebrow="Pricing"
          title="Free to build. Your infrastructure to run."
          description="Explore the studio without an account. When you run for real, usage stays on the plans you already have."
        />
        <div className="mx-auto mt-10 grid max-w-4xl gap-5 md:grid-cols-2">
          <Reveal className="h-full">
            <article className="flex h-full flex-col rounded-2xl border border-primary/30 bg-card p-6 shadow-sm sm:p-8">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-semibold">The studio</h3>
                <Badge variant="secondary">Free</Badge>
              </div>
              <p className="mt-6 flex items-baseline gap-2">
                <span className="text-5xl font-semibold tracking-tight">$0</span>
                <span className="text-sm text-muted-foreground">No account needed</span>
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
                  'Free account: sync, share links, version history',
                  'Export config and GitHub Actions',
                ].map((item) => (
                  <li key={item} className="flex items-center gap-2.5 text-sm">
                    <Check className="size-4 shrink-0 text-primary" />
                    {item}
                  </li>
                ))}
              </ul>
              <Button className="mt-auto h-10 w-full" nativeButton={false} render={<Link href="/dashboard" />}>
                Open the studio
                <ArrowRight data-icon="inline-end" />
              </Button>
            </article>
          </Reveal>
          <Reveal className="h-full" delay={0.06}>
            <article className="flex h-full flex-col rounded-2xl border bg-card p-6 sm:p-8">
              <h3 className="font-semibold">Real runs</h3>
              <p className="mt-6 flex items-baseline gap-2">
                <span className="text-5xl font-semibold tracking-tight">$0</span>
                <span className="text-sm text-muted-foreground">paid to {brand.name}</span>
              </p>
              <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                Connect your machine or export to your repository. Your providers bill their own usage.
              </p>
              <ul className="my-6 space-y-3 border-t pt-6">
                {[
                  'Use your Claude Code and Codex sign-ins',
                  'Run locally in an isolated worktree',
                  'Automate with your GitHub Actions minutes',
                  'Keep your config and changes in your repo',
                ].map((item) => (
                  <li key={item} className="flex items-center gap-2.5 text-sm">
                    <Check className="size-4 shrink-0 text-primary" />
                    {item}
                  </li>
                ))}
              </ul>
              <Button className="mt-auto h-10 w-full" variant="outline" nativeButton={false} render={<Link href="/connect" />}>
                Connect your machine
                <ArrowRight data-icon="inline-end" />
              </Button>
            </article>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
