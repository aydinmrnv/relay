'use client';

import { useSyncExternalStore } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { isMac, keyLabel, SHORTCUTS } from '@/lib/shortcuts';

const subscribe = () => () => undefined;

/** The keyboard shortcuts, as a dialog opened with "?" or from the help menu. */
export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  // The platform decides ⌘ versus Ctrl; the server renders Ctrl and the client corrects it.
  const mac = useSyncExternalStore(subscribe, isMac, () => false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Single-letter shortcuts are ignored while you are typing in a field.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          {SHORTCUTS.map((group) => (
            <section key={group.group} className="grid gap-2">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{group.group}</p>
              <ul className="grid gap-1.5">
                {group.items.map((shortcut) => (
                  <li key={shortcut.what} className="flex items-center justify-between gap-4 text-sm">
                    <span>{shortcut.what}</span>
                    <KbdGroup>
                      {shortcut.keys.map((key) => (
                        <Kbd key={key}>{keyLabel(key, mac)}</Kbd>
                      ))}
                    </KbdGroup>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
