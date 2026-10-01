'use client';

import { useSyncExternalStore } from 'react';
import { isMac, keyLabel } from '@/lib/shortcuts';

const subscribe = () => () => undefined;

/** Whether this is a Mac, for naming keys. The server renders the other answer and the client corrects it. */
export function useIsMac(): boolean {
  return useSyncExternalStore(subscribe, isMac, () => false);
}

/**
 * Names a shortcut the way this platform writes it: `combo('mod', 'Z')` is
 * ⌘Z on a Mac and Ctrl+Z anywhere else, where ⌘ is a key nobody has.
 */
export function useCombo(): (...keys: string[]) => string {
  const mac = useIsMac();
  return (...keys) => keys.map((key) => keyLabel(key, mac)).join(mac ? '' : '+');
}
