'use client';

import { createContext, useContext } from 'react';

/**
 * Where the builder and a run's page send people. The studio's own screens
 * need an account; the playground shows the same builder to someone without
 * one, so the links that would bounce them to sign-in go to its own pages.
 */
export interface StudioLinks {
  /** True in the playground: the screens an account adds (settings, the runs list, templates) are not there to link to. */
  playground: boolean;
  run: (id: string) => string;
  /** Where a run's page goes back to. */
  runs: string;
  workflow: (id: string) => string;
}

export const STUDIO_LINKS: StudioLinks = {
  playground: false,
  run: (id) => `/runs/${id}`,
  runs: '/runs',
  workflow: (id) => `/workflows/${id}`,
};

export const PLAYGROUND_LINKS: StudioLinks = {
  playground: true,
  run: (id) => `/play/runs/${id}`,
  runs: '/play',
  workflow: (id) => `/play?open=${encodeURIComponent(id)}`,
};

export const StudioLinksContext = createContext<StudioLinks>(STUDIO_LINKS);

export function useStudioLinks(): StudioLinks {
  return useContext(StudioLinksContext);
}
