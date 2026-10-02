'use client';

import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { useCalmMotion } from '@/components/motion/use-calm-motion';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { agentMark } from '@/lib/agents/marks';
import { getConnector, type Connector } from '@/lib/connectors';
import { useAccount, useCapabilities } from '@/lib/cloud/account';
import { signInThenTo } from '@/lib/studio-routes';
import { cn } from '@/lib/utils';

/** The engine's public repository. The only external product link on the page. */
export { REPO_URL } from '@/lib/links';
export { SAMPLE } from './sample';

/** In-page anchors, shared by the header, the mobile menu and the footer so none can point at nothing. */
/**
 * Whether this deployment offers Relay Cloud. The public pages mention it
 * only then: advertising a machine nobody can be given is worse than not
 * mentioning one.
 */
export function useCloudOffered(): boolean {
  return useCapabilities().cloudHub != null;
}

export const SECTIONS = [
  { id: 'how', label: 'How it works' },
  { id: 'builder', label: 'The studio' },
  { id: 'different', label: 'What’s different' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'pricing', label: 'Pricing' },
  { id: 'faq', label: 'FAQ' },
] as const;

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * The way into the studio, the same on every button. The studio needs an
 * account, so someone signed out is sent to sign in — one form that also
 * makes a new account — and `into` then carries on to the page the link was
 * for. Only a development copy without accounts opens the studio directly.
 *
 * `playground` is the builder without an account, for a visitor who wants to
 * see it before making one. Where a deployment has no sign-in at all it is
 * the only way in, so every button leads there instead of to a sign-in page
 * that can only say it is unavailable.
 */
export function useStudioEntry() {
  const signedIn = useAccount((state) => state.status === 'signed-in');
  const { guests, enabled: accounts } = useCapabilities();
  const invite = !signedIn && !guests;
  const closed = invite && !accounts;
  return {
    signedIn,
    invite,
    href: closed ? '/play' : invite ? '/sign-in' : '/dashboard',
    label: signedIn ? 'Go to dashboard' : 'Try it free',
    into: (path: string) => (closed ? '/play' : invite ? signInThenTo(path) : path),
    // `null` where the main button already goes there, so no page shows two buttons to one place.
    playground: invite && !closed ? '/play' : null,
    /** The builder: the studio's for someone in it, the playground's for everyone else. */
    builder: invite ? '/play' : '/workflows',
  };
}

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
 * The page's buttons, one shape throughout: a pill, like the header's. Pass
 * to `Button` with `variant="outline"` for the quieter of a pair.
 */
export const PILL = 'h-10 rounded-full px-4 has-data-[icon=inline-end]:pr-3.5';

/** A section's label: small capitals in the mono face, with a short rule before it. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('flex items-center gap-2.5 font-mono text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase', className)}>
      <span aria-hidden className="h-px w-5 bg-foreground/30" />
      {children}
    </p>
  );
}

/** A section's claim, the one size every section uses. */
export const SECTION_TITLE = 'text-3xl leading-[1.1] font-semibold tracking-[-0.03em] text-balance sm:text-[2.75rem]';

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
    <Reveal className={cn('flex max-w-3xl flex-col gap-4', className)}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className={SECTION_TITLE}>{title}</h2>
      {description === undefined ? null : (
        <p className="max-w-xl text-base leading-relaxed text-pretty text-muted-foreground sm:text-[17px]">{description}</p>
      )}
    </Reveal>
  );
}

type Marked = Pick<Connector, 'name' | 'icon'>;

/**
 * An app from the catalog, or one of the coding agents (`claude`, `codex`),
 * by id. An id that is neither still draws something: a monogram of the id,
 * never an empty box.
 */
function resolve(connector: Marked | string): Marked {
  if (typeof connector !== 'string') return connector;
  return agentMark(connector) ?? getConnector(connector) ?? { name: connector, icon: { color: '#64748b' } };
}

/**
 * A connector's mark, in the text colour. The page names a dozen apps; in
 * their own brand colours they would outshout everything they sit next to.
 */
export function AppMark({ connector, size = 16, className }: { connector: Marked | string; size?: number; className?: string }) {
  const resolved = resolve(connector);
  return <ConnectorIcon connector={resolved} variant="mark" size={size} colored={false} className={cn('text-foreground', className)} />;
}

/** The mark on a plain square, the size the builder's nodes show it at. */
export function AppTile({ connector, size = 16, className }: { connector: Marked | string; size?: number; className?: string }) {
  const resolved = resolve(connector);
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
