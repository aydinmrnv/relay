'use client';

/**
 * Keeps a signed-in person's studio and their account in step.
 *
 * The zustand store stays the one thing every screen reads. Signing in
 * replaces its contents with the account's; after that, every change to a
 * workflow, a finished run or the settings is noticed by diffing the store
 * against its previous state, queued, and sent a moment later — coalesced,
 * so dragging a node for five seconds is one request, not three hundred.
 *
 * The queue is written to localStorage and an item leaves it only once the
 * server has confirmed it, so a change made offline, or still in flight when
 * the tab closed, is sent on the next load instead of being lost. A change the
 * server refuses on its merits (too large, an account that is full) stays in
 * the queue too, marked as refused: it is not sent again until it changes,
 * the indicator says it is not saved, and a reload keeps this browser's copy.
 *
 * Every workflow save names the server revision it was based on. If another
 * tab or device saved in between, the server refuses and hands back its
 * copy; this browser keeps both — the server's under the original name, its
 * own as a "conflicted copy" — so nothing anyone did is silently replaced.
 *
 * Every request also names whose workspace it carries. If another tab has
 * signed in as someone else meanwhile, the server refuses rather than save
 * one person's work into another's account.
 */
import { nanoid } from 'nanoid';
import { create } from 'zustand';
import { toast } from 'sonner';
import { MAX_RUN_EVENTS, useStudio, type StudioState } from '@/lib/store';
import { DEFAULT_SETTINGS, type Connection, type Run, type Settings, type Workflow } from '@/lib/workflow/schema';
import { useAccount } from './account';
import type { AccountUser, AuthCapabilities, OnboardingAnswers } from './types';
import { withLocalSecrets, withoutSecrets } from './secrets';

/* ------------------------------------------------------------------ */
/* Talking to the server                                               */
/* ------------------------------------------------------------------ */

export class CloudError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/**
 * Clerk's session cookie lives a minute and is refreshed in the background;
 * a tab that slept can wake with a stale one. So requests carry a token
 * straight from Clerk, which refreshes it when needed.
 */
let tokenGetter: ((options?: { template?: string }) => Promise<string | null>) | null = null;

export function setTokenGetter(getter: ((options?: { template?: string }) => Promise<string | null>) | null): void {
  tokenGetter = getter;
}

/** A fresh Clerk session token, or null for a guest. */
export async function sessionToken(): Promise<string | null> {
  if (tokenGetter === null) return null;
  try {
    return await tokenGetter();
  } catch {
    return null;
  }
}

/**
 * The token the Relay Cloud hub is given. When the deployment names a Clerk
 * JWT template for it, that: a token the studio's own API does not accept, so
 * a hub that misbehaves cannot replay what it was handed to save or delete in
 * the person's account. Without one, the session token, as before.
 */
export async function hubToken(): Promise<string | null> {
  const template = useAccount.getState().capabilities.cloudTokenTemplate;
  if (tokenGetter === null) return null;
  try {
    return await tokenGetter(typeof template === 'string' && template.length > 0 ? { template } : undefined);
  } catch {
    return null;
  }
}

async function authorization(): Promise<Record<string, string>> {
  if (tokenGetter === null) return {};
  try {
    const token = await tokenGetter();
    return token === null ? {} : { authorization: `Bearer ${token}` };
  } catch {
    return {};
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; keepalive?: boolean; headers?: Record<string, string> } = {}): Promise<T> {
  let response: Response;
  // Unload requests cannot wait for a token; they go with the cookie.
  const auth = init.keepalive === true ? {} : await authorization();
  try {
    response = await fetch(path, {
      method: init.method ?? 'GET',
      headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...auth, ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      keepalive: init.keepalive,
      cache: 'no-store',
    });
  } catch {
    throw new CloudError(0, 'OFFLINE', 'Could not reach the server. Check your connection.');
  }
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const body = (data ?? {}) as Record<string, unknown> & { code?: string; message?: string };
    throw new CloudError(response.status, body.code ?? `HTTP_${response.status}`, body.message ?? `The server answered ${response.status}.`, body);
  }
  return data as T;
}

/* ------------------------------------------------------------------ */
/* Save status, for the indicators                                     */
/* ------------------------------------------------------------------ */

export type SyncState = 'idle' | 'saving' | 'saved' | 'offline' | 'error';

export const useSyncStatus = create<{ state: SyncState; lastSavedAt: number | null; message: string | null; pendingCount: number }>()(() => ({
  state: 'idle',
  lastSavedAt: null,
  message: null,
  pendingCount: 0,
}));

/* ------------------------------------------------------------------ */
/* The queue                                                            */
/* ------------------------------------------------------------------ */

type Op = 'put' | 'delete';

interface Pending {
  owner: string;
  workflows: Record<string, Op>;
  runs: Record<string, Op>;
  workspace: boolean;
  clearRuns: boolean;
  /** Workflow id → the server revision this browser's copy is based on. Absent: never saved. */
  revisions: Record<string, string>;
  /**
   * Queue entries (`w:<id>`, `r:<id>`, `ws`) the server refused on their
   * merits, with why. They stay queued so a reload keeps this browser's copy,
   * and are not sent again until the thing changes.
   */
  rejected: Record<string, string>;
}

const PENDING_KEY = 'relay-cloud-pending';
const UNSENT_KEY = 'relay-cloud-unsent';
const GUEST_BACKUP_KEY = 'relay-guest-backup';
const TAB_KEY = 'relay-tab';

/**
 * Each tab keeps its own queue, under its own key. With one key for all of
 * them, two tabs of the same account wrote over each other's queues, and a
 * change waiting in one could be dropped by the other finishing first.
 *
 * The id lives in session storage, so a reload finds the queue it left. A
 * tab that is gone leaves its queue behind; the next load of this account
 * takes it over (see `collectPending`), having checked that the tab really
 * is gone — every tab holds a Web Lock named after its id for as long as it
 * is open, so a lock that can be taken is a tab that closed.
 */
