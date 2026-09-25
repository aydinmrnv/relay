'use client';

import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import type { Connector, ConnectorIcon as ConnectorIconSpec } from '@/lib/connectors/types';
import { LUCIDE_ICONS, SI_ICONS } from '@/lib/connectors/icons.generated';

interface Props {
  connector?: Pick<Connector, 'name' | 'icon'>;
  icon?: ConnectorIconSpec;
  name?: string;
  size?: number;
  className?: string;
  /** `mark` draws the bare glyph; `tile` puts it on a plain rounded tile. */
  variant?: 'mark' | 'tile';
  /** When true the mark uses the brand colour; otherwise it inherits `currentColor`. */
  colored?: boolean;
}

/**
 * Brand colours that are nearly black (GitHub, Slack's aubergine, Zendesk…)
 * vanish on a dark background. For those, dark mode mixes the colour towards
 * white, which keeps the hue but makes the mark readable.
 */
function isVeryDark(hex: string): boolean {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (match === null) return false;
  const value = Number.parseInt(match[1]!, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.25;
}

function brandVars(color: string): CSSProperties {
  return { '--brand': color, '--brand-on-dark': isVeryDark(color) ? `color-mix(in oklch, ${color} 30%, white)` : color } as CSSProperties;
}

const MARK_COLOR = 'text-(--brand) dark:text-(--brand-on-dark)';

export function ConnectorIcon({ connector, icon, name, size = 20, className, variant = 'tile', colored = true }: Props) {
  const spec = icon ?? connector?.icon;
  const label = name ?? connector?.name ?? '?';
  const color = spec?.color ?? '#64748b';
  const Si = spec?.si !== undefined ? SI_ICONS[spec.si] : undefined;
  const Lucide = spec?.lucide !== undefined ? LUCIDE_ICONS[spec.lucide] : undefined;
  const Mark = Si ?? Lucide;

  if (variant === 'mark') {
    if (Mark !== undefined) {
      return <Mark size={size} className={cn(colored ? MARK_COLOR : '', className)} style={colored ? brandVars(color) : undefined} aria-label={label} />;
    }
    return <Monogram label={label} color={color} size={size} className={className} />;
  }

  const tile = Math.round(size * 1.8);
  return (
    <span
      className={cn(
        // A plain tile: the mark carries the brand, so the tile does not repeat it.
        'inline-flex shrink-0 items-center justify-center rounded-md border bg-background',
        className,
      )}
      style={{ width: tile, height: tile, ...brandVars(color) }}
      aria-label={label}
    >
      {Mark !== undefined ? <Mark size={size} className={MARK_COLOR} /> : <Monogram label={label} color={color} size={size} />}
    </span>
  );
}

function Monogram({ label, color, size, className }: { label: string; color: string; size: number; className?: string }) {
  const letters = label
    .split(/\s+/)
    .map((word) => word[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <span
      className={cn('inline-flex items-center justify-center rounded-md font-semibold text-white', className)}
      style={{ width: size, height: size, background: color, fontSize: Math.max(8, Math.round(size * 0.45)) }}
      aria-hidden
    >
      {letters}
    </span>
  );
}
