'use client';

import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { useCalmMotion } from '@/components/motion/use-calm-motion';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { getConnector, type Connector } from '@/lib/connectors';
import { cn } from '@/lib/utils';

/** The engine's public repository. The only external product link on the page. */
export { REPO_URL } from '@/lib/links';

/** In-page anchors, shared by the header, the mobile menu and the footer so none can point at nothing. */
export const SECTIONS = [
  { id: 'how', label: 'How it works' },
  { id: 'builder', label: 'The studio' },
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
 * hydration. Content stays visible before hydration and below the fold, so
 * a delayed observer never leaves empty sections. "Reduced" is instant
 * on a server-rendered visit too. On a client-side visit with reduced motion,
 * `initial={false}` means it is simply there.
 */
export function Reveal({
  children,
  className,
  delay = 0,
  y = 14,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  y?: number;
}) {
  const reduce = useCalmMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? false : { opacity: 1, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.15 }}
      transition={{ duration: reduce ? 0 : 0.5, ease: EASE, delay: reduce ? 0 : delay }}
    >
      {children}
    </motion.div>
  );
}

/**
 * A section's opening: a small label, the claim, and a line of support. Left
 * aligned, so the page reads like a document rather than a stack of banners.
 */
export function SectionHeading({
  eyebrow,
  title,
  description,
  className,
}: {
  eyebrow: string;
  title: ReactNode;
  description?: ReactNode;
  className?: string;
}) {
  return (
    <Reveal className={cn('flex max-w-2xl flex-col gap-3', className)}>
      <p className="font-mono text-xs text-muted-foreground">{eyebrow}</p>
      <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{title}</h2>
      {description === undefined ? null : (
        <p className="max-w-xl text-base leading-relaxed text-pretty text-muted-foreground">{description}</p>
      )}
    </Reveal>
  );
}

function resolve(connector: Connector | string): Connector | undefined {
  return typeof connector === 'string' ? getConnector(connector) : connector;
}

/**
 * A connector's mark, in the text colour. The page names a dozen apps; in
 * their own brand colours they would outshout everything they sit next to.
 */
export function AppMark({ connector, size = 16, className }: { connector: Connector | string; size?: number; className?: string }) {
  const resolved = resolve(connector);
  if (resolved === undefined) return null;
  return <ConnectorIcon connector={resolved} variant="mark" size={size} colored={false} className={cn('text-foreground', className)} />;
}

/** The mark on a plain square, the size the builder's nodes show it at. */
export function AppTile({ connector, size = 16, className }: { connector: Connector | string; size?: number; className?: string }) {
  const resolved = resolve(connector);
  if (resolved === undefined) return null;
  const tile = Math.round(size * 1.9);
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center rounded-md border bg-background', className)}
      style={{ width: tile, height: tile }}
    >
      <AppMark connector={resolved} size={size} />
    </span>
  );
}
