'use client';

import type { ReactNode } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { motion, type Variants } from 'motion/react';
import { ArrowUpRight } from 'lucide-react';
import { useCalmMotion } from '@/components/motion/use-calm-motion';
import { cn } from '@/lib/utils';

/*
 * Pieces of Watermelon UI's Hero 1 (`npx shadcn add https://registry.watermelon.sh/r/hero-1.json`),
 * kept for the landing page's own hero: the pixel-grid art, the call to
 * action with its arrow chip, and the staggered rise. The layout, navigation
 * and palette are the site's. The art is the original's grid recoloured,
 * once on paper and once on ink, in the signal cyan.
 */

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * The original's entrance: children rise into place one after another. Only
 * the position moves, so content is never hidden before hydration, and
 * nothing moves for readers who asked for less motion.
 */
export function useHero1Stagger(): { container: Variants; item: Variants; initial: false | 'hidden' } {
  const calm = useCalmMotion();
  return {
    container: { hidden: {}, visible: { transition: { staggerChildren: calm ? 0 : 0.1, delayChildren: calm ? 0 : 0.05 } } },
    item: { hidden: { y: 24 }, visible: { y: 0, transition: { duration: calm ? 0 : 0.8, ease: EASE } } },
    initial: calm ? false : 'hidden',
  };
}

/**
 * The glowing pixel grid, faded into the page. It glows from its bottom
 * corner on `side`; position and size it with `className`.
 */
export function Hero1Art({ side = 'left', className }: { side?: 'left' | 'right'; className?: string }) {
  const calm = useCalmMotion();
  return (
    <motion.div
      aria-hidden
      initial={calm ? false : { opacity: 0, scale: 1.05 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: calm ? 0 : 1.2, ease: 'easeOut' }}
      className={cn('pointer-events-none overflow-hidden select-none', className)}
    >
      <div className={cn('absolute inset-0', side === 'right' && '-scale-x-100')}>
        <Image src="/marketing/hero-grid-light.avif" alt="" fill unoptimized loading="eager" className="object-cover object-bottom-left dark:hidden" />
        <Image src="/marketing/hero-grid-dark.avif" alt="" fill unoptimized loading="eager" className="hidden object-cover object-bottom-left dark:block" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_70%_at_20%_80%,transparent_40%,var(--background)_85%)]" />
      </div>
    </motion.div>
  );
}

/** The original's call to action: a pill with the arrow in a chip that nudges toward where it goes. */
export function Hero1Cta({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Link
      href={href}
      className={cn(
        'group inline-flex h-11 w-fit items-center gap-4 rounded-full bg-primary p-1 pl-5 text-sm font-medium text-primary-foreground shadow-[0_6px_20px_-8px_rgb(0_0_0/0.35)] transition-colors duration-300 outline-none hover:bg-primary/85 focus-visible:ring-3 focus-visible:ring-ring/50',
        className,
      )}
    >
      <span>{children}</span>
      <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary-foreground">
        <ArrowUpRight className="size-4 text-primary transition-transform duration-300 ease-out group-hover:translate-x-[2px] group-hover:-translate-y-[2px]" />
      </span>
    </Link>
  );
}
