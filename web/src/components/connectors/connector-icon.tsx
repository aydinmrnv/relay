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
  /** `mark` draws the bare glyph; `tile` puts it on a rounded brand-coloured tile. */
  variant?: 'mark' | 'tile';
  /** When true the mark uses the brand colour; otherwise it inherits `currentColor`. */
  colored?: boolean;
}

export function ConnectorIcon({ connector, icon, name, size = 20, className, variant = 'tile', colored = true }: Props) {
  const spec = icon ?? connector?.icon;
  const label = name ?? connector?.name ?? '?';
  const color = spec?.color ?? '#64748b';
  const Si = spec?.si !== undefined ? SI_ICONS[spec.si] : undefined;
  const Lucide = spec?.lucide !== undefined ? LUCIDE_ICONS[spec.lucide] : undefined;
  const Mark = Si ?? Lucide;

  if (variant === 'mark') {
    if (Mark !== undefined) {
      return <Mark size={size} className={className} style={colored ? ({ color } as CSSProperties) : undefined} aria-label={label} />;
    }
    return <Monogram label={label} color={color} size={size} className={className} />;
  }

  const tile = Math.round(size * 1.8);
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center rounded-lg border border-black/5 dark:border-white/10', className)}
      style={{ width: tile, height: tile, background: `${color}1a` }}
      aria-label={label}
    >
      {Mark !== undefined ? (
        <Mark size={size} style={{ color } as CSSProperties} />
      ) : (
        <Monogram label={label} color={color} size={size} />
      )}
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
