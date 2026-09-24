'use client';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { HelloResponse } from './types';

/**
 * The studio's side of `relay connect`.
 *
 * The companion is a small server the Relay CLI runs on the user's machine, on
 * 127.0.0.1. It is how a studio — hosted or local — reaches the things only
 * that machine has: the coding CLIs and their sign-ins, and the repository.
 *
 * Two rules keep it polite:
 *
 *   - **Nothing is probed before pairing.** A browser asks the user before a
 *     web page may reach their machine, and a visitor who never ran `relay
 *     connect` should never see that question. The studio only talks to a
 *     companion after the pairing link put a port and a token here.
 *   - **The token lives in its own storage key**, outside the studio's data,
 *     so "Download all my data" and an import never carry it anywhere.
 */

export interface Pairing {
  port: number;
  token: string;
  pairedAt: string;
}

/**
 * `unpaired`: no pairing in this browser. `connecting`: asking. `connected`:
 * the companion answered and knows this studio. `unreachable`: nothing on the
 * paired port — usually `relay connect` is not running. `rejected`: something
 * answered but refused the token, which is what a rotated token looks like.
 */
export type CompanionStatus = 'unpaired' | 'connecting' | 'connected' | 'unreachable' | 'rejected';

export class CompanionError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

/** A failed attempt keeps what the link carried, in memory only, so the page can try again without it. */
export type PairingAttempt = { state: 'idle' } | { state: 'pairing' } | { state: 'failed'; error: string; port: number; token: string };

interface CompanionStore {
  pairing: Pairing | null;
  status: CompanionStatus;
  hello: HelloResponse | null;
  checkedAt: string | null;
  hydrated: boolean;
  /** The pairing link being checked, for the page it landed on. */
  attempt: PairingAttempt;
  /** Verifies a pairing against the companion before keeping it. */
  pair: (port: number, token: string) => Promise<HelloResponse>;
  forget: () => void;
  refresh: () => Promise<void>;
  markHydrated: () => void;
}

const STORAGE_KEY = 'relay-companion';

export function companionBase(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function hello(port: number, token: string): Promise<HelloResponse> {
  const response = await fetch(`${companionBase(port)}/v1/hello`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new CompanionError(`The companion answered ${response.status}.`, response.status);
  const body = (await response.json()) as HelloResponse;
  if (body.product !== 'relay') throw new CompanionError('Something else is listening on that port.');
  return body;
}

export const useCompanion = create<CompanionStore>()(
  persist(
    (set, get) => ({
      pairing: null,
      status: 'unpaired',
      hello: null,
      checkedAt: null,
      hydrated: false,
      attempt: { state: 'idle' },

      pair: async (port, token) => {
        set({ attempt: { state: 'pairing' } });
        let answer: HelloResponse;
        try {
          answer = await hello(port, token);
          if (!answer.authorized) throw new CompanionError('The companion did not recognise that token. Open the newest link `relay connect` printed.');
        } catch (caught) {
          const error = caught instanceof CompanionError ? caught : new CompanionError(`Nothing answered on 127.0.0.1:${port}. Is \`relay connect\` still running?`);
          set({ attempt: { state: 'failed', error: error.message, port, token } });
          throw error;
        }
        set({ pairing: { port, token, pairedAt: new Date().toISOString() }, status: 'connected', hello: answer, checkedAt: new Date().toISOString(), attempt: { state: 'idle' } });
        return answer;
      },

      forget: () => set({ pairing: null, status: 'unpaired', hello: null, checkedAt: null }),

      markHydrated: () => set({ hydrated: true, status: get().pairing === null ? 'unpaired' : 'connecting' }),

      refresh: async () => {
        const pairing = get().pairing;
        if (pairing === null) {
          set({ status: 'unpaired', hello: null });
          return;
        }
        if (get().status !== 'connected') set({ status: 'connecting' });
        try {
          const answer = await hello(pairing.port, pairing.token);
          set({ status: answer.authorized ? 'connected' : 'rejected', hello: answer.authorized ? answer : null, checkedAt: new Date().toISOString() });
        } catch {
          set({ status: 'unreachable', hello: null, checkedAt: new Date().toISOString() });
        }
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => (typeof window === 'undefined' ? (undefined as unknown as Storage) : window.localStorage)),
      partialize: (state) => ({ pairing: state.pairing }),
      // Through the state's own action: with synchronous storage this runs
      // while the store is still being created, before `useCompanion` exists.
      onRehydrateStorage: () => (state) => state?.markHydrated(),
    },
  ),
);

/** A call to the paired companion. Throws `CompanionError` with the companion's own message. */
export async function companionFetch<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await companionRequest(path, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new CompanionError(body.error ?? `The companion answered ${response.status}.`, response.status);
  return body;
}

/** The raw response, for the one route that streams. */
export async function companionRequest(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<Response> {
  const pairing = useCompanion.getState().pairing;
  if (pairing === null) throw new CompanionError('This studio is not paired with a machine. Run `relay connect`.');
  const headers: Record<string, string> = { authorization: `Bearer ${pairing.token}` };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  try {
    return await fetch(`${companionBase(pairing.port)}${path}`, {
      method: init.method ?? 'GET',
      headers,
      cache: 'no-store',
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    void useCompanion.getState().refresh();
    throw new CompanionError('Could not reach this machine. Is `relay connect` still running?');
  }
}

/** Whether the paired companion can do this, right now. */
export function useCompanionCan(capability: 'agents' | 'runs' | 'install'): boolean {
  return useCompanion((state) => state.status === 'connected' && (state.hello?.capabilities ?? []).includes(capability));
}

/** Parses the pairing link's fragment: `#port=4477&token=…`. */
export function readPairingFragment(hash: string): { port: number; token: string } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const port = Number(params.get('port'));
  const token = params.get('token') ?? '';
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || token.length < 16) return null;
  return { port, token };
}
