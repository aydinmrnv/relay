/**
 * What setup keeps in this tab while somebody is part-way through it.
 *
 * The answers so far, so that the browser's Back button, a reload or a detour
 * to the docs does not throw them away: one draft for the first project and
 * one for adding another, because they are different errands. And a note
 * that setup was left on purpose, so the dashboard does not send a new
 * account straight back into it when the server could not be told.
 */
export type SetupMode = 'first' | 'add';

const draftKey = (mode: SetupMode) => `relay:setup:${mode}`;
const LEFT_KEY = 'relay:setup:left';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readSetupDraft(mode: SetupMode): Record<string, unknown> {
  try {
    const raw = storage()?.getItem(draftKey(mode)) ?? null;
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function writeSetupDraft(mode: SetupMode, draft: Record<string, unknown>): void {
  try {
    storage()?.setItem(draftKey(mode), JSON.stringify(draft));
  } catch {
    // No session storage: the answers last as long as the page does.
  }
}

export function clearSetupDraft(mode: SetupMode): void {
  try {
    storage()?.removeItem(draftKey(mode));
  } catch {
    // Nothing kept, nothing to clear.
  }
}

/** Setup was skipped or finished in this tab. */
export function markSetupLeft(): void {
  try {
    storage()?.setItem(LEFT_KEY, '1');
  } catch {
    // Without it the dashboard asks the account instead, which is right whenever the server answered.
  }
}

export function leftSetup(): boolean {
  try {
    return storage()?.getItem(LEFT_KEY) === '1';
  } catch {
    return false;
  }
}
