'use client';

import { useEffect } from 'react';
import { create } from 'zustand';
import { companionFetch, useCompanion } from '@/lib/companion/client';
import type { AccountId, AgentId, AgentsStatus, GithubAccount, LoginMode, LoginSessionView } from '@/lib/agents/types';

/**
 * `available`: a paired `relay connect` answered. `unavailable`: there is no
 * machine to ask — not paired, or the companion is not running.
 */
export type BridgeState = 'unknown' | 'available' | 'unavailable';

interface AgentsStore {
  bridge: BridgeState;
  status: AgentsStatus | null;
  /** GitHub on the runner, for a runner that signs in to it itself (a Relay Cloud machine). */
  github: GithubAccount | null;
  loading: boolean;
  refresh: () => Promise<void>;
  startLogin: (account: AccountId, mode: LoginMode) => Promise<LoginSessionView>;
  pollLogin: (id: string) => Promise<LoginSessionView>;
  submitCode: (id: string, code: string) => Promise<void>;
  cancelLogin: (id: string) => Promise<void>;
  logout: (account: AccountId) => Promise<void>;
}

/**
 * Live sign-in state of the coding CLIs on the paired machine, asked through
 * `relay connect`. Never persisted: it is re-asked, not remembered.
 */
export const useAgentsStore = create<AgentsStore>()((set, get) => ({
  bridge: 'unknown',
  status: null,
  github: null,
  loading: false,

  refresh: async () => {
    if (get().loading) return;
    const companion = useCompanion.getState();
    if (!companion.hydrated) return;
    if (companion.target === 'machine' && companion.pairing === null) {
      set({ bridge: 'unavailable', status: null, github: null });
      return;
    }
    set({ loading: true });
    await companion.refresh();
    const now = useCompanion.getState();
    if (now.status !== 'connected') {
      set({ bridge: 'unavailable', status: null, github: null, loading: false });
      return;
    }
    try {
      const withGithub = (now.hello?.capabilities ?? []).includes('github');
      const [status, github] = await Promise.all([
        companionFetch<AgentsStatus>('/v1/agents'),
        withGithub ? companionFetch<GithubAccount>('/v1/github').catch(() => null) : Promise.resolve(null),
      ]);
      set({ bridge: 'available', status, github, loading: false });
    } catch {
      set({ bridge: 'unavailable', status: null, github: null, loading: false });
    }
  },

  startLogin: (account, mode) =>
    account === 'github'
      ? companionFetch<LoginSessionView>('/v1/github/login', { method: 'POST', body: { mode: 'device' } })
      : companionFetch<LoginSessionView>(`/v1/agents/${account}/login`, { method: 'POST', body: { mode } }),

  pollLogin: (id) => companionFetch<LoginSessionView>(`/v1/logins/${encodeURIComponent(id)}`),

  submitCode: async (id, code) => {
    await companionFetch<{ ok: boolean }>(`/v1/logins/${encodeURIComponent(id)}/code`, { method: 'POST', body: { code } });
  },

  cancelLogin: async (id) => {
    await companionFetch(`/v1/logins/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);
  },

  logout: async (account) => {
    await companionFetch<{ ok: boolean; detail: string }>(account === 'github' ? '/v1/github/logout' : `/v1/agents/${account}/logout`, { method: 'POST' });
    await get().refresh();
  },
}));

/** Cloud states that change within seconds, and are worth watching closely. */
const MOVING = new Set(['queued', 'creating', 'starting', 'stopping', 'deleting']);

/**
 * Mount once. Polls while the tab is visible, re-checks on focus, and follows
 * pairing changes. A cloud machine on its way up or down is watched every few
 * seconds; the checks never wake it.
 */
export function useAgentsPoller(intervalMs = 30_000): void {
  const refresh = useAgentsStore((state) => state.refresh);
  const hydrated = useCompanion((state) => state.hydrated);
  const pairing = useCompanion((state) => state.pairing);
  const target = useCompanion((state) => state.target);
  const moving = useCompanion((state) => state.target === 'cloud' && state.cloud !== null && MOVING.has(state.cloud.state));
  const every = moving ? 4_000 : intervalMs;
  useEffect(() => {
    if (!hydrated) return;
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, every);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh, every, hydrated, pairing, target]);
}

/** Convenience selector: which agents are signed in, keyed by id. Empty when no machine is connected. */
export function useSignedIn(): Partial<Record<AgentId, boolean>> {
  const status = useAgentsStore((state) => state.status);
  if (status === null) return {};
  return { claude: status.agents.claude.loggedIn, codex: status.agents.codex.loggedIn };
}
