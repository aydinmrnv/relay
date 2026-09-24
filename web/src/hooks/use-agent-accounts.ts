'use client';

import { useEffect } from 'react';
import { create } from 'zustand';
import { HOSTED_DEMO } from '@/lib/hosted';
import type { AgentId, AgentsStatus, LoginMode, LoginSessionView } from '@/lib/agents/types';

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

async function expectJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

/** Live sign-in state of the vendor CLIs on this machine. Never persisted: it is re-asked, not remembered. */
export const useAgentsStore = create<AgentsStore>()((set, get) => ({
  bridge: 'unknown',
  status: null,
  loading: false,

  refresh: async () => {
    if (get().loading) return;
    if (HOSTED_DEMO) {
      set({ bridge: 'unavailable', status: null });
      return;
    }
    set({ loading: true });
    try {
      const response = await fetch('/api/agents', { cache: 'no-store' });
      if (!response.ok) {
        set({ bridge: 'unavailable', status: null, loading: false });
        return;
      }
      const status = (await response.json()) as AgentsStatus;
      set({ bridge: 'available', status, loading: false });
    } catch {
      set({ bridge: 'unavailable', status: null, loading: false });
    }
  },

  startLogin: async (agent, mode) => {
    const response = await fetch(`/api/agents/${agent}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) });
    return expectJson<LoginSessionView>(response);
  },

  pollLogin: async (id) => expectJson<LoginSessionView>(await fetch(`/api/agents/login/${id}`, { cache: 'no-store' })),

  submitCode: async (id, code) => {
    await expectJson<{ ok: boolean }>(await fetch(`/api/agents/login/${id}/code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) }));
  },

  cancelLogin: async (id) => {
    await fetch(`/api/agents/login/${id}`, { method: 'DELETE' }).catch(() => undefined);
  },

  logout: async (agent) => {
    await expectJson<{ ok: boolean; detail: string }>(await fetch(`/api/agents/${agent}/logout`, { method: 'POST' }));
    await get().refresh();
  },
}));

/** Mount once. Polls while the tab is visible and re-checks on focus. */
export function useAgentsPoller(intervalMs = 30_000): void {
  const refresh = useAgentsStore((state) => state.refresh);
  useEffect(() => {
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
  }, [refresh, intervalMs]);
}

/** Convenience selector: which agents are signed in, keyed by id. Empty when the bridge is unavailable. */
export function useSignedIn(): Partial<Record<AgentId, boolean>> {
  const status = useAgentsStore((state) => state.status);
  if (status === null) return {};
  return { claude: status.agents.claude.loggedIn, codex: status.agents.codex.loggedIn };
}
