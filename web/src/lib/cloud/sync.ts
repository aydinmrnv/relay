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
 * the tab closed, is sent on the next load instead of being lost.
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
import { authClient } from '@/lib/auth-client';
import { DEFAULT_BRAND, type Brand } from '@/lib/brand';
import { useStudio, type StudioState } from '@/lib/store';
import { DEFAULT_SETTINGS, type Connection, type Run, type Settings, type Workflow } from '@/lib/workflow/schema';
import { HINT_KEY, hasSessionHint, hintedUser, setSessionHint, useAccount } from './account';
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

export async function api<T>(path: string, init: { method?: string; body?: unknown; keepalive?: boolean; headers?: Record<string, string> } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method ?? 'GET',
      headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
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
}

const PENDING_KEY = 'relay-cloud-pending';
const UNSENT_KEY = 'relay-cloud-unsent';
const GUEST_BACKUP_KEY = 'relay-guest-backup';

function emptyPending(owner: string): Pending {
  return { owner, workflows: {}, runs: {}, workspace: false, clearRuns: false, revisions: {} };
}

function countPending(pending: Pending): number {
  return Object.keys(pending.workflows).length + Object.keys(pending.runs).length + (pending.workspace ? 1 : 0) + (pending.clearRuns ? 1 : 0);
}

function readPending(owner: string): Pending {
  try {
    const raw = window.localStorage.getItem(PENDING_KEY);
    if (raw === null) return emptyPending(owner);
    const parsed = JSON.parse(raw) as Pending;
    return parsed.owner === owner ? { ...emptyPending(owner), ...parsed } : emptyPending(owner);
  } catch {
    return emptyPending(owner);
  }
}

function writePending(pending: Pending): void {
  const count = countPending(pending);
  useSyncStatus.setState({ pendingCount: count });
  try {
    if (count === 0) window.localStorage.removeItem(PENDING_KEY);
    else window.localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    // Storage full or unavailable: the in-memory queue still gets sent.
  }
}

/** A test run is worth keeping once it has finished; a run on a real machine, from its first line. */
function syncable(run: Run): boolean {
  return run.status !== 'running' || run.source === 'machine';
}

/** Very long runs are trimmed to their last events, so they fit the server's size limit. */
function trimRun(run: Run): Run {
  return run.events.length > 4000 ? { ...run, events: run.events.slice(-4000) } : run;
}

function workspaceBody(state: StudioState) {
  return { settings: state.settings, brand: state.brand, connections: state.connections, toursSeen: state.toursSeen, checklistDismissed: state.checklistDismissed };
}

/* ------------------------------------------------------------------ */
/* The engine                                                           */
/* ------------------------------------------------------------------ */

const QUIET_MS = 900;
const MAX_WAIT_MS = 4000;
const CONCURRENCY = 4;

