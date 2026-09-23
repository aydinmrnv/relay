'use client';

import Link from 'next/link';
import { ArrowRight, ArrowUpRight, KeyRound, Laptop, LayoutTemplate, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spotlight } from '@/components/21st/spotlight';
import { useBrand } from '@/hooks/use-brand';
import { PipelinePreview } from './pipeline-preview';
import { AppMark, REPO_URL, Reveal, WordReveal } from './primitives';

const TRUST = [
  { icon: Laptop, text: 'Runs on your machine' },
  { icon: KeyRound, text: 'Bring your own Claude / ChatGPT subscription' },
  { icon: Wallet, text: '$0' },
];

export function Hero() {
  const brand = useBrand();

  return (
    <section className="relative overflow-hidden">
      {/* A faint grid that fades out towards the edges, and a wash of the brand colour behind the headline. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-grid [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,#000_40%,transparent_100%)]" />
      <div
        aria-hidden
        className="pointer-events-none absolute top-[-18rem] left-1/2 size-[44rem] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,color-mix(in_oklch,var(--primary)_22%,transparent),transparent_65%)] blur-2xl"
      />

      <div className="relative container flex flex-col items-center pt-14 pb-12 text-center sm:pt-20 lg:pt-24">
        <Reveal y={8}>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="group inline-flex items-center gap-2 rounded-full border bg-background/70 py-1 pr-3 pl-1 text-xs text-muted-foreground shadow-xs backdrop-blur transition-colors hover:border-primary/40 hover:text-foreground"
          >
            <Badge variant="secondary" className="gap-1 rounded-full">
              <AppMark connector="github" size={11} />
              CLI
            </Badge>
            <span>The engine is open source, on GitHub</span>
            <ArrowUpRight className="size-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </a>
        </Reveal>

        <h1 className="mt-6 max-w-5xl text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-6xl lg:text-7xl">
          <WordReveal text="Tickets in." />
          <WordReveal text="Reviewed pull requests out." delay={0.2} className="text-primary" />
        </h1>

        <Reveal y={8} delay={0.3} className="mt-6 max-w-2xl">
          <p className="text-base text-pretty text-muted-foreground sm:text-lg">
            {brand.name} hands an issue to the coding agents you already use, Claude Code and Codex, and makes them check each other. One plans and the other attacks the
            plan; one implements and the other reviews the diff; your test suite has the last word. The result arrives as a draft pull request.
          </p>
        </Reveal>

        <Reveal y={8} delay={0.4} className="mt-8 flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center sm:justify-center">
          <Button size="lg" className="h-11 px-5 text-[15px]" nativeButton={false} render={<Link href="/dashboard" />}>
            Open the studio
            <ArrowRight data-icon="inline-end" />
          </Button>
          <Button size="lg" variant="outline" className="h-11 px-5 text-[15px]" nativeButton={false} render={<Link href="/templates" />}>
            <LayoutTemplate data-icon="inline-start" />
            Start from a template
          </Button>
        </Reveal>

        <Reveal y={8} delay={0.5} className="mt-6">
          <ul className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-muted-foreground sm:text-sm">
            {TRUST.map(({ icon: Icon, text }) => (
              <li key={text} className="inline-flex items-center gap-1.5">
                <Icon className="size-3.5 text-primary" />
                {text}
              </li>
            ))}
          </ul>
        </Reveal>
      </div>

      <div className="relative container pb-16 sm:pb-24">
        <Reveal y={20} delay={0.55}>
          <div className="relative overflow-hidden rounded-2xl border bg-background/60 shadow-xl shadow-primary/5 backdrop-blur-sm">
            <Spotlight size={420} className="from-primary/25 via-primary/10 to-transparent dark:from-primary/25 dark:via-primary/10 dark:to-transparent" />
            <div className="relative flex items-center gap-3 border-b bg-muted/40 px-4 py-2.5">
              <div aria-hidden className="flex gap-1.5">
                <span className="size-2.5 rounded-full bg-foreground/15" />
                <span className="size-2.5 rounded-full bg-foreground/15" />
                <span className="size-2.5 rounded-full bg-foreground/15" />
              </div>
              <p className="min-w-0 truncate text-xs font-medium">Ticket to pull request</p>
              <Badge variant="outline" className="hidden sm:inline-flex">
                template
              </Badge>
              <p className="ml-auto hidden text-xs text-muted-foreground md:block">Every box is a node you can move, swap or delete in the builder</p>
            </div>
            <div className="relative bg-grid px-4 py-8 sm:px-8 sm:py-12">
              <PipelinePreview />
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
