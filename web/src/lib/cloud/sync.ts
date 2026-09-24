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
 * The queue is written to localStorage as it changes. A change made offline,
 * or in the second before the tab closed, is sent on the next load instead
 * of being lost.
 */
import { create } from 'zustand';
import { toast } from 'sonner';
import { authClient } from '@/lib/auth-client';
import { DEFAULT_BRAND, type Brand } from '@/lib/brand';
import { useStudio, type StudioState } from '@/lib/store';
import { DEFAULT_SETTINGS, type Connection, type Run, type Settings, type Workflow } from '@/lib/workflow/schema';
import { hasSessionHint, hintedUser, setSessionHint, useAccount } from './account';
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
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; keepalive?: boolean } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method ?? 'GET',
      headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
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
    const body = (data ?? {}) as { code?: string; message?: string };
    throw new CloudError(response.status, body.code ?? `HTTP_${response.status}`, body.message ?? `The server answered ${response.status}.`);
  }
  return data as T;
}

/* ------------------------------------------------------------------ */
/* Save status, for the indicator in the header                        */
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
}

const PENDING_KEY = 'relay-cloud-pending';
const GUEST_BACKUP_KEY = 'relay-guest-backup';

function emptyPending(owner: string): Pending {
  return { owner, workflows: {}, runs: {}, workspace: false, clearRuns: false };
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
  const count = Object.keys(pending.workflows).length + Object.keys(pending.runs).length + (pending.workspace ? 1 : 0) + (pending.clearRuns ? 1 : 0);
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

/* ------------------------------------------------------------------ */
/* The engine                                                           */
/* ------------------------------------------------------------------ */

const QUIET_MS = 900;
const MAX_WAIT_MS = 4000;
const CONCURRENCY = 4;

class SyncEngine {
  private pending: Pending;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstDirtyAt = 0;
  private flushing: Promise<void> | null = null;
  private again = false;
  private retryMs = 0;
  /** Signed out underneath us: keep recording changes, send nothing until someone signs in again. */
  private paused = false;
  private readonly unsubscribe: () => void;

  constructor(readonly owner: string, pending: Pending) {
    this.pending = pending;
    this.unsubscribe = useStudio.subscribe((state, prev) => this.onChange(state, prev));
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('online', this.onOnline);
    writePending(this.pending);
    if (useSyncStatus.getState().pendingCount > 0) this.schedule(0);
  }

  stop(): void {
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

  markRun(id: string): void {
    this.pending.runs[id] = 'put';
    writePending(this.pending);
    this.schedule();
  }

  private onChange(state: StudioState, prev: StudioState): void {
    if (state.owner !== this.owner || prev.owner !== this.owner) return;
    const pending = this.pending;
    let changed = false;

    if (state.workflows !== prev.workflows) {
      for (const [id, workflow] of Object.entries(state.workflows)) {
        if (prev.workflows[id] !== workflow) {
          pending.workflows[id] = 'put';
          changed = true;
        }
      }
      for (const id of Object.keys(prev.workflows)) {
        if (state.workflows[id] === undefined) {
          pending.workflows[id] = 'delete';
          changed = true;
        }
      }
    }

    if (state.runs !== prev.runs) {
      if (state.runs.length === 0 && prev.runs.length > 0) {
        pending.clearRuns = true;
        pending.runs = {};
        changed = true;
      } else {
        const before = new Map(prev.runs.map((run) => [run.id, run]));
        const now = new Set<string>();
        for (const run of state.runs) {
          now.add(run.id);
          if (before.get(run.id) !== run && syncable(run)) {
            pending.runs[run.id] = 'put';
            changed = true;
          }
        }
        for (const run of prev.runs) {
          // Deleting a workflow deletes its runs on the server too.
          if (!now.has(run.id) && pending.workflows[run.workflowId] !== 'delete') {
            pending.runs[run.id] = 'delete';
            changed = true;
          }
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
      pending.workspace = true;
      changed = true;
    }

    if (changed) {
      writePending(pending);
      this.schedule();
    }
  }

  private schedule(delay = QUIET_MS): void {
    if (this.paused) return;
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
    if (this.paused) return;
    if (this.flushing !== null) {
      this.again = true;
      return this.flushing;
    }
    this.flushing = this.send().finally(() => {
      this.flushing = null;
      if (this.again) {
        this.again = false;
        this.schedule(0);
      }
    });
    return this.flushing;
  }

  private async send(): Promise<void> {
    const work = this.pending;
    this.pending = emptyPending(this.owner);
    writePending(this.pending);
    const tasks = this.tasksFor(work, useStudio.getState());
    if (tasks.length === 0) return;

    useSyncStatus.setState({ state: 'saving', message: null });
    const failed: Array<{ task: Task; error: CloudError }> = [];
    let index = 0;
    const worker = async () => {
      while (index < tasks.length) {
        const task = tasks[index];
        index += 1;
        try {
          await task.run();
        } catch (error) {
          failed.push({ task, error: error instanceof CloudError ? error : new CloudError(500, 'UNKNOWN', String(error)) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));

    if (failed.length === 0) {
      this.retryMs = 0;
      useSyncStatus.setState({ state: 'saved', lastSavedAt: Date.now(), message: null });
      return;
    }

    if (failed.some((entry) => entry.error.status === 401)) {
      for (const entry of failed) entry.task.requeue(this.pending);
      writePending(this.pending);
      await sessionExpired();
      return;
    }

    // A request the server rejected on its merits will be rejected again;
    // say so and drop it. Anything else — offline, a 5xx — is retried.
    const permanent = failed.filter((entry) => entry.error.status >= 400 && entry.error.status < 500 && entry.error.status !== 408 && entry.error.status !== 429);
    const transient = failed.filter((entry) => !permanent.includes(entry));
    for (const entry of transient) entry.task.requeue(this.pending);
    writePending(this.pending);

    if (permanent.length > 0) {
      const first = permanent[0];
      toast.error(`Could not save ${first.task.label} to your account`, { description: first.error.message });
    }
    if (transient.length > 0) {
      const offline = transient.every((entry) => entry.error.status === 0);
      this.retryMs = Math.min(60_000, this.retryMs === 0 ? 3000 : this.retryMs * 2);
      useSyncStatus.setState({
        state: offline ? 'offline' : 'error',
        message: offline ? 'Offline. Changes are kept in this browser and sent when you are back.' : transient[0].error.message,
      });
      this.schedule(this.retryMs);
    } else {
      useSyncStatus.setState({ state: 'saved', lastSavedAt: Date.now() });
    }
  }

  private tasksFor(work: Pending, state: StudioState): Task[] {
    const tasks: Task[] = [];
    for (const [id, op] of Object.entries(work.workflows)) {
      const workflow = state.workflows[id];
      const label = `“${workflow?.name ?? 'a workflow'}”`;
      if (op === 'put' && workflow !== undefined) {
        tasks.push({ label, run: () => api(`/api/workflows/${encodeURIComponent(id)}`, { method: 'PUT', body: withoutSecrets(workflow) }), requeue: (into) => requeue(into.workflows, id, 'put') });
      } else if (op === 'delete') {
        tasks.push({ label, run: () => api(`/api/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' }), requeue: (into) => requeue(into.workflows, id, 'delete') });
      }
    }
    if (work.clearRuns) {
      tasks.push({
        label: 'run history',
        run: () => api('/api/runs', { method: 'DELETE' }),
        requeue: (into) => {
          into.clearRuns = true;
        },
      });
    }
    const runsById = new Map(state.runs.map((run) => [run.id, run]));
    for (const [id, op] of Object.entries(work.runs)) {
      const run = runsById.get(id);
      if (op === 'put' && run !== undefined) {
        tasks.push({ label: `run ${run.shortId}`, run: () => api(`/api/runs/${encodeURIComponent(id)}`, { method: 'PUT', body: trimRun(run) }), requeue: (into) => requeue(into.runs, id, 'put') });
      } else if (op === 'delete') {
        tasks.push({ label: 'a run', run: () => api(`/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }), requeue: (into) => requeue(into.runs, id, 'delete') });
      }
    }
    if (work.workspace) {
      tasks.push({
        label: 'your settings',
        run: () =>
          api('/api/workspace', {
            method: 'PATCH',
            body: { settings: state.settings, brand: state.brand, connections: state.connections, toursSeen: state.toursSeen, checklistDismissed: state.checklistDismissed },
          }),
        requeue: (into) => {
          into.workspace = true;
        },
      });
    }
    return tasks;
  }

  /** Best effort as the tab goes away: small requests that the browser finishes after the page is gone. */
  private onPageHide = () => {
    const state = useStudio.getState();
    if (this.paused || state.owner !== this.owner) return;
    let budget = 60_000;
    const send = (path: string, method: string, body?: unknown) => {
      const size = body === undefined ? 0 : JSON.stringify(body).length;
      if (size > budget) return;
      budget -= size;
      void api(path, { method, body, keepalive: true }).catch(() => undefined);
    };
    for (const [id, op] of Object.entries(this.pending.workflows)) {
      if (op === 'delete') send(`/api/workflows/${encodeURIComponent(id)}`, 'DELETE');
      else if (state.workflows[id] !== undefined) send(`/api/workflows/${encodeURIComponent(id)}`, 'PUT', withoutSecrets(state.workflows[id]));
    }
    if (this.pending.workspace) {
      send('/api/workspace', 'PATCH', { settings: state.settings, brand: state.brand, connections: state.connections, toursSeen: state.toursSeen, checklistDismissed: state.checklistDismissed });
    }
    // The queue stays in localStorage: whatever did not make it goes on the next load.
  };

  private onOnline = () => {
    if (useSyncStatus.getState().pendingCount > 0) this.schedule(0);
  };
}

interface Task {
  label: string;
  run: () => Promise<unknown>;
  requeue: (into: Pending) => void;
}

/** Put a failed item back, unless something newer about it was queued meanwhile. */
function requeue(map: Record<string, Op>, id: string, op: Op): void {
  if (map[id] === undefined) map[id] = op;
}

/** Very long runs are trimmed to their last events, so they fit the server's size limit. */
function trimRun(run: Run): Run {
  return run.events.length > 4000 ? { ...run, events: run.events.slice(-4000) } : run;
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
  runs: Run[];
  shares: Record<string, string>;
}

/** Decides, once per page load, whether this is a guest or an account, and loads the account if so. */
export async function startAccount(capabilities: AuthCapabilities): Promise<void> {
  useAccount.setState({ capabilities });
  if (!capabilities.enabled) {
    useAccount.setState({ status: 'disabled' });
    return;
  }
  if (!hasSessionHint()) {
    becomeGuest();
    return;
  }
  await loadAccount();
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
      if (cachedOwner !== null) restoreGuest();
      becomeGuest();
      return;
    }
    if (failure.status === 503 && failure.code === 'ACCOUNTS_DISABLED') {
      useAccount.setState({ status: 'disabled' });
      return;
    }
    // The server is unreachable. If this browser has the account's last
    // known state, work from it and send the changes later.
    useAccount.setState({ loadError: failure.message });
    if (cachedOwner !== null) {
      const cachedUser = hintedUser();
      useAccount.setState({ status: 'signed-in', user: cachedUser !== null && cachedUser.id === cachedOwner ? cachedUser : null });
      startEngine(cachedOwner, readPending(cachedOwner));
      toast.warning('Working offline', { description: 'Your account could not be reached. Changes are kept in this browser and saved when it is back.' });
    } else {
      becomeGuest();
      toast.error('Could not load your account', { description: failure.message });
    }
    return;
  }

  const user: AccountUser = { ...payload.user, image: payload.user.image ?? null };
  const state = useStudio.getState();
  if (state.owner === null) stashGuestWork(state);
  const pending = state.owner === user.id ? readPending(user.id) : emptyPending(user.id);

  // Secret field values never reach the server; this browser's own are put back.
  const localSecrets = state.owner === user.id ? state.workflows : {};
  const workflows: Record<string, Workflow> = Object.fromEntries(payload.workflows.map((workflow) => [workflow.id, withLocalSecrets(workflow, localSecrets[workflow.id])]));
  const runs = new Map(payload.runs.map((run) => [run.id, run]));
  // Changes made here that never reached the server win over its copy.
  if (state.owner === user.id) {
    for (const [id, op] of Object.entries(pending.workflows)) {
      if (op === 'delete') delete workflows[id];
      else if (state.workflows[id] !== undefined) workflows[id] = state.workflows[id];
    }
    const local = new Map(state.runs.map((run) => [run.id, run]));
    for (const [id, op] of Object.entries(pending.runs)) {
      if (op === 'delete') runs.delete(id);
      else if (local.has(id)) runs.set(id, local.get(id)!);
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
  const workspaceLocal = state.owner === user.id && pending.workspace;
  useStudio.getState().replaceWorkspace({
    owner: user.id,
    workflows,
    runs: runList,
    connections: workspaceLocal ? state.connections : (saved.connections ?? {}),
    settings: workspaceLocal ? state.settings : { ...DEFAULT_SETTINGS, ...(saved.settings ?? {}), auth: { ...DEFAULT_SETTINGS.auth, ...(saved.settings?.auth ?? {}) } },
    brand: workspaceLocal ? state.brand : (saved.brand ?? DEFAULT_BRAND),
    toursSeen: workspaceLocal ? state.toursSeen : (saved.toursSeen ?? {}),
    checklistDismissed: workspaceLocal ? state.checklistDismissed : saved.checklistDismissed,
  });
  useAccount.setState({ status: 'signed-in', user, onboardedAt: saved.onboardedAt, onboarding: saved.onboarding, shares: payload.shares, loadError: null });
  setSessionHint(true, user);
  startEngine(user.id, pending);
  for (const id of interrupted) engine?.markRun(id);
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

/** Signs out here: sends what is queued, ends the session, and puts back what this browser had as a guest. */
export async function signOut(): Promise<void> {
  await flushNow();
  try {
    await authClient.signOut();
  } catch {
    // Signed out locally either way; the session expires on its own.
  }
  forgetAccount();
}

/** Clears every trace of the account from this browser. Used by sign-out and account deletion. */
export function forgetAccount(): void {
  engine?.stop();
  engine = null;
  setSessionHint(false);
  try {
    window.localStorage.removeItem(PENDING_KEY);
  } catch {
    // Nothing to clear.
  }
  useSyncStatus.setState({ state: 'idle', lastSavedAt: null, message: null, pendingCount: 0 });
  restoreGuest();
  becomeGuest();
}

async function sessionExpired(): Promise<void> {
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

/** Workflows from the guest backup worth offering to bring into an account: not the untouched starter examples. */
export function importableGuestWorkflows(backup: GuestBackup | null): Workflow[] {
  if (backup === null) return [];
  return backup.workflows.filter((workflow) => !(workflow.demo === true && workflow.updatedAt === workflow.createdAt)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function importGuestWorkflows(ids: string[]): Promise<{ workflows: number; skipped: string[] }> {
  const backup = readGuestBackup();
  if (backup === null || ids.length === 0) return { workflows: 0, skipped: [] };
  const chosen = backup.workflows.filter((workflow) => ids.includes(workflow.id)).map((workflow) => ({ ...workflow, demo: undefined }));
  const chosenIds = new Set(chosen.map((workflow) => workflow.id));
  const runs = backup.runs.filter((run) => chosenIds.has(run.workflowId));
  const result = await api<{ workflows: number; runs: number; skipped: string[] }>('/api/workspace/import', { method: 'POST', body: { workflows: chosen.map(withoutSecrets), runs } });
  // Show them now, without waiting for a reload.
  const studio = useStudio.getState();
  const merged = { ...studio.workflows };
  for (const workflow of chosen) merged[workflow.id] = workflow;
  const known = new Set(studio.runs.map((run) => run.id));
  useStudio.setState({ workflows: merged, runs: [...studio.runs, ...runs.filter((run) => !known.has(run.id))].sort((a, b) => b.startedAt.localeCompare(a.startedAt)) });
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
