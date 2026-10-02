'use client';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { hubToken, onAccountForgotten } from '../cloud/sync';
import { DEFAULT_COMPANION_PORT, type CloudRunnerStatus, type CompanionRepository, type HelloResponse } from './types';

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
  /** Where the companion last answered from, so a stopped one can be started again in the right place. */
  machine?: string;
  repository?: CompanionRepository | null;
  platform?: string;
}

/**
 * `unpaired`: no pairing in this browser. `connecting`: asking. `connected`:
 * the companion answered and knows this studio. `unreachable`: nothing on the
 * paired port — usually `relay connect` is not running. `rejected`: something
 * answered but refused the token, which is what a rotated token looks like.
 * `blocked`: the browser will not let this page reach 127.0.0.1 at all (see
 * `LoopbackAccess`).
 */
export type CompanionStatus = 'unpaired' | 'connecting' | 'connected' | 'unreachable' | 'rejected' | 'blocked';

/**
 * Whether this browser lets the page reach 127.0.0.1. Chrome, Edge and Brave
 * ask the person first — "Local network access": a public site reaching a
 * service on their own computer needs a yes, once per site — and a request
 * made while the question is up waits for the answer. `unsupported`: a
 * browser that does not ask, or cannot say.
 */
export type LoopbackAccess = 'granted' | 'prompt' | 'denied' | 'unsupported';

/**
 * Why a pairing link did not pair. `blocked`: the browser has been told no.
 * `dismissed`: it asked, and the question was closed without a yes.
 * `unreachable`: allowed, and nothing answered. `rejected`: a companion
 * answered but did not know the token.
 */
export type PairingFailure = 'blocked' | 'dismissed' | 'unreachable' | 'rejected';

/** The version of the companion protocol this studio speaks. Mirrors `PROTOCOL_VERSION` in the engine. */
export const COMPANION_PROTOCOL = 1;

/**
 * The browser, when it is one that will not let a secure page reach a plain
 * `http://127.0.0.1` at all, whatever the person allows: Safari. Chrome, Edge
 * and Brave ask first; Firefox treats loopback as secure. Told apart so "relay
 * connect did not answer" is not what someone is told when it was never asked.
 */
export function loopbackBlockedBy(): string | null {
  if (typeof window === 'undefined' || window.location.protocol !== 'https:') return null;
  const agent = navigator.userAgent;
  const safari = /Safari\//.test(agent) && !/Chrom(e|ium)\/|Edg\/|OPR\/|Firefox\/|FxiOS|CriOS/.test(agent);
  return safari ? 'Safari' : null;
}

export class CompanionError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

/** A failed attempt keeps what the link carried, in memory only, so the page can try again without it. */
export type PairingAttempt = { state: 'idle' } | { state: 'pairing'; port: number } | { state: 'failed'; reason: PairingFailure; error: string; port: number; token: string };

