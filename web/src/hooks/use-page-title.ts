'use client';

import { useEffect } from 'react';
import { BRAND } from '@/lib/brand';

/**
 * Names the tab after something only the browser knows: which workflow, which
 * run. The route's own metadata is the title until this runs, and again when
 * there is nothing to name.
 */
export function usePageTitle(name: string | undefined): void {
  useEffect(() => {
    if (name === undefined || name.trim().length === 0) return;
    const before = document.title;
    document.title = `${name.trim()} · ${BRAND.name}`;
    return () => {
      document.title = before;
    };
  }, [name]);
}
