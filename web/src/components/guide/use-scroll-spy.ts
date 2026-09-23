'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * Which of `ids` the reader is looking at: the last section whose top has
 * scrolled past `offset` pixels (the sticky header plus a little air), or the
 * last section once the page cannot scroll any further.
 *
 * Built on useSyncExternalStore rather than an effect that sets state, so the
 * answer is read straight from the DOM whenever the page scrolls or resizes.
 * No requestAnimationFrame throttle: a handful of getBoundingClientRect calls
 * per scroll event is cheap, and rAF does not run in a hidden tab.
 */
export function useScrollSpy(ids: readonly string[], offset = 96): string | undefined {
  const getSnapshot = useCallback(() => activeSection(ids, offset), [ids, offset]);
  const getServerSnapshot = useCallback(() => ids[0], [ids]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('scroll', onChange, { passive: true });
  window.addEventListener('resize', onChange);
  window.addEventListener('hashchange', onChange);
  return () => {
    window.removeEventListener('scroll', onChange);
    window.removeEventListener('resize', onChange);
    window.removeEventListener('hashchange', onChange);
  };
}

function activeSection(ids: readonly string[], offset: number): string | undefined {
  const root = document.documentElement;
  const atBottom = window.innerHeight + window.scrollY >= root.scrollHeight - 4;
  if (atBottom && window.scrollY > 0) return ids.at(-1);
  let active = ids[0];
  for (const id of ids) {
    const element = document.getElementById(id);
    if (element === null) continue;
    if (element.getBoundingClientRect().top - offset <= 1) active = id;
    else break;
  }
  return active;
}

/**
 * Scrolls to an in-page section and records it in the address bar, smoothly
 * unless the reader asked for less motion. Returns false when there is no such
 * element, so the caller can let the browser handle the link instead.
 */
export function scrollToSection(id: string, smooth: boolean): boolean {
  const element = document.getElementById(id);
  if (element === null) return false;
  element.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  window.history.replaceState(window.history.state, '', `#${id}`);
  return true;
}