const TAB_ID: string = (() => {
  if (typeof window === 'undefined') return 'server';
  try {
    const existing = window.sessionStorage.getItem(TAB_KEY);
    if (existing !== null && /^[A-Za-z0-9_-]{6,40}$/.test(existing)) return existing;
    const made = nanoid(12);
    window.sessionStorage.setItem(TAB_KEY, made);
    return made;
  } catch {
    return nanoid(12);
  }
})();

if (typeof navigator !== 'undefined' && navigator.locks !== undefined) {
  // Held until the tab goes away: the promise never settles.
  void navigator.locks.request(`${PENDING_KEY}:${TAB_ID}`, () => new Promise<void>(() => undefined)).catch(() => undefined);
}

function pendingKey(tab = TAB_ID): string {
  return `${PENDING_KEY}:${tab}`;
}

function emptyPending(owner: string): Pending {
  return { owner, workflows: {}, runs: {}, workspace: false, clearRuns: false, revisions: {}, rejected: {} };
}

function countPending(pending: Pending): number {
  return Object.keys(pending.workflows).length + Object.keys(pending.runs).length + (pending.workspace ? 1 : 0) + (pending.clearRuns ? 1 : 0);
}

function parsePending(raw: string | null, owner: string): Pending | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Pending>;
    return parsed.owner === owner ? { ...emptyPending(owner), ...parsed, owner } : null;
  } catch {
    return null;
  }
}

/** This tab's own queue. */
function readPending(owner: string): Pending {
  try {
    return parsePending(window.localStorage.getItem(pendingKey()), owner) ?? emptyPending(owner);
  } catch {
    return emptyPending(owner);
  }
}

function writePending(pending: Pending): void {
  const count = countPending(pending);
  useSyncStatus.setState({ pendingCount: count });
  try {
    // Kept even when nothing is queued: the revisions are what tell a save
    // made after an offline start which copy it was based on. Without them
    // every such save looks like a conflict.
    if (count === 0 && Object.keys(pending.revisions).length === 0) window.localStorage.removeItem(pendingKey());
    else window.localStorage.setItem(pendingKey(), JSON.stringify(pending));
  } catch {
    // Storage full or unavailable: the in-memory queue still gets sent.
  }
}

/** Whether the tab that owns a queue is gone. Without Web Locks nobody can say, so the answer is no. */
async function tabIsGone(tab: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || navigator.locks === undefined) return false;
  try {
    return await navigator.locks.request(`${PENDING_KEY}:${tab}`, { ifAvailable: true }, async (lock) => lock !== null);
  } catch {
    return false;
  }
}

/**
 * Everything queued for this account that this tab may send: its own queue,
 * the queue from before tabs had their own, and the queues of tabs that have
 * closed. Only called on a load, when the store has just been read from
 * localStorage and so holds the copies those queues are about.
 */
async function collectPending(owner: string): Promise<Pending> {
  const mine = readPending(owner);
  let keys: string[] = [];
  try {
    keys = Object.keys(window.localStorage).filter((key) => key === PENDING_KEY || (key.startsWith(`${PENDING_KEY}:`) && key !== pendingKey()));
  } catch {
    return mine;
  }
  for (const key of keys) {
    const tab = key === PENDING_KEY ? null : key.slice(PENDING_KEY.length + 1);
    if (tab !== null && !(await tabIsGone(tab))) continue;
    let theirs: Pending | null = null;
    try {
      theirs = parsePending(window.localStorage.getItem(key), owner);
      // Another account's leftovers are not this one's to send, and not worth keeping.
      window.localStorage.removeItem(key);
    } catch {
      continue;
    }
    if (theirs === null) continue;
    // What this tab has queued itself is newer; theirs fills in the rest.
    mine.workflows = { ...theirs.workflows, ...mine.workflows };
    mine.runs = { ...theirs.runs, ...mine.runs };
    mine.workspace = mine.workspace || theirs.workspace;
    mine.clearRuns = mine.clearRuns || theirs.clearRuns;
    mine.revisions = { ...theirs.revisions, ...mine.revisions };
    mine.rejected = { ...theirs.rejected, ...mine.rejected };
  }
  return mine;
}

/** A test run is worth keeping once it has finished; a run on a real machine, from its first line. */
function syncable(run: Run): boolean {
  return run.status !== 'running' || run.source === 'machine';
}

/** What the server accepts for one run, with room to spare for the headers. */
const RUN_SEND_BYTES = 550_000;

/**
 * A run that fits what the server takes. The limit there is in bytes, and a
 * run's size is mostly its log, so the oldest events go first, half at a
 * time, until it fits: the end of a run is what says how it went.
 */
function fitRun(run: Run): Run {
  let fitted = run.events.length > MAX_RUN_EVENTS ? { ...run, events: run.events.slice(-MAX_RUN_EVENTS) } : run;
  while (fitted.events.length > 20 && new Blob([JSON.stringify(fitted)]).size > RUN_SEND_BYTES) {
    fitted = { ...fitted, events: fitted.events.slice(-Math.ceil(fitted.events.length / 2)) };
  }
  return fitted;
}

function workspaceBody(state: StudioState) {
  return { settings: state.settings, connections: state.connections, toursSeen: state.toursSeen, checklistDismissed: state.checklistDismissed };
}

/* ------------------------------------------------------------------ */
/* The engine                                                           */
/* ------------------------------------------------------------------ */

const QUIET_MS = 900;
const MAX_WAIT_MS = 4000;
const CONCURRENCY = 4;
/** After a failure: 3s, then double each time, up to this. An outage is not shortened by asking more often. */
const MAX_RETRY_MS = 60_000;

interface Task {
  /** Which queue entry this settles: `w:<id>`, `r:<id>`, `ws` or `clear`. */
  key: string;
  label: string;
  /** A save, whose content only this browser has: kept in the queue if the server refuses it. A delete is not. */
  keeps: boolean;
  run: () => Promise<void>;
}

