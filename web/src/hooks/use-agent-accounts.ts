'use client';

import { useEffect } from 'react';
import { create } from 'zustand';
import { companionFetch, useCompanion } from '@/lib/companion/client';
import type { AgentId, AgentsStatus, LoginMode, LoginSessionView } from '@/lib/agents/types';

/**
 * `available`: a paired `relay connect` answered. `unavailable`: there is no
 * machine to ask — not paired, or the companion is not running.
 */
export type BridgeState = 'unknown' | 'available' | 'unavailable';

interface AgentsStore {
  bridge: BridgeState;
  status: AgentsStatus | null;
  loading: boolean;
  refresh: () => Promise<void>;
  startLogin: (agent: AgentId, mode: LoginMode) => Promise<LoginSessionView>;
  pollLogin: (id: string) => Promise<LoginSessionView>;
  submitCode: (id: string, code: string) => Promise<void>;
  cancelLogin: (id: string) => Promise<void>;
  logout: (agent: AgentId) => Promise<void>;
}

/**
 * Live sign-in state of the coding CLIs on the paired machine, asked through
 * `relay connect`. Never persisted: it is re-asked, not remembered.
 */
export const useAgentsStore = create<AgentsStore>()((set, get) => ({
  bridge: 'unknown',
  status: null,
  loading: false,

  refresh: async () => {
    if (get().loading) return;
    const companion = useCompanion.getState();
    if (!companion.hydrated) return;
    if (companion.pairing === null) {
      set({ bridge: 'unavailable', status: null });
      return;
    }
    set({ loading: true });
    await companion.refresh();
    if (useCompanion.getState().status !== 'connected') {
      set({ bridge: 'unavailable', status: null, loading: false });
      return;
    }
    try {
      const status = await companionFetch<AgentsStatus>('/v1/agents');
      set({ bridge: 'available', status, loading: false });
    } catch {
      set({ bridge: 'unavailable', status: null, loading: false });
    }
  },

  startLogin: (agent, mode) => companionFetch<LoginSessionView>(`/v1/agents/${agent}/login`, { method: 'POST', body: { mode } }),

  pollLogin: (id) => companionFetch<LoginSessionView>(`/v1/logins/${encodeURIComponent(id)}`),

  submitCode: async (id, code) => {
    await companionFetch<{ ok: boolean }>(`/v1/logins/${encodeURIComponent(id)}/code`, { method: 'POST', body: { code } });
  },

  cancelLogin: async (id) => {
    await companionFetch(`/v1/logins/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);
  },

  logout: async (agent) => {
    await companionFetch<{ ok: boolean; detail: string }>(`/v1/agents/${agent}/logout`, { method: 'POST' });
    await get().refresh();
  },
}));

/** Mount once. Polls while the tab is visible, re-checks on focus, and follows pairing changes. */
export function useAgentsPoller(intervalMs = 30_000): void {
  const refresh = useAgentsStore((state) => state.refresh);
  const hydrated = useCompanion((state) => state.hydrated);
  const pairing = useCompanion((state) => state.pairing);
  useEffect(() => {
    if (!hydrated) return;
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, intervalMs);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh, intervalMs, hydrated, pairing]);
}

/** Convenience selector: which agents are signed in, keyed by id. Empty when no machine is connected. */
export function useSignedIn(): Partial<Record<AgentId, boolean>> {
  const status = useAgentsStore((state) => state.status);
  if (status === null) return {};
  return { claude: status.agents.claude.loggedIn, codex: status.agents.codex.loggedIn };
}
