'use client';

import type { ReactNode } from 'react';
import { motion, type Variants } from 'motion/react';
import { useCalmMotion } from '@/components/motion/use-calm-motion';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { getConnector, type Connector } from '@/lib/connectors';
import { cn } from '@/lib/utils';

/** The engine's public repository. The only external product link on the page. */
export { REPO_URL } from '@/lib/links';

/** In-page anchors, shared by the header, the mobile menu and the footer so none can point at nothing. */
export const SECTIONS = [
  { id: 'how', label: 'How it works' },
  { id: 'features', label: 'Features' },
  { id: 'different', label: 'What’s different' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'pricing', label: 'Pricing' },
  { id: 'faq', label: 'FAQ' },
] as const;

const EASE = [0.22, 1, 0.36, 1] as const;

export { useCalmMotion };

/**
 * Rises into place the first time it scrolls into view. `whileInView` rather
 * than `animate`, for two reasons: content below the fold does not play its
 * entrance unseen, and even content above the fold starts only after
 * hydration, once the Animations setting is in force, so "reduced" is instant
 * on a server-rendered visit too. On a client-side visit with reduced motion,
 * `initial={false}` means it is simply there.
 */
export function Reveal({ children, className, delay = 0, y = 14 }: { children: ReactNode; className?: string; delay?: number; y?: number }) {
  const reduce = useCalmMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? false : { opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.15 }}
      transition={{ duration: 0.5, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  );
}

const WORD: Variants = {
  hidden: { opacity: 0, y: 12, filter: 'blur(8px)' },
  visible: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: 0.55, ease: EASE } },
};

/**
 * A line of text that arrives word by word (the 21st.dev TextEffect idea),
 * started by `whileInView` for the same hydration reason as `Reveal`. Screen
 * readers get the sentence once, not word by word.
 */
export function WordReveal({ text, className, delay = 0 }: { text: string; className?: string; delay?: number }) {
  const reduce = useCalmMotion();
  const words = text.split(' ');
  return (
    <motion.span
      className={cn('block', className)}
      initial={reduce ? false : 'hidden'}
      whileInView="visible"
      viewport={{ once: true }}
      variants={{ hidden: {}, visible: { transition: { staggerChildren: 0.07, delayChildren: delay } } }}
    >
      <span className="sr-only">{text}</span>
      {words.map((word, index) => (
        <motion.span key={`${index}-${word}`} aria-hidden className="inline-block whitespace-pre" variants={WORD}>
          {index < words.length - 1 ? `${word} ` : word}
        </motion.span>
      ))}
    </motion.span>
  );
}

export function SectionHeading({ eyebrow, title, description, className }: { eyebrow: string; title: ReactNode; description?: ReactNode; className?: string }) {
  return (
    <Reveal className={cn('mx-auto flex max-w-2xl flex-col items-center gap-3 text-center', className)}>
      <p className="text-xs font-semibold tracking-[0.16em] text-primary uppercase">{eyebrow}</p>
      <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{title}</h2>
      {description === undefined ? null : <p className="text-base text-pretty text-muted-foreground sm:text-lg">{description}</p>}
    </Reveal>
  );
}

/**
 * Brand colours like GitHub's #181717 or Sentry's #362D59 vanish on a dark
 * background. Marks that dark (by relative luminance) follow the text colour
 * instead, which is what the brands' own dark-mode guidance asks for anyway.
 */
function isNearBlack(hex: string): boolean {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (match === null) return false;
  const [r, g, b] = match.slice(1).map((channel) => {
    const c = Number.parseInt(channel, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.05;
}

function resolve(connector: Connector | string): Connector | undefined {
  return typeof connector === 'string' ? getConnector(connector) : connector;
}

/** A connector's bare brand mark, legible in light and dark. */
export function AppMark({ connector, size = 16, className }: { connector: Connector | string; size?: number; className?: string }) {
  const resolved = resolve(connector);
  if (resolved === undefined) return null;
  const dark = isNearBlack(resolved.icon.color);
  return <ConnectorIcon connector={resolved} variant="mark" size={size} colored={!dark} className={cn(dark && 'text-foreground', className)} />;
}

/** The mark on a soft tile tinted with the brand colour, the way nodes show it in the builder. */
export function AppTile({ connector, size = 16, className }: { connector: Connector | string; size?: number; className?: string }) {
  const resolved = resolve(connector);
  if (resolved === undefined) return null;
  const dark = isNearBlack(resolved.icon.color);
  const tile = Math.round(size * 1.9);
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center rounded-lg border border-black/5 dark:border-white/10', dark && 'bg-muted', className)}
      style={{ width: tile, height: tile, ...(dark ? {} : { background: `${resolved.icon.color}1f` }) }}
    >
      <AppMark connector={resolved} size={size} />
    </span>
  );
}