class SyncEngine {
  private readonly pending: Pending;
  /** Bumped every time a queue entry is (re)marked, so a reply only settles the version it carried. */
  private seq = 0;
  private readonly marks = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstDirtyAt = 0;
  private flushing: Promise<void> | null = null;
  private again = false;
  private retryMs = 0;
  /** Until when a failed send is being waited out. */
  private retryUntil = 0;
  /** Signed out underneath us: keep recording changes, send nothing until someone signs in again. */
  private paused = false;
  private stopped = false;
  private readonly unsubscribe: () => void;

  constructor(
    readonly owner: string,
    pending: Pending,
  ) {
    this.pending = pending;
    for (const id of Object.keys(pending.workflows)) this.marks.set(`w:${id}`, ++this.seq);
    for (const id of Object.keys(pending.runs)) this.marks.set(`r:${id}`, ++this.seq);
    if (pending.workspace) this.marks.set('ws', ++this.seq);
    if (pending.clearRuns) this.marks.set('clear', ++this.seq);
    this.unsubscribe = useStudio.subscribe((state, prev) => this.onChange(state, prev));
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('online', this.onOnline);
    writePending(this.pending);
    if (countPending(this.pending) > 0) this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe();
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('online', this.onOnline);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  pause(): void {
    this.paused = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Workflows and runs the server already has as they are here (an import): record their revisions, send nothing. */
  adopt(revisions: Record<string, string>, runIds: string[]): void {
    for (const [id, revision] of Object.entries(revisions)) {
      this.pending.revisions[id] = revision;
      delete this.pending.workflows[id];
      this.marks.delete(`w:${id}`);
    }
    for (const id of runIds) {
      delete this.pending.runs[id];
      this.marks.delete(`r:${id}`);
    }
    writePending(this.pending);
  }

  markRun(id: string): void {
    this.mark(`r:${id}`, () => (this.pending.runs[id] = 'put'));
    writePending(this.pending);
    this.schedule();
  }

  private mark(key: string, apply: () => void): void {
    apply();
    this.marks.set(key, ++this.seq);
    // It changed, so what the server refused before is worth offering again.
    delete this.pending.rejected[key];
  }

  /** Settle a queue entry — unless it was marked again after the request carrying it left. */
  private settle(key: string, sentSeq: number | undefined): void {
    if (this.marks.get(key) !== sentSeq) return;
    this.marks.delete(key);
    delete this.pending.rejected[key];
    if (key === 'ws') this.pending.workspace = false;
    else if (key === 'clear') this.pending.clearRuns = false;
    else if (key.startsWith('w:')) delete this.pending.workflows[key.slice(2)];
    else if (key.startsWith('r:')) delete this.pending.runs[key.slice(2)];
  }

  private onChange(state: StudioState, prev: StudioState): void {
    if (this.stopped || state.owner !== this.owner || prev.owner !== this.owner) return;
    const pending = this.pending;
    let changed = false;

    if (state.workflows !== prev.workflows) {
      for (const [id, workflow] of Object.entries(state.workflows)) {
        if (prev.workflows[id] !== workflow) {
          this.mark(`w:${id}`, () => (pending.workflows[id] = 'put'));
          changed = true;
        }
      }
      for (const id of Object.keys(prev.workflows)) {
        if (state.workflows[id] === undefined) {
          this.mark(`w:${id}`, () => (pending.workflows[id] = 'delete'));
          changed = true;
        }
      }
    }

    if (state.runsClearedAt !== prev.runsClearedAt) {
      // "Clear run history": one request, and nothing queued about single runs is still needed.
      for (const id of Object.keys(pending.runs)) this.marks.delete(`r:${id}`);
      pending.runs = {};
      this.mark('clear', () => (pending.clearRuns = true));
      changed = true;
    } else if (state.runs !== prev.runs) {
      const before = new Map(prev.runs.map((run) => [run.id, run]));
      const now = new Set<string>();
      for (const run of state.runs) {
        now.add(run.id);
        if (before.get(run.id) !== run && syncable(run)) {
          this.mark(`r:${run.id}`, () => (pending.runs[run.id] = 'put'));
          changed = true;
        }
      }
      for (const run of prev.runs) {
        // Deleting a workflow deletes its runs on the server too. And a run
        // this browser dropped to stay under its cap was not deleted by anyone:
        // the account keeps it until its own limit says otherwise.
        if (!now.has(run.id) && pending.workflows[run.workflowId] !== 'delete' && !state.trimmedRuns.has(run.id)) {
          this.mark(`r:${run.id}`, () => (pending.runs[run.id] = 'delete'));
          changed = true;
        }
      }
    }

    if (
      state.settings !== prev.settings ||
      state.connections !== prev.connections ||
      state.toursSeen !== prev.toursSeen ||
      state.checklistDismissed !== prev.checklistDismissed
    ) {
      this.mark('ws', () => (pending.workspace = true));
      changed = true;
    }

    if (changed) {
      writePending(pending);
      this.schedule();
    }
  }

  /**
   * `retry`: waiting out a failure. That wait is the backoff and nothing may
   * shorten it — not the "at most four seconds after the first change" rule
   * that keeps a long drag from never saving, and not another change arriving
   * meanwhile, or every tab would ask a struggling server again within seconds.
   */
  private schedule(delay = QUIET_MS, retry = false): void {
    if (this.paused || this.stopped) return;
    const now = Date.now();
    if (retry) {
      if (this.timer !== null) clearTimeout(this.timer);
      this.retryUntil = now + delay;
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, delay);
      return;
    }
    if (this.timer === null) this.firstDirtyAt = now;
    else clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(delay, this.firstDirtyAt + MAX_WAIT_MS - now), this.retryUntil - now);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, wait);
  }

  async flush(): Promise<void> {
    if (this.paused || this.stopped) return;
    if (this.flushing !== null) {
      this.again = true;
      return this.flushing;
    }
    this.flushing = this.send().finally(() => {
      this.flushing = null;
      if (this.again && !this.stopped) {
        this.again = false;
        this.schedule(0);
      }
    });
    return this.flushing;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { 'x-relay-user': this.owner, ...extra };
  }

  private async send(): Promise<void> {
    const sent = new Map(this.marks);
    const tasks = this.tasks(useStudio.getState());
    if (tasks.length === 0) return;

    // While retrying after a failure the indicator keeps saying so, rather than flicking to "Saving…" and back every attempt.
    if (this.retryMs === 0) useSyncStatus.setState({ state: 'saving', message: null });
    const failed: Array<{ task: Task; error: CloudError }> = [];
    let index = 0;
    const worker = async () => {
      while (index < tasks.length && !this.stopped) {
        const task = tasks[index]!;
        index += 1;
        try {
          await task.run();
          this.settle(task.key, sent.get(task.key));
        } catch (error) {
          failed.push({ task, error: error instanceof CloudError ? error : new CloudError(500, 'UNKNOWN', String(error)) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));
    if (this.stopped) return;

    if (failed.some((entry) => entry.error.code === 'USER_MISMATCH')) {
      writePending(this.pending);
      await accountSwitched(this.owner);
      return;
    }
    if (failed.some((entry) => entry.error.status === 401)) {
      writePending(this.pending);
      sessionExpired();
      return;
    }

    for (const entry of failed) {
      if (entry.error.code === 'CONFLICT' && entry.task.key.startsWith('w:')) {
        this.resolveConflict(entry.task.key.slice(2), entry.error.data);
        this.settle(entry.task.key, sent.get(entry.task.key));
      }
    }
    // A request the server rejected on its merits will be rejected again, so
    // it is not sent again; but it is not forgotten either. A refused delete
    // has nothing left to keep. A refused save stays in the queue, marked, so
    // the indicator goes on saying it is not saved and a reload keeps this
    // browser's copy rather than replacing it with the server's older one.
    // Anything else — offline, a 5xx, a rate limit — is simply tried again.
    const rest = failed.filter((entry) => entry.error.code !== 'CONFLICT');
    const permanent = rest.filter((entry) => entry.error.status >= 400 && entry.error.status < 500 && entry.error.status !== 408 && entry.error.status !== 429);
    for (const entry of permanent) {
      const key = entry.task.key;
      if (sent.get(key) !== this.marks.get(key)) continue;
      if (entry.task.keeps) this.pending.rejected[key] = entry.error.message;
      else this.settle(key, sent.get(key));
    }
    const transient = rest.filter((entry) => !permanent.includes(entry));
    writePending(this.pending);

    if (permanent.length > 0) {
      const first = permanent[0]!;
      toast.error(`Could not save ${first.task.label} to your account`, { description: first.task.keeps ? `${first.error.message} It is kept in this browser until it can be saved.` : first.error.message, duration: 12_000 });
    }
    const refused = Object.values(this.pending.rejected);
    if (transient.length > 0) {
      const offline = transient.every((entry) => entry.error.status === 0);
      const limited = transient.find((entry) => entry.error.status === 429)?.error.data['retryAfter'];
      this.retryMs = Math.min(MAX_RETRY_MS, this.retryMs === 0 ? 3000 : this.retryMs * 2);
      useSyncStatus.setState({
        state: offline ? 'offline' : 'error',
        message: offline ? 'Offline. Changes are kept in this browser and sent when you are back.' : `${transient[0]!.error.message} Changes are kept in this browser and sent again shortly.`,
      });
      this.schedule(typeof limited === 'number' ? Math.max(this.retryMs, limited * 1000) : this.retryMs, true);
    } else if (refused.length > 0) {
      this.retryMs = 0;
      this.retryUntil = 0;
      useSyncStatus.setState({ state: 'error', message: `${refused.length === 1 ? 'One change is' : `${refused.length} changes are`} not saved to your account: ${refused[0]} Kept in this browser.` });
    } else {
      this.retryMs = 0;
      this.retryUntil = 0;
      useSyncStatus.setState({ state: 'saved', lastSavedAt: Date.now(), message: null });
    }
  }

  /** How many queued changes the account does not have yet, refused ones included. */
  unsent(): number {
    return countPending(this.pending);
  }

  private tasks(state: StudioState): Task[] {
    const tasks: Task[] = [];
    if (this.pending.clearRuns) {
      tasks.push({ key: 'clear', label: 'run history', keeps: false, run: async () => void (await api('/api/runs', { method: 'DELETE', headers: this.headers() })) });
    }
    for (const [id, op] of Object.entries(this.pending.workflows)) {
      if (this.pending.rejected[`w:${id}`] !== undefined) continue;
      const workflow = state.workflows[id];
      const label = `“${workflow?.name ?? 'a workflow'}”`;
      const path = `/api/workflows/${encodeURIComponent(id)}`;
      if (op === 'put' && workflow !== undefined) {
        tasks.push({
          key: `w:${id}`,
          label,
          keeps: true,
          run: async () => {
            const result = await api<{ revision: string }>(path, { method: 'PUT', body: withoutSecrets(workflow), headers: this.headers({ 'x-relay-revision': this.pending.revisions[id] ?? 'none' }) });
            this.pending.revisions[id] = result.revision;
          },
        });
      } else if (op === 'put') {
        // Queued, but the workflow is not here any more (another tab's queue, taken over): nothing to send.
        this.settle(`w:${id}`, this.marks.get(`w:${id}`));
      } else if (op === 'delete') {
        tasks.push({
          key: `w:${id}`,
          label,
          keeps: false,
          run: async () => {
            await api(path, { method: 'DELETE', headers: this.headers() });
            delete this.pending.revisions[id];
          },
        });
      }
    }
    const runsById = new Map(state.runs.map((run) => [run.id, run]));
    for (const [id, op] of Object.entries(this.pending.runs)) {
      if (this.pending.rejected[`r:${id}`] !== undefined) continue;
      const run = runsById.get(id);
      const path = `/api/runs/${encodeURIComponent(id)}`;
      if (op === 'put' && run !== undefined) {
        tasks.push({ key: `r:${id}`, label: `run ${run.shortId}`, keeps: true, run: async () => void (await api(path, { method: 'PUT', body: fitRun(run), headers: this.headers() })) });
      } else if (op === 'put') {
        this.settle(`r:${id}`, this.marks.get(`r:${id}`));
      } else if (op === 'delete') {
        tasks.push({ key: `r:${id}`, label: 'a run', keeps: false, run: async () => void (await api(path, { method: 'DELETE', headers: this.headers() })) });
      }
    }
    if (this.pending.workspace && this.pending.rejected['ws'] === undefined) {
      tasks.push({ key: 'ws', label: 'your settings', keeps: true, run: async () => void (await api('/api/workspace', { method: 'PATCH', body: workspaceBody(state), headers: this.headers() })) });
    }
    return tasks;
  }

  /**
   * Someone else saved this workflow first. Their copy takes the original
   * name; this browser's becomes a "conflicted copy" next to it, saved as a
   * new workflow. Nothing either side did is lost, and the builder reopens
   * on the current copy.
   */
  private resolveConflict(id: string, data: Record<string, unknown>): void {
    const server = data['workflow'] as Workflow | undefined;
    const revision = data['revision'] as string | undefined;
    if (server === undefined || revision === undefined) return;
    const state = useStudio.getState();
    const local = state.workflows[id];
    const workflows = { ...state.workflows, [id]: withLocalSecrets(server, local) };
    let copyName: string | null = null;
    // Compared as the server sees them: its copy never has the secret fields
    // this browser keeps, and that difference alone is not a second version.
    const mine = local === undefined ? undefined : withoutSecrets(local);
    if (local !== undefined && mine !== undefined && JSON.stringify([mine.nodes, mine.edges, mine.name, mine.description]) !== JSON.stringify([server.nodes, server.edges, server.name, server.description])) {
      const now = new Date().toISOString();
      const copy: Workflow = { ...local, id: `wf_${nanoid(10)}`, name: `${local.name} (conflicted copy)`, enabled: false, createdAt: now, updatedAt: now };
      workflows[copy.id] = copy;
      copyName = copy.name;
    }
    this.pending.revisions[id] = revision;
    useStudio.setState({ workflows });
    // The server's copy came from the server: nothing to send back.
    delete this.pending.workflows[id];
    this.marks.delete(`w:${id}`);
    useAccount.setState((account) => ({ epoch: account.epoch + 1 }));
    if (copyName !== null) {
      toast.warning(`“${server.name}” was changed somewhere else`, { description: `Both versions are kept: theirs under the original name, yours as “${copyName}”.`, duration: 12_000 });
    }
  }

  /** Best effort as the tab goes away: small requests that the browser finishes after the page is gone. */
  private onPageHide = () => {
    const state = useStudio.getState();
    if (this.paused || this.stopped || state.owner !== this.owner) return;
    let budget = 60_000;
    const send = (path: string, method: string, body?: unknown, extra: Record<string, string> = {}) => {
      const size = body === undefined ? 0 : JSON.stringify(body).length;
      if (size > budget) return;
      budget -= size;
      void api(path, { method, body, keepalive: true, headers: this.headers(extra) }).catch(() => undefined);
    };
    for (const [id, op] of Object.entries(this.pending.workflows)) {
      const path = `/api/workflows/${encodeURIComponent(id)}`;
      if (op === 'delete') send(path, 'DELETE');
      else if (state.workflows[id] !== undefined) send(path, 'PUT', withoutSecrets(state.workflows[id]!), { 'x-relay-revision': this.pending.revisions[id] ?? 'none' });
    }
    if (this.pending.workspace) send('/api/workspace', 'PATCH', workspaceBody(state));
    // The queue stays in localStorage until the server confirms: whatever did not make it goes on the next load.
  };

  private onOnline = () => {
    if (countPending(this.pending) === 0) return;
    // Back online is a reason to try now, whatever the backoff had in mind.
    this.retryUntil = 0;
    this.schedule(0);
  };
}

let engine: SyncEngine | null = null;

/** Flush what is queued now, e.g. before signing out or before a page that reads from the server. */
export async function flushNow(timeoutMs = 4000): Promise<void> {
  if (engine === null) return;
  await Promise.race([engine.flush(), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
}

/** How many changes this browser has that the account does not. */
export function unsentChanges(): number {
  return engine?.unsent() ?? 0;
}

/* ------------------------------------------------------------------ */
/* Signing in and out                                                  */
/* ------------------------------------------------------------------ */

interface WorkspaceResponse {
  /** Whose workspace the server loaded: it must be the person Clerk says is signed in. */
  user: { id: string };
  workspace: {
    settings: Partial<Settings> | null;
    connections: Record<string, Connection> | null;
    toursSeen: Record<string, boolean> | null;
    checklistDismissed: boolean;
    onboarding: OnboardingAnswers | null;
    onboardedAt: string | null;
  };
  workflows: Workflow[];
  revisions: Record<string, string>;
  runs: Run[];
  shares: Record<string, string>;
  /** Ids that did not fit in one answer; each is fetched on its own. Absent from an older server. */
  rest?: { workflows: string[]; runs: string[] };
}

/** `tasks`, a few at a time. */
async function inBatches<T>(tasks: Array<() => Promise<T>>, size: number): Promise<T[]> {
  const results: T[] = [];
  for (let index = 0; index < tasks.length; index += size) {
    results.push(...(await Promise.all(tasks.slice(index, index + size).map((task) => task()))));
  }
  return results;
}

/** The person Clerk says is signed in, as the studio shows them. */
let clerkUser: AccountUser | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Once per page load: accounts on or off. When on, Clerk decides who is
 * signed in and tells `accountChanged`; until it answers, the studio waits —
 * but never for long, so a blocked or slow Clerk script leaves a working
 * guest studio rather than a spinner.
 */
export async function startAccount(capabilities: AuthCapabilities): Promise<void> {
  useAccount.setState({ capabilities });
  if (!capabilities.enabled) {
    useAccount.setState({ status: 'disabled' });
    return;
  }
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    if (useAccount.getState().status === 'unknown') {
      const owner = useStudio.getState().owner;
      if (owner !== null) {
        parkUnsent(owner);
        restoreGuest();
      }
      becomeGuest();
    }
  }, 6000);
}

/**
 * Clerk's answer, on load and whenever it changes — signing in or out here,
 * in another tab, or a session ending on another device.
 */
export async function accountChanged(user: AccountUser | null): Promise<void> {
  clerkUser = user;
  const current = useAccount.getState();
  if (current.status === 'disabled') return;
  if (user === null) {
    const owner = useStudio.getState().owner;
    engine?.stop();
    engine = null;
    if (owner !== null) {
      parkUnsent(owner);
      restoreGuest();
    }
    becomeGuest();
    return;
  }
  if (current.status === 'signed-in' && current.user?.id === user.id) {
    // Same person; their name or picture may have changed.
    useAccount.setState({ user });
    return;
  }
  await loadAccount();
}

let loading: Promise<void> | null = null;

/** Loads the signed-in person's workspace; one load at a time. */
export function loadAccount(): Promise<void> {
  if (loading === null) loading = doLoadAccount().finally(() => (loading = null));
  return loading;
}

/** An account's unsent changes, set aside when its session ends, sent the next time it signs in here. */
interface Unsent {
  owner: string;
  pending: Pending;
  workflows: Record<string, Workflow>;
  runs: Run[];
  workspace: ReturnType<typeof workspaceBody> | null;
}

function parkUnsent(owner: string): void {
  const state = useStudio.getState();
  const pending = readPending(owner);
  if (state.owner !== owner || countPending(pending) === 0) return;
  const unsent: Unsent = {
    owner,
    pending,
    workflows: Object.fromEntries(Object.keys(pending.workflows).flatMap((id) => (state.workflows[id] === undefined ? [] : [[id, state.workflows[id]!]]))),
    runs: state.runs.filter((run) => pending.runs[run.id] === 'put'),
    workspace: pending.workspace ? workspaceBody(state) : null,
  };
  try {
    window.localStorage.setItem(UNSENT_KEY, JSON.stringify(unsent));
  } catch {
    // Too large to keep; the account still has everything it received.
  }
}

function readUnsent(owner: string): Unsent | null {
  try {
    const raw = window.localStorage.getItem(UNSENT_KEY);
    const parsed = raw === null ? null : (JSON.parse(raw) as Unsent);
    return parsed !== null && parsed.owner === owner ? parsed : null;
  } catch {
    return null;
  }
}

async function doLoadAccount(): Promise<void> {
  const user = clerkUser;
  if (user === null) return;
  const cachedOwner = useStudio.getState().owner;
  useAccount.setState({ status: 'loading', loadError: null });
  let payload: WorkspaceResponse;
  try {
    payload = await api<WorkspaceResponse>('/api/workspace');
  } catch (error) {
    const failure = error instanceof CloudError ? error : new CloudError(0, 'UNKNOWN', String(error));
    if (failure.status === 503 && failure.code === 'ACCOUNTS_DISABLED') {
      useAccount.setState({ status: 'disabled' });
      return;
    }
    // Signed in with Clerk, but the studio's server cannot be reached or is
    // failing. If this browser has the account's last known state, work from
    // it and send the changes later; otherwise carry on as a guest.
    useAccount.setState({ loadError: failure.message });
    if (cachedOwner === user.id) {
      useAccount.setState({ status: 'signed-in', user });
      startEngine(user.id, await collectPending(user.id));
      toast.warning('Working offline', { description: 'Your workspace could not be reached. Changes are kept in this browser and saved when it is back.' });
    } else {
      // Signed in, with nothing of theirs in this browser to work from. That
      // is not the same as signed out, and must not look like it: the studio
      // says the workspace could not be loaded, and keeps trying.
      if (cachedOwner !== null) {
        parkUnsent(cachedOwner);
        restoreGuest();
      }
      engine?.stop();
      engine = null;
      useAccount.setState({ status: 'unreachable', user, loadError: failure.message });
      scheduleReload();
    }
    return;
  }
  // Clerk moved on (signed out, or someone else) while this was loading.
  if (clerkUser?.id !== user.id || payload.user.id !== user.id) return;
  reloadAttempt = 0;
  if (reloadTimer !== null) clearTimeout(reloadTimer);
  reloadTimer = null;

  // A workspace too large for one answer names what was left out; those are fetched one by one.
  if (payload.rest !== undefined && (payload.rest.workflows.length > 0 || payload.rest.runs.length > 0)) {
    try {
      const workflows = await inBatches(payload.rest.workflows.map((id) => () => api<{ workflow: Workflow }>(`/api/workflows/${encodeURIComponent(id)}`)), CONCURRENCY);
      const runs = await inBatches(payload.rest.runs.map((id) => () => api<{ run: Run }>(`/api/runs/${encodeURIComponent(id)}`)), CONCURRENCY);
      payload.workflows.push(...workflows.map((entry) => entry.workflow));
      payload.runs.push(...runs.map((entry) => entry.run));
    } catch (error) {
      // Showing part of an account as if it were all of it would have the
      // next save delete the rest. Treat it as not loaded.
      const failure = error instanceof CloudError ? error : new CloudError(0, 'UNKNOWN', String(error));
      useAccount.setState({ status: 'unreachable', user, loadError: failure.message });
      scheduleReload();
      return;
    }
    if (clerkUser?.id !== user.id) return;
  }

  engine?.stop();
  engine = null;
  const state = useStudio.getState();
  if (state.owner === null) stashGuestWork(state);
  else if (state.owner !== user.id) parkUnsent(state.owner);

  // What this browser has for this account that the server may not: the
  // live store if it is this account's, or changes set aside when its
  // session ended here.
  const unsent = state.owner === user.id ? null : readUnsent(user.id);
  const local: { workflows: Record<string, Workflow>; runs: Run[]; workspace: ReturnType<typeof workspaceBody> | null } | null =
    state.owner === user.id ? { workflows: state.workflows, runs: state.runs, workspace: workspaceBody(state) } : unsent;
  const pending = state.owner === user.id ? await collectPending(user.id) : { ...emptyPending(user.id), ...(unsent?.pending ?? {}), owner: user.id };

  // Secret field values never reach the server; this browser's own are put back.
  const workflows: Record<string, Workflow> = Object.fromEntries(payload.workflows.map((workflow) => [workflow.id, withLocalSecrets(workflow, local?.workflows[workflow.id])]));
  const runs = new Map(payload.runs.map((run) => [run.id, run]));
  // Revisions: the server's, except for workflows with changes still queued
  // here, which keep the revision those changes were based on — so a change
  // made against an older copy is caught as a conflict, not written over.
  const revisions: Record<string, string> = { ...payload.revisions };
  for (const id of Object.keys(pending.workflows)) {
    const base = pending.revisions[id];
    if (base === undefined) delete revisions[id];
    else revisions[id] = base;
  }
  if (local !== null) {
    for (const [id, op] of Object.entries(pending.workflows)) {
      if (op === 'delete') delete workflows[id];
      else if (local.workflows[id] !== undefined) workflows[id] = local.workflows[id]!;
    }
    const localRuns = new Map(local.runs.map((run) => [run.id, run]));
    for (const [id, op] of Object.entries(pending.runs)) {
      if (op === 'delete') runs.delete(id);
      else if (localRuns.has(id)) runs.set(id, localRuns.get(id)!);
    }
  }

  // A test run the server has as "running" was cut off when its tab closed.
  const interrupted: string[] = [];
  const runList = [...runs.values()]
    .map((run) => {
      if (run.status !== 'running' || run.source === 'machine') return run;
      interrupted.push(run.id);
      return { ...run, status: 'cancelled' as const, finishedAt: run.finishedAt ?? run.events.at(-1)?.at ?? run.startedAt, summary: run.summary ?? 'Interrupted: the tab was closed while this test run was playing.' };
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  const saved = payload.workspace;
  const workspaceLocal = pending.workspace && local?.workspace ? local.workspace : null;
  useStudio.getState().replaceWorkspace({
    owner: user.id,
    workflows,
    runs: runList,
    connections: workspaceLocal?.connections ?? saved.connections ?? {},
    settings: workspaceLocal?.settings ?? { ...DEFAULT_SETTINGS, ...(saved.settings ?? {}), auth: { ...DEFAULT_SETTINGS.auth, ...(saved.settings?.auth ?? {}) } },
    toursSeen: workspaceLocal?.toursSeen ?? saved.toursSeen ?? {},
    checklistDismissed: workspaceLocal?.checklistDismissed ?? saved.checklistDismissed,
  });
  if (unsent !== null) {
    try {
      window.localStorage.removeItem(UNSENT_KEY);
    } catch {
      // Sent from the queue now either way.
    }
  }
  useAccount.setState({ status: 'signed-in', user, onboardedAt: saved.onboardedAt, onboarding: saved.onboarding, shares: payload.shares, loadError: null });
  engine = new SyncEngine(user.id, { ...pending, owner: user.id, revisions });
  for (const id of interrupted) engine.markRun(id);
}

function startEngine(owner: string, pending: Pending): void {
  engine?.stop();
  engine = new SyncEngine(owner, pending);
}

let reloadTimer: ReturnType<typeof setTimeout> | null = null;
let reloadAttempt = 0;

/** A workspace that could not be loaded is asked for again: after 4s, 8s, 16s… up to a minute apart, and at once when the network returns. */
function scheduleReload(): void {
  if (reloadTimer !== null) clearTimeout(reloadTimer);
  reloadAttempt += 1;
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    if (useAccount.getState().status === 'unreachable') void loadAccount();
  }, Math.min(MAX_RETRY_MS, 2000 * 2 ** reloadAttempt));
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (useAccount.getState().status === 'unreachable') void loadAccount();
  });
}

