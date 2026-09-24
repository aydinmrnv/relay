'use client';

import { useId } from 'react';
import { cn } from '@/lib/utils';
import { useBrand } from '@/hooks/use-brand';
import { PIXEL_FONT } from '@/lib/pixel-font.generated';

// The geometry of scripts/gen-brand.mjs, which draws the favicon and the files
// in public/brand: a 5×5 glyph from the CLI's pixel font, drawn twice — the
// second pass a quarter-cell down and right — on the violet tile.
const PITCH = 9;
const PIXEL = 8;
const ECHO = 2.5;
const OFFSET = (64 - (PITCH * 4 + PIXEL) - ECHO) / 2;

/**
 * The logo, and one that survives a rename: the first letter of whatever the
 * product is called today, in the pixel font `relay start` prints its wordmark
 * in. For "Relay" it is exactly the favicon.
 */
export function BrandMark({ className }: { className?: string }) {
  const brand = useBrand();
  // useId can contain characters a url(#…) reference does not accept.
  const gradient = `brand-${useId().replace(/[^\w-]/g, '')}`;
  const letter = brand.name.trim().charAt(0).toUpperCase();
  const rows = PIXEL_FONT[letter] ?? PIXEL_FONT['R']!;

  const pixels = (shift: number, fill: string) =>
    rows.flatMap((row, y) =>
      [...row].map((cell, x) =>
        cell === '#' ? <rect key={`${shift}-${x}-${y}`} x={OFFSET + shift + x * PITCH} y={OFFSET + shift + y * PITCH} width={PIXEL} height={PIXEL} rx={1.8} fill={fill} /> : null,
      ),
    );

  return (
    <svg viewBox="0 0 64 64" role="img" aria-label={brand.name} className={cn('inline-block shrink-0 drop-shadow-sm', className)}>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#4f46e5" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill={`url(#${gradient})`} />
      {pixels(ECHO, '#5eead4')}
      {pixels(0, '#ffffff')}
    </svg>
  );
}
