'use client';

import Link from 'next/link';
import { ArrowRight, ArrowUpRight, Check, CircleDashed, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useBrand } from '@/hooks/use-brand';
import { CATALOG_STATS } from '@/lib/connectors';
import { cn } from '@/lib/utils';
import { REPO_URL, Reveal, SectionHeading } from './primitives';

export function Pricing() {
  const brand = useBrand();

  const plans = [
    {
      name: 'The studio',
      price: '$0',
      cadence: 'free while in beta',
      summary: 'Design, validate, test-run and export workflows. Try it as a guest, or make an account to keep everything.',
      features: [
        'Unlimited workflows, synced to your account',
        `All ${CATALOG_STATS.connectors} connectors`,
        'Describe a workflow in a sentence',
        'Spend forecasts and simulated test runs',
        'Share links, remixes and version history',
        'Export to config + GitHub Actions',
      ],
      cta: (
        <Button className="w-full" nativeButton={false} render={<Link href="/sign-up" />}>
          Create a free account
          <ArrowRight data-icon="inline-end" />
        </Button>
      ),
      highlighted: true,
    },
    {
      name: 'Your runs',
      price: '$0',
      cadence: `paid to ${brand.name}`,
      summary: 'Exported workflows run in your repository, on your GitHub Actions minutes, with the plans you already pay for.',
      features: ['Free runner minutes on public repositories', 'Private repositories use your plan’s included minutes', 'Claude Code on your Claude plan', 'Codex on your ChatGPT plan', 'API keys instead, if you prefer'],
      cta: (
        <Button className="w-full" variant="outline" nativeButton={false} render={<Link href="/templates" />}>
          Start from a template
        </Button>
      ),
      highlighted: false,
    },
    {
      name: 'Hosted',
      price: 'Later',
      cadence: 'not built yet',
      summary: 'What this is designed to grow into, as tiers rather than a rewrite. No price until it exists.',
      features: ['A fresh runner per run', 'Real webhooks for every connector', 'Approvals from Slack and email', 'A self-hosted runner in your VPC', 'Org-wide guardrails and audit log'],
      cta: (
        <Button className="w-full" variant="ghost" nativeButton={false} render={<a href={REPO_URL} target="_blank" rel="noreferrer" />}>
          Follow along on GitHub
          <ArrowUpRight data-icon="inline-end" />
        </Button>
      ),
      highlighted: false,
    },
  ];

  return (
    <section id="pricing" className="scroll-mt-16 border-t py-20 sm:py-28">
      <div className="container">
        <SectionHeading
          eyebrow="Pricing"
          title="Honest pricing: free while in beta"
          description={`Accounts are free. The model usage is your own subscriptions and the compute is your own machine or Actions minutes, so ${brand.name} has nothing to mark up.`}
        />
        <div className="mx-auto mt-14 grid max-w-5xl grid-cols-1 gap-4 lg:grid-cols-3">
          {plans.map((plan, index) => (
            <Reveal key={plan.name} delay={index * 0.06} className="h-full">
              <article
                className={cn(
                  'relative flex h-full flex-col gap-5 overflow-hidden rounded-2xl border bg-card p-6',
                  plan.highlighted && 'border-primary/40 shadow-lg shadow-primary/10',
                  plan.price === 'Later' && 'border-dashed bg-card/50',
                )}
              >
                {plan.highlighted ? <div aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-violet-500 via-primary to-sky-400" /> : null}
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">{plan.name}</h3>
                  {plan.highlighted ? <Badge>Beta</Badge> : null}
                  {plan.price === 'Later' ? (
                    <Badge variant="outline">
                      <Clock data-icon="inline-start" />
                      Roadmap
                    </Badge>
                  ) : null}
                </div>
                <div>
                  <p className="flex items-baseline gap-2">
                    <span className="text-4xl font-semibold tracking-tight">{plan.price}</span>
                    <span className="text-sm text-muted-foreground">{plan.cadence}</span>
                  </p>
                  <p className="mt-2 text-sm text-pretty text-muted-foreground">{plan.summary}</p>
                </div>
                <ul className="flex flex-col gap-2 border-t pt-5">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2 text-sm">
                      {plan.price === 'Later' ? <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : <Check className="mt-0.5 size-4 shrink-0 text-success" />}
                      <span className={cn(plan.price === 'Later' && 'text-muted-foreground')}>{feature}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-auto pt-2">{plan.cta}</div>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