function becomeGuest(): void {
  engine?.stop();
  engine = null;
  useAccount.setState({ status: 'guest', user: null, onboardedAt: null, onboarding: null, shares: {} });
}

/**
 * Signs out here: sends what is queued, ends the Clerk session, and only
 * then puts back what this browser had as a guest. If Clerk cannot be
 * reached the session is still valid in this browser, so nothing is cleared
 * and the person is told.
 */
export async function signOut(endSession: () => Promise<unknown>, options: { discardUnsent?: boolean } = {}): Promise<'done' | 'unsent' | 'failed'> {
  await flushNow();
  // Signing out clears this browser, so whatever has not reached the account
  // by now would be gone. That is the person's call, not something to do
  // quietly behind a message saying their work is safe.
  if (options.discardUnsent !== true && unsentChanges() > 0) return 'unsent';
  try {
    await endSession();
  } catch {
    toast.error('Could not sign out', { description: 'Clerk could not be reached, so this browser is still signed in. Try again when you are online.' });
    return 'failed';
  }
  forgetAccount();
  return 'done';
}

const forgotten = new Set<() => void>();

/** Runs when the account is cleared from this browser, for state kept elsewhere that belonged to it. */
export function onAccountForgotten(listener: () => void): void {
  forgotten.add(listener);
}