interface Task {
  /** Which queue entry this settles: `w:<id>`, `r:<id>`, `ws` or `clear`. */
  key: string;
  label: string;
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
  }

  /** Settle a queue entry — unless it was marked again after the request carrying it left. */
  private settle(key: string, sentSeq: number | undefined): void {
    if (this.marks.get(key) !== sentSeq) return;
    this.marks.delete(key);
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
        // Deleting a workflow deletes its runs on the server too.
        if (!now.has(run.id) && pending.workflows[run.workflowId] !== 'delete') {
          this.mark(`r:${run.id}`, () => (pending.runs[run.id] = 'delete'));
          changed = true;
        }
      }
    }

    if (
      state.settings !== prev.settings ||
      state.brand !== prev.brand ||
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

  private schedule(delay = QUIET_MS): void {
    if (this.paused || this.stopped) return;
    const now = Date.now();
    if (this.timer === null) this.firstDirtyAt = now;
    else clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(delay, this.firstDirtyAt + MAX_WAIT_MS - now));
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

    useSyncStatus.setState({ state: 'saving', message: null });
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
    // A request the server rejected on its merits will be rejected again;
    // say so and drop it. Anything else — offline, a 5xx — stays queued.
    const rest = failed.filter((entry) => entry.error.code !== 'CONFLICT');
    const permanent = rest.filter((entry) => entry.error.status >= 400 && entry.error.status < 500 && entry.error.status !== 408 && entry.error.status !== 429);
    for (const entry of permanent) this.settle(entry.task.key, sent.get(entry.task.key));
    const transient = rest.filter((entry) => !permanent.includes(entry));
    writePending(this.pending);

    if (permanent.length > 0) {
      const first = permanent[0]!;
      toast.error(`Could not save ${first.task.label} to your account`, { description: first.error.message });
    }
    if (transient.length > 0) {
      const offline = transient.every((entry) => entry.error.status === 0);
      this.retryMs = Math.min(60_000, this.retryMs === 0 ? 3000 : this.retryMs * 2);
      useSyncStatus.setState({
        state: offline ? 'offline' : 'error',
        message: offline ? 'Offline. Changes are kept in this browser and sent when you are back.' : transient[0]!.error.message,
      });
      this.schedule(this.retryMs);
    } else {
      this.retryMs = 0;
      useSyncStatus.setState({ state: 'saved', lastSavedAt: Date.now(), message: null });
    }
  }

  private tasks(state: StudioState): Task[] {
    const tasks: Task[] = [];
    if (this.pending.clearRuns) {
      tasks.push({ key: 'clear', label: 'run history', run: async () => void (await api('/api/runs', { method: 'DELETE', headers: this.headers() })) });
    }
    for (const [id, op] of Object.entries(this.pending.workflows)) {
      const workflow = state.workflows[id];
      const label = `“${workflow?.name ?? 'a workflow'}”`;
      const path = `/api/workflows/${encodeURIComponent(id)}`;
      if (op === 'put' && workflow !== undefined) {
        tasks.push({
          key: `w:${id}`,
          label,
          run: async () => {
            const result = await api<{ revision: string }>(path, { method: 'PUT', body: withoutSecrets(workflow), headers: this.headers({ 'x-relay-revision': this.pending.revisions[id] ?? 'none' }) });
            this.pending.revisions[id] = result.revision;
          },
        });
      } else if (op === 'delete') {
        tasks.push({
          key: `w:${id}`,
          label,
          run: async () => {
            await api(path, { method: 'DELETE', headers: this.headers() });
            delete this.pending.revisions[id];
          },
        });
      }
    }
    const runsById = new Map(state.runs.map((run) => [run.id, run]));
    for (const [id, op] of Object.entries(this.pending.runs)) {
      const run = runsById.get(id);
      const path = `/api/runs/${encodeURIComponent(id)}`;
      if (op === 'put' && run !== undefined) {
        tasks.push({ key: `r:${id}`, label: `run ${run.shortId}`, run: async () => void (await api(path, { method: 'PUT', body: trimRun(run), headers: this.headers() })) });
      } else if (op === 'delete') {
        tasks.push({ key: `r:${id}`, label: 'a run', run: async () => void (await api(path, { method: 'DELETE', headers: this.headers() })) });
      }
    }
    if (this.pending.workspace) {
      tasks.push({ key: 'ws', label: 'your settings', run: async () => void (await api('/api/workspace', { method: 'PATCH', body: workspaceBody(state), headers: this.headers() })) });
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
    if (local !== undefined && JSON.stringify([local.nodes, local.edges, local.name, local.description]) !== JSON.stringify([server.nodes, server.edges, server.name, server.description])) {
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
    if (countPending(this.pending) > 0) this.schedule(0);
  };
}

let engine: SyncEngine | null = null;

/** Flush what is queued now, e.g. before signing out or before a page that reads from the server. */
export async function flushNow(timeoutMs = 4000): Promise<void> {
  if (engine === null) return;
  await Promise.race([engine.flush(), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
}

/* ------------------------------------------------------------------ */
/* Signing in and out                                                  */
/* ------------------------------------------------------------------ */

interface WorkspaceResponse {
  user: Omit<AccountUser, 'createdAt'> & { createdAt: string };
  workspace: {
    settings: Partial<Settings> | null;
    brand: Brand | null;
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
}

let listening = false;

/** Decides, once per page load, whether this is a guest or an account, and loads the account if so. */
export async function startAccount(capabilities: AuthCapabilities): Promise<void> {
  useAccount.setState({ capabilities });
  if (!capabilities.enabled) {
    useAccount.setState({ status: 'disabled' });
    return;
  }
  listenAcrossTabs();
  if (!hasSessionHint()) {
    // An account's workspace left behind with no session (it expired, or it
    // ended in another tab) is not shown to whoever uses this browser next.
    const owner = useStudio.getState().owner;
    if (owner !== null) {
      parkUnsent(owner);
      restoreGuest();
    }
    becomeGuest();
    return;
  }
  await loadAccount();
}

/** Signing in or out in another tab changes the cookie this tab sends; follow it. */
function listenAcrossTabs(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('storage', (event) => {
    if (event.key !== HINT_KEY) return;
    const current = useAccount.getState();
    if (event.newValue === null) {
      if (current.status === 'signed-in' && current.user !== null) {
        engine?.stop();
        engine = null;
        parkUnsent(current.user.id);
        restoreGuest();
        becomeGuest();
      }
      return;
    }
    const hinted = hintedUser();
    if (hinted !== null && hinted.id === current.user?.id) return;
    void loadAccount();
  });
}

/** After a successful sign-in or sign-up: remember it, and swap in the account's workspace. */
export async function signedIn(): Promise<void> {
  setSessionHint(true);
  await loadAccount();
}

let loading: Promise<void> | null = null;

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
  const cachedOwner = useStudio.getState().owner;
  useAccount.setState({ status: 'loading', loadError: null });
  let payload: WorkspaceResponse;
  try {
    payload = await api<WorkspaceResponse>('/api/workspace');
  } catch (error) {
    const failure = error instanceof CloudError ? error : new CloudError(0, 'UNKNOWN', String(error));
    if (failure.status === 401) {
      setSessionHint(false);
      if (cachedOwner !== null) {
        parkUnsent(cachedOwner);
        restoreGuest();
      }
      becomeGuest();
      return;
    }
    if (failure.status === 503 && failure.code === 'ACCOUNTS_DISABLED') {
      useAccount.setState({ status: 'disabled' });
      return;
    }
    // The server is unreachable or failing. If this browser has the
    // account's last known state, work from it and send the changes later.
    useAccount.setState({ loadError: failure.message });
    const cachedUser = hintedUser();
    if (cachedOwner !== null && cachedUser !== null && cachedUser.id === cachedOwner) {
      useAccount.setState({ status: 'signed-in', user: cachedUser });
      startEngine(cachedOwner, readPending(cachedOwner));
      toast.warning('Working offline', { description: 'Your account could not be reached. Changes are kept in this browser and saved when it is back.' });
    } else {
      if (cachedOwner !== null) {
        parkUnsent(cachedOwner);
        restoreGuest();
      }
      becomeGuest();
      toast.error('Could not load your account', { description: failure.message });
    }
    return;
  }

  engine?.stop();
  engine = null;
  const user: AccountUser = { ...payload.user, image: payload.user.image ?? null };
  const state = useStudio.getState();
  if (state.owner === null) stashGuestWork(state);
  else if (state.owner !== user.id) parkUnsent(state.owner);

  // What this browser has for this account that the server may not: the
  // live store if it is this account's, or changes set aside when its
  // session ended here.
  const unsent = state.owner === user.id ? null : readUnsent(user.id);
  const local: { workflows: Record<string, Workflow>; runs: Run[]; workspace: ReturnType<typeof workspaceBody> | null } | null =
    state.owner === user.id ? { workflows: state.workflows, runs: state.runs, workspace: workspaceBody(state) } : unsent;
  const pending = state.owner === user.id ? readPending(user.id) : (unsent?.pending ?? emptyPending(user.id));

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
    brand: workspaceLocal?.brand ?? saved.brand ?? DEFAULT_BRAND,
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
  setSessionHint(true, user);
  engine = new SyncEngine(user.id, { ...pending, owner: user.id, revisions });
  for (const id of interrupted) engine.markRun(id);
}

function startEngine(owner: string, pending: Pending): void {
  engine?.stop();
  engine = new SyncEngine(owner, pending);
}

function becomeGuest(): void {
  engine?.stop();
  engine = null;
  useAccount.setState({ status: 'guest', user: null, onboardedAt: null, onboarding: null, shares: {} });
}

/**
 * Signs out here: sends what is queued, ends the session on the server, and
 * only then puts back what this browser had as a guest. If the server cannot
 * be reached the session would still be valid in this browser, so nothing is
 * cleared and the person is told.
 */
export async function signOut(): Promise<boolean> {
  await flushNow();
  let failed = false;
  try {
    const { error } = await authClient.signOut();
    failed = error !== null && error !== undefined;
  } catch {
    failed = true;
  }
  if (failed) {
    toast.error('Could not sign out', { description: 'The server could not be reached, so this browser is still signed in. Try again when you are online.' });
    return false;
  }
  forgetAccount();
  return true;
}

/** Clears every trace of the account from this browser. Used by sign-out and account deletion. */
export function forgetAccount(): void {
  engine?.stop();
  engine = null;
  setSessionHint(false);
  try {
    window.localStorage.removeItem(PENDING_KEY);
    window.localStorage.removeItem(UNSENT_KEY);
  } catch {
    // Nothing to clear.
  }
  useSyncStatus.setState({ state: 'idle', lastSavedAt: null, message: null, pendingCount: 0 });
  restoreGuest();
  becomeGuest();
}

function sessionExpired(): void {
  // The queue keeps growing in localStorage; signing back in sends it.
  engine?.pause();
  setSessionHint(false);
  useAccount.setState({ status: 'guest', user: null });
  useSyncStatus.setState({ state: 'error', message: 'Signed out. Sign in again to save your changes.' });
  toast.error('You were signed out', {
    description: 'Sign in again and your unsaved changes will be sent to your account.',
    // A toast outlives any one component, so it has no router; a full load also re-reads the session.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    action: { label: 'Sign in', onClick: () => window.location.assign(`/sign-in?next=${encodeURIComponent(window.location.pathname)}`) },
    duration: 20_000,
  });
}

/** The cookie now belongs to someone else (another tab signed in as them): set this account's work aside and load theirs. */
async function accountSwitched(owner: string): Promise<void> {
  engine?.stop();
  engine = null;
  parkUnsent(owner);
  toast.info('This browser is now signed in as someone else', { description: 'Your unsaved changes are kept and sent the next time you sign in here.' });
  await loadAccount();
}

/* ------------------------------------------------------------------ */
/* What a guest made before signing in                                 */
/* ------------------------------------------------------------------ */

export interface GuestBackup {
  savedAt: string;
  workflows: Workflow[];
  runs: Run[];
  /** The rest of the guest's studio, put back as it was after signing out. */
  rest?: Pick<StudioState, 'seeded' | 'settings' | 'brand' | 'connections' | 'toursSeen' | 'checklistDismissed'>;
}

function stashGuestWork(state: StudioState): void {
  const workflows = Object.values(state.workflows);
  if (workflows.length === 0 && !state.seeded) return;
  const backup: GuestBackup = {
    savedAt: new Date().toISOString(),
    workflows,
    runs: state.runs.filter((run) => run.status !== 'running'),
    rest: { seeded: state.seeded, settings: state.settings, brand: state.brand, connections: state.connections, toursSeen: state.toursSeen, checklistDismissed: state.checklistDismissed },
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
  const result = await api<{ workflows: number; runs: number; skipped: string[]; revisions: Record<string, string> }>('/api/workspace/import', {
    method: 'POST',
    body: { workflows: chosen.map(withoutSecrets), runs },
    headers: studio.owner === null ? {} : { 'x-relay-user': studio.owner },
  });
  // Show them now, without waiting for a reload; the server already has them.
  const merged = { ...studio.workflows };
  for (const workflow of chosen) if (result.revisions[workflow.id] !== undefined) merged[workflow.id] = workflow;
  const known = new Set(studio.runs.map((run) => run.id));
  const added = runs.filter((run) => !known.has(run.id) && result.revisions[run.workflowId] !== undefined);
  useStudio.setState({ workflows: merged, runs: [...studio.runs, ...added].sort((a, b) => b.startedAt.localeCompare(a.startedAt)) });
  engine?.adopt(result.revisions, added.map((run) => run.id));
  return { workflows: result.workflows, skipped: result.skipped };
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
