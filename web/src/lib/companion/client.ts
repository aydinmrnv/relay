'use client';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { sessionToken } from '../cloud/sync';
import type { CloudRunnerStatus, HelloResponse } from './types';

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
 *
 * The same client reaches a signed-in person's **Relay Cloud** machine, when
 * the deployment has a hub: the same protocol, at the hub's address, with
 * the person's Clerk session token where the pairing token would be. Which
 * of the two the studio uses is `target`; each machine run remembers its own.
 */

/** Where sign-ins and runs go: the machine paired with `relay connect`, or the person's Relay Cloud machine. */
export type RunnerTarget = 'machine' | 'cloud';

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
  target: RunnerTarget;
  /** The deployment's Relay Cloud hub, from its capabilities; null when it has none. */
  cloudHub: string | null;
  /** The cloud machine's own state, from the hub's last answer. */
  cloud: CloudRunnerStatus | null;
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
  setTarget: (target: RunnerTarget) => void;
  setCloudHub: (url: string | null) => void;
  /** Asks the hub to wake, put to sleep, or remove the person's cloud machine. */
  cloudAction: (action: 'wake' | 'sleep' | 'remove') => Promise<CloudRunnerStatus>;
}

const STORAGE_KEY = 'relay-companion';

export function companionBase(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** Where a request goes and with what, for either kind of runner. */
async function endpoint(runner: RunnerTarget): Promise<{ base: string; headers: Record<string, string> }> {
  const state = useCompanion.getState();
  if (runner === 'cloud') {
    if (state.cloudHub === null) throw new CompanionError('This studio has no Relay Cloud.');
    const token = await sessionToken();
    if (token === null) throw new CompanionError('Sign in to use Relay Cloud.');
    return { base: state.cloudHub, headers: { authorization: `Bearer ${token}` } };
  }
  if (state.pairing === null) throw new CompanionError('This studio is not paired with a machine. Run `relay connect`.');
  return { base: companionBase(state.pairing.port), headers: { authorization: `Bearer ${state.pairing.token}` } };
}

async function cloudHello(hub: string, token: string): Promise<HelloResponse> {
  const response = await fetch(`${hub}/v1/hello`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(8000) });
  const body = (await response.json().catch(() => ({}))) as HelloResponse & { error?: string };
  if (!response.ok) throw new CompanionError(body.error ?? `Relay Cloud answered ${response.status}.`, response.status);
  return body;
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
      target: 'machine',
      cloudHub: null,
      cloud: null,
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
        // Pairing a machine is choosing it: sign-ins and runs go there from now on.
        set({ pairing: { port, token, pairedAt: new Date().toISOString() }, target: 'machine', status: 'connected', hello: answer, checkedAt: new Date().toISOString(), attempt: { state: 'idle' } });
        return answer;
      },

      forget: () => set(get().target === 'machine' ? { pairing: null, status: 'unpaired', hello: null, checkedAt: null } : { pairing: null }),

      markHydrated: () => set({ hydrated: true, status: get().target === 'cloud' || get().pairing !== null ? 'connecting' : 'unpaired' }),

      setTarget: (target) => {
        if (target === get().target) return;
        set({ target, status: 'connecting', hello: null, checkedAt: null });
        void get().refresh();
      },

      setCloudHub: (url) => {
        if (url === get().cloudHub) return;
        set({ cloudHub: url });
        if (get().target === 'cloud') void get().refresh();
      },

      cloudAction: async (action) => {
        const { base, headers } = await endpoint('cloud');
        const response = await fetch(`${base}/cloud/v1/runner${action === 'remove' ? '' : `/${action}`}`, { method: action === 'remove' ? 'DELETE' : 'POST', headers, cache: 'no-store' });
        const body = (await response.json().catch(() => ({}))) as CloudRunnerStatus & { error?: string };
        if (!response.ok && typeof body.state !== 'string') throw new CompanionError(body.error ?? `Relay Cloud answered ${response.status}.`, response.status);
        set({ cloud: body });
        void get().refresh();
        return body;
      },

      refresh: async () => {
        if (get().target === 'cloud') {
          const hub = get().cloudHub;
          const token = hub === null ? null : await sessionToken();
          if (hub === null || token === null) {
            set({ status: 'unpaired', hello: null, cloud: null, checkedAt: new Date().toISOString() });
            return;
          }
          if (get().status !== 'connected') set({ status: 'connecting' });
          try {
            const answer = await cloudHello(hub, token);
            // The hub answers for an asleep machine too; only a connected one can do anything.
            const ready = answer.cloud?.state === 'ready' && (answer.capabilities?.length ?? 0) > 0;
            // The VM's own hostname means nothing to the person; every screen names it Relay Cloud.
            set({ status: ready ? 'connected' : 'unreachable', hello: { ...answer, machine: 'Relay Cloud' }, cloud: answer.cloud ?? null, checkedAt: new Date().toISOString() });
          } catch (error) {
            const refused = error instanceof CompanionError && (error.status === 401 || error.status === 403);
            set({ status: refused ? 'rejected' : 'unreachable', hello: null, checkedAt: new Date().toISOString() });
          }
          return;
        }
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
      partialize: (state) => ({ pairing: state.pairing, target: state.target }),
      // Through the state's own action: with synchronous storage this runs
      // while the store is still being created, before `useCompanion` exists.
      onRehydrateStorage: () => (state) => state?.markHydrated(),
    },
  ),
);

export interface CompanionRequestInit {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Which runner; the studio's current target when absent. A run keeps asking the runner it started on. */
  runner?: RunnerTarget;
}

/** A call to the runner. Throws `CompanionError` with the runner's own message. */
export async function companionFetch<T>(path: string, init: CompanionRequestInit = {}): Promise<T> {
  const response = await companionRequest(path, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new CompanionError(body.error ?? `The companion answered ${response.status}.`, response.status);
  return body;
}

/** The raw response, for the one route that streams. */
export async function companionRequest(path: string, init: CompanionRequestInit = {}): Promise<Response> {
  const runner = init.runner ?? useCompanion.getState().target;
  const { base, headers } = await endpoint(runner);
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  try {
    return await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers,
      cache: 'no-store',
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    void useCompanion.getState().refresh();
    throw new CompanionError(runner === 'cloud' ? 'Could not reach Relay Cloud. Check your connection and try again.' : 'Could not reach this machine. Is `relay connect` still running?');
  }
}

/** Whether the current runner can do this, right now. */
export function useCompanionCan(capability: 'agents' | 'runs' | 'install' | 'repositories' | 'github'): boolean {
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