/** Clears every trace of the account from this browser. Used by sign-out and account deletion. */
export function forgetAccount(): void {
  engine?.stop();
  engine = null;
  clerkUser = null;
  if (reloadTimer !== null) clearTimeout(reloadTimer);
  reloadTimer = null;
  try {
    window.localStorage.removeItem(pendingKey());
    window.localStorage.removeItem(PENDING_KEY);
    window.localStorage.removeItem(UNSENT_KEY);
  } catch {
    // Nothing to clear.
  }
  useSyncStatus.setState({ state: 'idle', lastSavedAt: null, message: null, pendingCount: 0 });
  for (const listener of forgotten) listener();
  restoreGuest();
  becomeGuest();
}

function sessionExpired(): void {
  // Clerk will say so too; until then the queue keeps growing in localStorage.
  engine?.pause();
  useSyncStatus.setState({ state: 'error', message: 'Signed out. Sign in again to save your changes.' });
}

/** The session now belongs to someone else (another tab signed in as them): set this account's work aside. Clerk's own update loads theirs. */
async function accountSwitched(owner: string): Promise<void> {
  engine?.stop();
  engine = null;
  parkUnsent(owner);
  toast.info('This browser is now signed in as someone else', { description: 'Your unsaved changes are kept and sent the next time you sign in here.' });
  if (clerkUser !== null && clerkUser.id !== owner) await loadAccount();
}

