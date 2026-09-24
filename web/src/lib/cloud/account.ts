'use client';

/**
 * Who is using the studio: a guest, whose work lives in this browser, or a
 * signed-in person, whose workspace is mirrored to their account.
 *
 * A guest never costs the server anything. Signing in leaves a hint in
 * localStorage; only with that hint does the studio ask the server who you
 * are, so a visitor trying the demo loads no account code paths at all.
 */
import { createContext, useContext } from 'react';
import { create } from 'zustand';
import type { AccountUser, AuthCapabilities, OnboardingAnswers } from './types';
import { NO_ACCOUNTS, SESSION_MARKER_COOKIE } from './types';

export type AccountStatus =
  /** Accounts are off on this deployment. */
  | 'disabled'
  /** Not yet known: the first answer from the server is on its way. */
  | 'unknown'
  | 'guest'
  /** Signed in, and the workspace is being fetched. */
  | 'loading'
  | 'signed-in';

export interface AccountState {
  capabilities: AuthCapabilities;
  status: AccountStatus;
  user: AccountUser | null;
  onboardedAt: string | null;
  onboarding: OnboardingAnswers | null;
  /** Workflow id → public share slug. */
  shares: Record<string, string>;
  /** Set when loading the workspace failed, so the studio can offer to retry. */
  loadError: string | null;
  /**
   * Bumped whenever a workflow is replaced from the server underneath an open
   * screen (a conflict), so the builder remounts on the new copy instead of
   * writing its old working copy back.
   */
  epoch: number;
}

export const useAccount = create<AccountState>()(() => ({
  capabilities: NO_ACCOUNTS,
  status: 'unknown',
  user: null,
  onboardedAt: null,
  onboarding: null,
  shares: {},
  loadError: null,
  epoch: 0,
}));

export const HINT_KEY = 'relay-account-hint';

/** Whether this browser may be signed in. A hint, not proof: the server decides. */
export function hasSessionHint(): boolean {
  if (document.cookie.split(';').some((part) => part.trim().startsWith(`${SESSION_MARKER_COOKIE}=1`))) return true;
  try {
    return window.localStorage.getItem(HINT_KEY) !== null;
  } catch {
    return false;
  }
}

/** Remembers that this browser is signed in, and who as, so an offline reload can still say whose work it shows. */
export function setSessionHint(on: boolean, user?: AccountUser): void {
  try {
    if (on) {
      window.localStorage.setItem(HINT_KEY, JSON.stringify(user ?? null));
    } else {
      window.localStorage.removeItem(HINT_KEY);
      // The server clears it on sign-out; this covers a session that simply expired.
      document.cookie = `${SESSION_MARKER_COOKIE}=; path=/; max-age=0; samesite=lax`;
    }
  } catch {
    // Private mode without storage: the studio just asks the server every time.
  }
}

export function hintedUser(): AccountUser | null {
  try {
    const raw = window.localStorage.getItem(HINT_KEY);
    const parsed = raw === null ? null : (JSON.parse(raw) as unknown);
    return parsed !== null && typeof parsed === 'object' && typeof (parsed as AccountUser).id === 'string' ? (parsed as AccountUser) : null;
  } catch {
    return null;
  }
}

/** The signed-in person, or `null` for a guest. */
export function useUser(): AccountUser | null {
  return useAccount((state) => (state.status === 'signed-in' ? state.user : null));
}

/** True once the studio knows whether this is a guest or an account, and has the data to show. */
export function useWorkspaceReady(): boolean {
  return useAccount((state) => state.status === 'disabled' || state.status === 'guest' || state.status === 'signed-in');
}

/**
 * What this deployment supports, straight from the server-rendered layout,
 * so the first render — on the server too — already knows whether to draw
 * a sign-up button or a GitHub button.
 */
export const CapabilitiesContext = createContext<AuthCapabilities>(NO_ACCOUNTS);

export function useCapabilities(): AuthCapabilities {
  return useContext(CapabilitiesContext);
}
