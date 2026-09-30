'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { ArrowUpRight } from 'lucide-react';
import { LiquidGlass } from '@/components/glass/liquid-glass';
import { Hero1Art, Hero1Cta, useHero1Stagger } from '@/components/watermelon/hero-1';
import { useBrand } from '@/hooks/use-brand';
import { PipelinePreview } from './pipeline-preview';
import { REPO_URL, useStudioEntry } from './primitives';

const TRUST = ['Runs on your computer, or on a machine we make for you', 'Uses the AI subscriptions you already have', 'Free to start'];

export function Hero() {
  const brand = useBrand();
  const entry = useStudioEntry();
  const { container, item, initial } = useHero1Stagger();
  return (
    <section id="top" className="relative isolate overflow-hidden">
      <div className="relative">
        {/* The grid glows up from behind the sample workflow; its brightest edge stays under the card. */}
        <Hero1Art
          side="right"
          className="absolute right-0 -bottom-40 -z-10 h-[calc(100%+10rem)] w-full mask-[linear-gradient(to_bottom,black_70%,transparent)] md:w-[72%]"
        />
        <motion.div variants={container} initial={initial} animate="visible" className="container max-w-6xl pt-28 pb-12 sm:pt-36 sm:pb-16">
          <motion.p variants={item} className="font-mono text-xs text-muted-foreground">
            The workflow layer for coding agents
          </motion.p>
          <motion.h1
            variants={item}
            className="mt-5 max-w-4xl text-[clamp(2.5rem,9vw,5.25rem)] leading-[1.02] font-semibold tracking-[-0.045em] text-balance"
          >
            Ticket in.
            <br />
            <span className="text-muted-foreground">Reviewed PR out.</span>
          </motion.h1>
          <motion.p variants={item} className="mt-6 max-w-xl text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg">
            Claude Code and Codex, working together on your repository. {brand.name} connects the plan, the code, and the
            review. You decide what ships.
          </motion.p>
          <motion.div variants={item} className="mt-8 flex flex-wrap items-center gap-3">
            <Hero1Cta href={entry.href}>{entry.label}</Hero1Cta>
            <LiquidGlass className="rounded-full transition-[background-color,scale] duration-300 hover:bg-white/60 active:scale-[0.97] dark:hover:bg-white/[0.13]">
              <Link
                href="/guide"
                className="inline-flex h-11 items-center rounded-full px-5 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                Read the docs
              </Link>
            </LiquidGlass>
          </motion.div>
          <motion.ul variants={item} className="mt-8 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
            {TRUST.map((text) => (
              <li key={text}>{text}</li>
            ))}
            <li>
              <a href={REPO_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline">
                Open source on GitHub
                <ArrowUpRight className="size-3.5" />
              </a>
            </li>
          </motion.ul>
        </motion.div>
      </div>
      <div className="container max-w-6xl pb-16 sm:pb-24">
        <PipelinePreview />
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          A sample workflow, step by step. Run it on your own computer, or on a machine Relay makes for you.
        </p>
      </div>
    </section>
  );
}