/* ------------------------------------------------------------------ */
/* What a guest made before signing in                                 */
/* ------------------------------------------------------------------ */

export interface GuestBackup {
  savedAt: string;
  workflows: Workflow[];
  runs: Run[];
  /** The rest of the guest's studio, put back as it was after signing out. */
  rest?: Pick<StudioState, 'seeded' | 'settings' | 'connections' | 'toursSeen' | 'checklistDismissed'>;
}

function stashGuestWork(state: StudioState): void {
  const workflows = Object.values(state.workflows);
  if (workflows.length === 0 && !state.seeded) return;
  const backup: GuestBackup = {
    savedAt: new Date().toISOString(),
    workflows,
    runs: state.runs.filter((run) => run.status !== 'running'),
    rest: { seeded: state.seeded, settings: state.settings, connections: state.connections, toursSeen: state.toursSeen, checklistDismissed: state.checklistDismissed },
  };
  try {
    window.localStorage.setItem(GUEST_BACKUP_KEY, JSON.stringify(backup));
  } catch {
    // Too big to keep: the guest's work stays in their own export, if they made one.
  }
}

export function readGuestBackup(): GuestBackup | null {
  try {
    const raw = window.localStorage.getItem(GUEST_BACKUP_KEY);
    return raw === null ? null : (JSON.parse(raw) as GuestBackup);
  } catch {
    return null;
  }
}

