'use client';

import Link from 'next/link';
import { ArrowRight, ArrowUpRight, KeyRound, Laptop, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useBrand } from '@/hooks/use-brand';
import { PipelinePreview } from './pipeline-preview';
import { AppMark, REPO_URL } from './primitives';

const TRUST = [
  { icon: Laptop, text: 'Runs on your machine' },
  { icon: KeyRound, text: 'Your existing AI subscriptions' },
  { icon: Wallet, text: 'Free to get started' },
];

export function Hero() {
  const brand = useBrand();
  return (
    <section className="overflow-hidden">
      <div className="relative mx-auto max-w-6xl border-x">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-[540px] bg-grid opacity-35 [mask-image:linear-gradient(to_bottom,#000,transparent)]"
        />
        <div className="relative flex flex-col items-center px-5 pt-14 pb-10 text-center sm:px-8 sm:pt-20 sm:pb-12 lg:pt-20">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <AppMark connector="github" size={13} />
            <span>The workflow layer for coding agents</span>
            <ArrowUpRight className="size-3 shrink-0" />
          </a>
          <h1 className="mt-8 max-w-5xl text-[clamp(2.25rem,11vw,2.75rem)] sm:text-[clamp(2.75rem,6.5vw,5rem)] leading-[1.05] font-semibold tracking-[-0.055em] text-balance">
            Ticket in.
            <br />
            <span className="text-primary">Reviewed PR out.</span>
          </h1>
          <p className="mt-6 max-w-xl text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg">
            Claude Code and Codex, working together on your repository. {brand.name} connects the plan, the code, and
            the review. You decide what ships.
          </p>
          <div className="mt-8 flex w-full max-w-sm flex-col gap-3 sm:w-auto sm:max-w-none sm:flex-row">
            <Button
              size="lg"
              className="h-11 rounded-md px-6 shadow-none"
              nativeButton={false}
              render={<Link href="/dashboard" />}
            >
              Open the studio
              <ArrowRight data-icon="inline-end" />
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="h-11 rounded-md px-6 shadow-none"
              nativeButton={false}
              render={<Link href="/guide" />}
            >
              Read the docs
              <ArrowUpRight data-icon="inline-end" />
            </Button>
          </div>
          <ul className="mt-7 flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
            {TRUST.map(({ icon: Icon, text }) => (
              <li key={text} className="inline-flex items-center gap-1.5">
                <Icon className="size-3.5" />
                {text}
              </li>
            ))}
          </ul>
        </div>
        <div className="relative px-4 pb-8 sm:px-8 sm:pb-10">
          <PipelinePreview />
          <p className="mt-4 text-center text-xs leading-relaxed text-muted-foreground">
            Explore each step of a sample workflow. Connect your machine to run your own.
          </p>
        </div>
      </div>
    </section>
  );
}
