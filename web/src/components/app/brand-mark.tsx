'use client';

import { cn } from '@/lib/utils';
import { useBrand } from '@/hooks/use-brand';

/** A logo that survives a rename: the first letter of whatever the product is called today. */
export function BrandMark({ className }: { className?: string }) {
  const brand = useBrand();
  const letter = brand.name.trim().charAt(0).toUpperCase() || '?';
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-600 to-indigo-500 font-semibold text-white shadow-sm',
        className,
      )}
      aria-label={brand.name}
    >
      <span className="text-[0.95em] leading-none">{letter}</span>
    </span>
  );
}
