/** Keyboard shortcuts, listed once for the shortcuts dialog and the guide. `mod` is ⌘ on a Mac and Ctrl elsewhere. */
export interface Shortcut {
  keys: string[];
  what: string;
}

export const SHORTCUTS: Array<{ group: string; items: Shortcut[] }> = [
  {
    group: 'Anywhere',
    items: [
      { keys: ['mod', 'K'], what: 'Search workflows, runs, apps and pages' },
      { keys: ['?'], what: 'Show these shortcuts' },
    ],
  },
  {
    group: 'In the builder',
    items: [
      { keys: ['A'], what: 'Add a node (connected to the selected one)' },
      { keys: ['mod', 'Enter'], what: 'Start a test run' },
      { keys: ['mod', 'Z'], what: 'Undo' },
      { keys: ['mod', 'Shift', 'Z'], what: 'Redo' },
      { keys: ['mod', 'D'], what: 'Duplicate the selected node' },
      { keys: ['mod', 'C'], what: 'Copy the selected nodes' },
      { keys: ['mod', 'V'], what: 'Paste' },
      { keys: ['Backspace'], what: 'Delete the selection' },
      { keys: ['Shift', '1'], what: 'Fit the whole workflow on screen' },
      { keys: ['Esc'], what: 'Clear the selection' },
    ],
  },
];

export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
}

export function keyLabel(key: string, mac: boolean): string {
  if (key === 'mod') return mac ? '⌘' : 'Ctrl';
  if (key === 'Shift') return mac ? '⇧' : 'Shift';
  if (key === 'Enter') return mac ? '↵' : 'Enter';
  if (key === 'Backspace') return mac ? '⌫' : 'Backspace';
  return key;
}

/** True when a key event came from somewhere the user is typing, so single-key shortcuts must not fire. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.getAttribute('role') === 'combobox';
}
