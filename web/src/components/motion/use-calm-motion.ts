'use client';

import { useSyncExternalStore } from 'react';
import { useReducedMotionConfig } from 'motion/react';

const subscribeNothing = () => () => {};

/**
 * Reduced motion, but only once hydration is over. The server cannot know the
 * preference, and neither can the hydrating render (the store and the media
 * query are read afterwards), so answering "reduce" there would make the
 * client disagree with the server's HTML: React keeps the server's
 * `opacity: 0` and the content can stay hidden. After hydration, and on every
 * client-side visit, this is exactly `useReducedMotionConfig()`.
 */
export function useCalmMotion(): boolean {
  const reduce = useReducedMotionConfig();
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false);
  return hydrated && reduce === true;
}