/**
 * Workflows from the guest backup worth offering to bring into an account:
 * not the untouched starter examples, and not ones already in it — so an
 * import can never overwrite work done since.
 */
export function importableGuestWorkflows(backup: GuestBackup | null, inAccount: Record<string, unknown> = {}): Workflow[] {
  if (backup === null) return [];
  return backup.workflows
    .filter((workflow) => inAccount[workflow.id] === undefined && !(workflow.demo === true && workflow.updatedAt === workflow.createdAt))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function importGuestWorkflows(ids: string[]): Promise<{ workflows: number; skipped: string[] }> {
  const backup = readGuestBackup();
  const studio = useStudio.getState();
  const wanted = new Set(ids.filter((id) => studio.workflows[id] === undefined));
  if (backup === null || wanted.size === 0) return { workflows: 0, skipped: [] };
  const chosen = backup.workflows.filter((workflow) => wanted.has(workflow.id)).map((workflow) => ({ ...workflow, demo: undefined }));
  const chosenIds = new Set(chosen.map((workflow) => workflow.id));
  const runs = backup.runs.filter((run) => chosenIds.has(run.workflowId));
  // In several requests when it is large: a host accepts only a few megabytes at a time.
  const result = { workflows: 0, runs: 0, skipped: [] as string[], revisions: {} as Record<string, string> };
  const headers: Record<string, string> = studio.owner === null ? {} : { 'x-relay-user': studio.owner };
  const send = async (body: { workflows: Workflow[]; runs: Run[] }) => {
    const part = await api<typeof result>('/api/workspace/import', { method: 'POST', body, headers });
    result.workflows += part.workflows;
    result.runs += part.runs;
    result.skipped.push(...part.skipped);
    Object.assign(result.revisions, part.revisions);
  };
  for (const batch of batchesBySize(chosen.map(withoutSecrets))) await send({ workflows: batch, runs: [] });
  for (const batch of batchesBySize(runs.map(fitRun))) await send({ workflows: [], runs: batch });
  // Show them now, without waiting for a reload; the server already has them.
  const merged = { ...studio.workflows };
  for (const workflow of chosen) if (result.revisions[workflow.id] !== undefined) merged[workflow.id] = workflow;
  const known = new Set(studio.runs.map((run) => run.id));
  const added = runs.filter((run) => !known.has(run.id) && result.revisions[run.workflowId] !== undefined);
  useStudio.setState({ workflows: merged, runs: [...studio.runs, ...added].sort((a, b) => b.startedAt.localeCompare(a.startedAt)) });
  engine?.adopt(result.revisions, added.map((run) => run.id));
  return { workflows: result.workflows, skipped: result.skipped };
}

/** Items in order, in groups small enough for one request each. */
function batchesBySize<T>(items: T[], maxBytes = 2_500_000): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const item of items) {
    const bytes = new Blob([JSON.stringify(item)]).size;
    if (current.length > 0 && size + bytes > maxBytes) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function restoreGuest(): void {
  const backup = readGuestBackup();
  const studio = useStudio.getState();
  // Keep how the studio looks and moves on this device, whoever was signed in.
  const motion = studio.settings.motion;
  studio.resetToGuest();
  if (backup === null) {
    useStudio.setState((state) => ({ settings: { ...state.settings, motion } }));
    return;
  }
  useStudio.setState({
    ...(backup.rest ?? {}),
    workflows: Object.fromEntries(backup.workflows.map((workflow) => [workflow.id, workflow])),
    runs: backup.runs,
    seeded: backup.rest?.seeded ?? backup.workflows.length > 0,
  });
}
