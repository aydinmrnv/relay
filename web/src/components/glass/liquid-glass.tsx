'use client';

import { useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { Glass, type GlassOptics } from '@samasante/liquid-glass';
import { cn } from '@/lib/utils';

const LESS_TRANSPARENCY = '(prefers-reduced-transparency: reduce)';

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(LESS_TRANSPARENCY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** False on the server and while hydrating, so the first client render matches the HTML. */
function useLessTransparency(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(LESS_TRANSPARENCY).matches,
    () => false,
  );
}

/**
 * Apple's recipe, read off its own dock and widgets: heavy frost and a colour
 * boost behind, a milky white veil that lifts the backdrop in light and dark
 * alike, and a soft shadow underneath.
 */
const MATERIAL = cn(
  'bg-white/40 shadow-[0_10px_36px_-12px_rgb(0_0_0/0.22),0_1px_3px_rgb(0_0_0/0.08)]',
  'dark:bg-white/[0.08] dark:shadow-[0_10px_36px_-10px_rgb(0_0_0/0.55),0_1px_3px_rgb(0_0_0/0.25)]',
);

/** A compact control: the rim bends hard, the middle a little. */
const OPTICS: Partial<GlassOptics> = {
  strength: 0.1,
  depth: 0.45,
  curvature: 0.2,
  bend: 0.8,
  dispersion: 0.35,
  frost: 12,
  saturate: 1.8,
  sheen: 0.6,
  glow: 0.2,
};

// The rim catches the light at the top left and, reflected, the bottom right.
const RIM: CSSProperties = {
  padding: 1,
  background:
    'linear-gradient(135deg, rgb(255 255 255 / 0.8), rgb(255 255 255 / 0.14) 26%, rgb(255 255 255 / 0.04) 50%, rgb(255 255 255 / 0.14) 74%, rgb(255 255 255 / 0.6))',
  mask: 'linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0)',
};
const INNER_LIGHT: CSSProperties = {
  boxShadow: 'inset 0 1px 1px rgb(255 255 255 / 0.4), inset 0 -1px 1px rgb(255 255 255 / 0.14), inset 0 0 18px rgb(255 255 255 / 0.1)',
};

function Rim() {
  return (
    <>
      <span aria-hidden className="pointer-events-none absolute inset-0 rounded-[inherit]" style={RIM} />
      <span aria-hidden className="pointer-events-none absolute inset-0 rounded-[inherit]" style={INNER_LIGHT} />
    </>
  );
}

export interface LiquidGlassProps {
  className?: string;
  style?: CSSProperties;
  /** The optical look, over the compact-control defaults. */
  optics?: Partial<GlassOptics>;
  children: ReactNode;
}

/**
 * Apple-style Liquid Glass. `@samasante/liquid-glass` frosts the page behind
 * and bends it through a curved rim with chromatic dispersion (Chrome and
 * Edge; Safari and Firefox frost without the bend), and this adds Apple's
 * veil, rim light and shadow. Readers who asked for less transparency get
 * what Apple gives them: the same shape, rim and shadow, frostier and nearly
 * opaque.
 *
 * Style it like any box; the corner radius comes from its CSS and a
 * `bg-*` class overrides the veil. The children render crisp on top. It is an
 * inline block unless `style` says otherwise.
 */
export function LiquidGlass({ className, style, optics, children }: LiquidGlassProps) {
  const solid = useLessTransparency();
  const classes = cn('relative', MATERIAL, className);
  if (solid) {
    return (
      <div
        className={classes}
        style={{
          display: 'inline-block',
          ...style,
          backgroundColor: 'color-mix(in oklch, var(--popover) 90%, transparent)',
          backdropFilter: 'blur(24px) saturate(1.4)',
          WebkitBackdropFilter: 'blur(24px) saturate(1.4)',
        }}
      >
        <Rim />
        {children}
      </div>
    );
  }
  return (
    <Glass className={classes} style={style} optics={optics === undefined ? OPTICS : { ...OPTICS, ...optics }}>
      <Rim />
      {children}
    </Glass>
  );
}
