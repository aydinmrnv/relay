'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { ArrowRight, ArrowUpRight, Check } from 'lucide-react';
import { LiquidGlass } from '@/components/glass/liquid-glass';
import { Hero1Art, Hero1Cta, useHero1Stagger } from '@/components/watermelon/hero-1';
import { useBrand } from '@/hooks/use-brand';
import { PipelinePreview } from './pipeline-preview';
import { REPO_URL, useStudioEntry } from './primitives';

export function Hero() {
  const brand = useBrand();
  const entry = useStudioEntry();
  const { container, item, initial } = useHero1Stagger();
  const trust = [`Runs on your computer or in ${brand.name} Cloud`, 'Uses the AI plans you already pay for', 'Free to start'];
  return (
    <section id="top" className="relative isolate overflow-hidden">
      <div className="relative">
        {/* The grid glows up from behind the sample workflow; its brightest edge stays under the card. */}
        <Hero1Art
          side="right"
          className="absolute right-0 -bottom-40 -z-10 h-[calc(100%+10rem)] w-full mask-[linear-gradient(to_bottom,black_70%,transparent)] md:w-[72%]"
        />
        <motion.div variants={container} initial={initial} animate="visible" className="container max-w-6xl pt-28 pb-12 sm:pt-36 sm:pb-16">
          <motion.div variants={item}>
            <Link
              href="/runners"
              className="group inline-flex items-center gap-2.5 rounded-full border bg-card/70 py-1 pr-3 pl-1 text-[13px] shadow-panel backdrop-blur-sm transition-colors outline-none hover:border-foreground/25 focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span className="rounded-full bg-foreground px-2 py-0.5 text-[11px] font-medium text-background">New</span>
              <span className="text-muted-foreground">
                <span className="font-medium text-foreground">{brand.name} Cloud</span>
                <span className="hidden sm:inline"> · your agents keep working with the laptop shut</span>
              </span>
              <ArrowRight className="size-3.5 text-muted-foreground transition-transform duration-300 group-hover:translate-x-0.5" />
            </Link>
          </motion.div>
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
          <motion.ul variants={item} className="mt-9 flex flex-wrap gap-x-6 gap-y-2.5 text-sm text-muted-foreground">
            {trust.map((text) => (
              <li key={text} className="inline-flex items-center gap-2">
                <Check className="size-3.5 shrink-0 text-foreground" strokeWidth={2.5} />
                {text}
              </li>
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
