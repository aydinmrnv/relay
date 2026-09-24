'use client';

/**
 * Who is using the studio: a guest, whose work lives in this browser, or a
 * signed-in person, whose workspace is mirrored to their account. Clerk says
 * which (see `ClerkBridge` in providers.tsx); a guest never asks the
 * studio's own server anything.
 */
import { createContext, useContext } from 'react';
import { create } from 'zustand';
import type { AccountUser, AuthCapabilities, OnboardingAnswers } from './types';
import { NO_ACCOUNTS } from './types';

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
