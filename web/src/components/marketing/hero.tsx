'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { ArrowRight, Check } from 'lucide-react';
import { LiquidGlass } from '@/components/glass/liquid-glass';
import { Hero1Art, Hero1Cta, useHero1Stagger } from '@/components/watermelon/hero-1';
import { useBrand } from '@/hooks/use-brand';
import { PipelinePreview } from './pipeline-preview';
import { useStudioEntry } from './primitives';

export function Hero() {
  const brand = useBrand();
  const entry = useStudioEntry();
  const { container, item, initial } = useHero1Stagger();
  const trust = ['Runs in your repository, on your Actions minutes', 'Uses the Claude and ChatGPT plans you already pay for', 'Free while in beta'];
  return (
    <section id="top" className="relative isolate overflow-hidden">
      <div className="relative">
        {/* The grid glows up from behind the sample workflow; its brightest edge stays under the card. */}
        <Hero1Art
          side="right"
          className="absolute right-0 -bottom-40 -z-10 h-[calc(100%+10rem)] w-full mask-[linear-gradient(to_bottom,black_70%,transparent)] md:w-[72%]"
        />
        <motion.div variants={container} initial={initial} animate="visible" className="container max-w-6xl pt-28 pb-12 sm:pt-36 sm:pb-16">
          <motion.h1
            variants={item}
            className="mt-5 max-w-4xl text-[clamp(2.5rem,9vw,5.25rem)] leading-[1.02] font-semibold tracking-[-0.045em] text-balance"
          >
            Automations for your repo.
            <br />
            <span className="text-muted-foreground">On your GitHub Actions.</span>
          </motion.h1>
          <motion.p variants={item} className="mt-6 max-w-xl text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg">
            {brand.name} is where you build them. Connect a repository, pick a workflow, and from then on a label on an issue is enough: coding
            agents plan it, write it, review each other’s work and open a pull request, all inside your own GitHub Actions.
          </motion.p>
          <motion.div variants={item} className="mt-8 flex flex-wrap items-center gap-3">
            <Hero1Cta href={entry.href}>{entry.label}</Hero1Cta>
            <LiquidGlass className="rounded-full transition-[background-color,scale] duration-300 hover:bg-white/60 active:scale-[0.97] dark:hover:bg-white/[0.13]">
              {/* Beside the way in for someone new, the way in for someone with an account. */}
              <Link
                href={entry.signIn ?? '/guide'}
                className="inline-flex h-11 items-center rounded-full px-5 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {entry.signIn === null ? 'Read the guide' : 'Sign in'}
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
            {entry.playground === null ? null : (
              <li>
                {/* The demo, named as one: the builder with nothing behind it, for a look before making an account. */}
                <Link href={entry.playground} className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline">
                  Try the demo, no account
                  <ArrowRight className="size-3.5" />
                </Link>
              </li>
            )}
            <li>
              {/* Not a sample: runs {brand.name} made on its own repository, with the pull requests they opened. */}
              <Link href="/r" className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline">
                Watch a real run
                <ArrowRight className="size-3.5" />
              </Link>
            </li>
          </motion.ul>
        </motion.div>
      </div>
      <div className="container max-w-6xl pb-16 sm:pb-24">
        <PipelinePreview />
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">A sample workflow, step by step. Label an issue, and this is what runs in your repository.</p>
      </div>
    </section>
  );
}
