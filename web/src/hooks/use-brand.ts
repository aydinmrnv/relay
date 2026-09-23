'use client';

import { useStudio } from '@/lib/store';
import { DEFAULT_BRAND, type Brand } from '@/lib/brand';

/**
 * The brand as the user last set it. Before the store hydrates it returns the
 * build-time default, which is what the server rendered, so there is no flash.
 */
export function useBrand(): Brand {
  const hydrated = useStudio((state) => state.hydrated);
  const brand = useStudio((state) => state.brand);
  return hydrated ? brand : DEFAULT_BRAND;
}