interface CompanionStore {
  pairing: Pairing | null;
  target: RunnerTarget;
  /** The deployment's Relay Cloud hub, from its capabilities; null when it has none. */
  cloudHub: string | null;
  /** The cloud machine's own state, from the hub's last answer. */
  cloud: CloudRunnerStatus | null;
  status: CompanionStatus;
  /** Why the status is what it is, when the status alone does not say: a version mismatch, a browser that cannot reach loopback. */
  notice: string | null;
  hello: HelloResponse | null;
  checkedAt: string | null;
  hydrated: boolean;
  /** The browser's answer on reaching 127.0.0.1, kept current while the page is open. */
  access: LoopbackAccess;
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

/**
 * How long a check waits for the companion. Refused connections fail at once
 * whatever this is; the wait only matters while the browser is asking the
 * person whether this page may reach their machine, and that answer can take
 * as long as reading the question does.
 */
const QUICK_TIMEOUT_MS = 5_000;
const ASKING_TIMEOUT_MS = 120_000;

/**
 * With nothing listening a request can fail within milliseconds and leave the
 * permission unanswered, which is not the person saying no. A failure that
 * took longer than a person takes to read the question is the question being
 * closed without a yes.
 */
const HUMAN_ANSWER_MS = 1_500;

let accessStatus: PermissionStatus | null = null;

/**
 * Reads the browser's loopback permission and follows it. Chrome names it
 * `loopback-network` now and `local-network-access` before that; a browser
 * that knows neither never asks. A studio served from this machine itself
 * (`localhost:3000`) is already on the loopback side and is never asked.
 */
async function readAccess(): Promise<LoopbackAccess> {
  const onLoopback = typeof window !== 'undefined' && ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
  if (accessStatus === null && !onLoopback && typeof navigator !== 'undefined' && navigator.permissions !== undefined) {
    for (const name of ['loopback-network', 'local-network-access']) {
      try {
        accessStatus = await navigator.permissions.query({ name: name as PermissionName });
        accessStatus.addEventListener('change', onAccessChange);
        break;
      } catch {
        // Not a permission this browser knows; try the older name.
      }
    }
  }
  const access: LoopbackAccess = accessStatus === null ? 'unsupported' : (accessStatus.state as LoopbackAccess);
  if (useCompanion.getState().access !== access) useCompanion.setState({ access });
  return access;
}

/** Allowing access in the site settings pairs a link that was blocked, and reconnects a paired studio, without a click. */
function onAccessChange(): void {
  void readAccess().then((access) => {
    if (access !== 'granted') return;
    const state = useCompanion.getState();
    if (state.attempt.state === 'failed') void state.pair(state.attempt.port, state.attempt.token).catch(() => undefined);
    else if (state.pairing !== null) void state.refresh();
  });
}

function timeoutFor(access: LoopbackAccess): number {
  return access === 'granted' || access === 'unsupported' ? QUICK_TIMEOUT_MS : ASKING_TIMEOUT_MS;
}

/** Where the companion last answered from, remembered alongside the pairing. */
function remembered(pairing: Pairing, answer: HelloResponse): Pairing {
  return { ...pairing, machine: answer.machine ?? pairing.machine, repository: answer.repository ?? null, platform: answer.platform ?? pairing.platform };
}

export function companionBase(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** Where a request goes and with what, for either kind of runner. */
async function endpoint(runner: RunnerTarget): Promise<{ base: string; headers: Record<string, string> }> {
  const state = useCompanion.getState();
  if (runner === 'cloud') {
    if (state.cloudHub === null) throw new CompanionError('This studio has no Relay Cloud.');
    const token = await hubToken();
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

async function hello(port: number, token: string, timeoutMs: number): Promise<HelloResponse> {
  const response = await fetch(`${companionBase(port)}/v1/hello`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new CompanionError(`The companion answered ${response.status}.`, response.status);
  const body = (await response.json()) as HelloResponse;
  if (body.product !== 'relay') throw new CompanionError('Something else is listening on that port.');
  // The protocol number changes only when a field is removed or changes
  // meaning, so a different one is a pair that would misunderstand each other.
  if (typeof body.protocol === 'number' && body.protocol !== COMPANION_PROTOCOL) {
    throw new CompanionError(
      body.protocol > COMPANION_PROTOCOL
        ? `relay connect is newer than this studio (protocol ${body.protocol}, this page speaks ${COMPANION_PROTOCOL}). Reload the page to get the current studio.`
        : `relay connect is older than this studio (protocol ${body.protocol}, this page speaks ${COMPANION_PROTOCOL}). Update the Relay CLI and start it again.`,
      426,
    );
  }
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
      notice: null,
      hello: null,
      checkedAt: null,
      hydrated: false,
      access: 'unsupported',
      attempt: { state: 'idle' },

      pair: async (port, token) => {
        set({ attempt: { state: 'pairing', port } });
        const started = Date.now();
        let answer: HelloResponse;
        try {
          // A browser that has not been asked yet asks now, and this waits for the answer.
          if ((await readAccess()) === 'denied') throw new CompanionError(BLOCKED);
          answer = await hello(port, token, ASKING_TIMEOUT_MS);
          if (!answer.authorized) throw new CompanionError('relay connect is running, but did not recognise this link. Open the newest link it printed.', 401);
        } catch (caught) {
          const access = await readAccess();
          const reason: PairingFailure =
            caught instanceof CompanionError && caught.status !== null
              ? 'rejected'
              : access === 'denied'
                ? 'blocked'
                : access === 'prompt' && Date.now() - started >= HUMAN_ANSWER_MS
                  ? 'dismissed'
                  : 'unreachable';
          const message =
            reason === 'rejected'
              ? (caught as CompanionError).message
              : reason === 'blocked'
                ? BLOCKED
                : reason === 'dismissed'
                  ? 'Your browser asked whether this site may reach apps on your device, and it was not allowed.'
                  : loopbackBlockedBy() !== null
                    ? `${loopbackBlockedBy()} does not let this site reach relay connect on your computer, so it was never asked. Open this link in Chrome, Edge or Firefox${get().cloudHub === null ? '' : ', or use Relay Cloud, which needs no connection to your computer'}.`
                    : `Nothing answered on 127.0.0.1:${port}.`;
          set({ attempt: { state: 'failed', reason, error: message, port, token } });
          throw new CompanionError(message);
        }
        // Pairing a machine is choosing it: sign-ins and runs go there from now on.
        const pairing = remembered({ port, token, pairedAt: new Date().toISOString() }, answer);
        set({ pairing, target: 'machine', status: 'connected', notice: null, hello: answer, checkedAt: new Date().toISOString(), attempt: { state: 'idle' } });
        return answer;
      },

      forget: () => set(get().target === 'machine' ? { pairing: null, status: 'unpaired', hello: null, checkedAt: null } : { pairing: null }),

      markHydrated: () => {
        set({ hydrated: true, status: get().target === 'cloud' || get().pairing !== null ? 'connecting' : 'unpaired' });
        // After the store exists: this can run while it is still being created.
        queueMicrotask(() => void readAccess());
      },

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
          const token = hub === null ? null : await hubToken();
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
        const access = await readAccess();
        if (access === 'denied') {
          set({ status: 'blocked', hello: null, checkedAt: new Date().toISOString() });
          return;
        }
        try {
          const answer = await hello(pairing.port, pairing.token, timeoutFor(access));
          const current = get().pairing;
          set({
            status: answer.authorized ? 'connected' : 'rejected',
            notice: null,
            hello: answer.authorized ? answer : null,
            checkedAt: new Date().toISOString(),
            // Only the pairing this answer was for; a new link may have replaced it meanwhile.
            ...(answer.authorized && current !== null && current.token === pairing.token && current.port === pairing.port ? { pairing: remembered(current, answer) } : {}),
          });
        } catch (error) {
          // Something answered, and it cannot be used: say what it said, rather than "not running".
          if (error instanceof CompanionError && error.status === 426) {
            set({ status: 'rejected', notice: error.message, hello: null, checkedAt: new Date().toISOString() });
            return;
          }
          const blocker = loopbackBlockedBy();
          set({
            status: (await readAccess()) === 'denied' ? 'blocked' : 'unreachable',
            notice: blocker === null ? null : `${blocker} does not let this site reach relay connect on your computer. Use Chrome, Edge or Firefox here.`,
            hello: null,
            checkedAt: new Date().toISOString(),
          });
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

// The pairing is this browser's key to somebody's machine. It goes when the
// account does: signing out on a shared computer must not leave it behind.
onAccountForgotten(() => {
  useCompanion.setState({ pairing: null, target: 'machine', status: 'unpaired', notice: null, hello: null, cloud: null, checkedAt: null, attempt: { state: 'idle' } });
});

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
    if (runner === 'cloud') throw new CompanionError('Could not reach Relay Cloud. Check your connection and try again.');
    throw new CompanionError((await readAccess()) === 'denied' ? BLOCKED : 'Could not reach this machine. Is `relay connect` still running?');
  }
}

/** Whether the current runner can do this, right now. */
export function useCompanionCan(capability: 'agents' | 'runs' | 'install' | 'repositories' | 'github'): boolean {
  return useCompanion((state) => state.status === 'connected' && (state.hello?.capabilities ?? []).includes(capability));
}

const BLOCKED = 'Your browser is not letting this site reach relay connect on your computer.';

/**
 * The command that starts the companion again where it last ran: in the
 * repository it served, which is where runs and installs go.
 */
export function restartCommand(pairing: Pairing | null): string {
  // The studio looks on the paired port, so the companion has to come back on it.
  const connect = pairing === null || pairing.port === DEFAULT_COMPANION_PORT ? 'relay connect' : `relay connect --port ${pairing.port}`;
  const root = pairing?.repository?.root;
  if (root === undefined || pairing?.platform === 'win32') return connect;
  return `cd ${/^[\w@%+=:,./-]+$/.test(root) ? root : `'${root.replace(/'/g, `'\\''`)}'`} && ${connect}`;
}

/** Parses the pairing link's fragment: `#port=4477&token=…`. */
export function readPairingFragment(hash: string): { port: number; token: string } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const port = Number(params.get('port'));
  const token = params.get('token') ?? '';
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || token.length < 16) return null;
  return { port, token };
}

const PENDING_PAIRING = 'relay:pending-pairing';

/**
 * A pairing link opened while signed out arrives at the sign-in page with
 * its fragment. Held in this tab's session storage — still never sent
 * anywhere — and out of the address bar, until `/connect` takes it.
 */
export function stashPairing(): void {
  if (readPairingFragment(window.location.hash) === null) return;
  try {
    window.sessionStorage.setItem(PENDING_PAIRING, window.location.hash);
  } catch {
    // Storage refused: the link can simply be opened again once signed in.
  }
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
}

/** The pairing link held by `stashPairing`, once. */
export function takeStashedPairing(): { port: number; token: string } | null {
  try {
    const hash = window.sessionStorage.getItem(PENDING_PAIRING);
    window.sessionStorage.removeItem(PENDING_PAIRING);
    return hash === null ? null : readPairingFragment(hash);
  } catch {
    return null;
  }
}
