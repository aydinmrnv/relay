'use client';

import { useMemo } from 'react';
import { create } from 'zustand';
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware';
import { nanoid } from 'nanoid';
import { MotionGlobalConfig } from 'motion/react';
import { toast } from 'sonner';
import { BRAND } from './brand';
import { withoutSecrets } from './cloud/secrets';
import { DEFAULT_SETTINGS, type Connection, type Run, type Settings, type Workflow, type WorkflowEdge, type WorkflowNode } from './workflow/schema';
import { instantiateTemplate, TEMPLATES } from './workflow/templates';
import { simulateRun } from './workflow/simulate';
import { repairEdges, repairKnownTemplateIssues } from './workflow/repair';

/** How many runs a browser keeps. The account keeps its own, on its own limit. */
export const MAX_RUNS = 200;
/** How many timeline events a run keeps: enough for an hour-long run, and small enough to store and send. */
export const MAX_RUN_EVENTS = 4000;

/** What an import would do, worked out before anything changes, so the person can be asked first. */
export interface ImportPlan {
  /** A single workflow from Export in the builder, or a whole studio export. */
  kind: 'workflow' | 'workspace';
  workflows: Workflow[];
  runs: Run[];
  /** Markers only: a real connection belongs to the account that made it. */
  connections: Record<string, Connection>;
  /** Ids in `workflows` that are already here. */
  clashes: string[];
  /** Runs in the file that are not here yet. */
  newRuns: number;
  /** Workflows and runs in the file that were left out because they are not in a shape the studio can draw. */
  rejected: number;
}

/** What to do with imported workflows whose id is already here. */
export type ClashChoice = 'replace' | 'copy' | 'skip';

/** A whole workspace, as the server hands it over after signing in. */
export interface WorkspaceSnapshot {
  owner: string;
  workflows: Record<string, Workflow>;
  runs: Run[];
  connections: Record<string, Connection>;
  settings: Settings;
  toursSeen: Record<string, boolean>;
  checklistDismissed: boolean;
}

export interface StudioState {
  hydrated: boolean;
  /**
   * Set when what this browser had saved could not be read back in full: how
   * many workflows and runs were left out, or `unreadable` when none of it
   * could be used. The studio still starts; a notice offers a reset.
   */
  storageProblem: { dropped: number } | 'unreadable' | null;
  /**
   * Runs dropped here by the `MAX_RUNS` cap, not by the person. The account
   * keeps them: sync must not read a trim as a delete.
   */
  trimmedRuns: ReadonlySet<string>;
  seeded: boolean;
  /**
   * Whose workspace this is: a user id when it mirrors an account, `null` for
   * a guest whose work lives only in this browser. Persisted, so a reload
   * shows the account's last-known state while the server is asked again.
   */
  owner: string | null;
  /**
   * Bumped by "Clear run history" (and a full reset), so an account's sync
   * can tell clearing every run apart from deleting the last one.
   */
  runsClearedAt: number;
  workflows: Record<string, Workflow>;
  runs: Run[];
  connections: Record<string, Connection>;
  settings: Settings;

  upsertWorkflow: (workflow: Workflow) => void;
  setGraph: (id: string, nodes: WorkflowNode[], edges: WorkflowEdge[]) => void;
  renameWorkflow: (id: string, name: string, description?: string) => void;
  updateWorkflowMeta: (id: string, patch: Partial<Pick<Workflow, 'name' | 'description' | 'repository'>>) => void;
  markExported: (id: string) => void;
  toggleWorkflow: (id: string, enabled: boolean) => void;
  deleteWorkflow: (id: string) => void;
  duplicateWorkflow: (id: string) => Workflow | undefined;
  addRun: (run: Run) => void;
  updateRun: (run: Run) => void;
  clearRuns: () => void;
  deleteRun: (id: string) => void;
  /** Guided tours already seen, by id, so each shows once. */
  toursSeen: Record<string, boolean>;
  markTourSeen: (id: string, seen?: boolean) => void;
  checklistDismissed: boolean;
  dismissChecklist: (dismissed: boolean) => void;
  /** Marks an app ready: a label, with nothing signed in to. */
  connect: (connectorId: string, account: string) => void;
  /** Keeps a real connection as the server described it. */
  setConnection: (connection: Connection) => void;
  disconnect: (connectorId: string) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  seedDemo: () => Promise<void>;
  resetAll: () => void;
  /** Swap in an account's workspace, replacing whatever this browser held. */
  replaceWorkspace: (snapshot: WorkspaceSnapshot) => void;
  /** Back to an empty guest workspace, e.g. after signing out on a shared computer. */
  resetToGuest: () => void;
  /** Carries out an import somebody has seen the plan for. Adds; never removes a run or a workflow. */
  applyImport: (plan: ImportPlan, clashes: ClashChoice) => string;
  exportAll: () => string;
  markHydrated: () => void;
}

export const STORAGE_KEY = 'agent-workflow-studio';

/** What is written to localStorage. */
type Persisted = Pick<StudioState, 'seeded' | 'owner' | 'workflows' | 'runs' | 'connections' | 'settings' | 'toursSeen' | 'checklistDismissed'>;

/* ------------------------------------------------------------------ */
/* Saving to this browser                                              */
/* ------------------------------------------------------------------ */

/**
 * localStorage, written at most twice a second.
 *
 * The store changes on every keystroke in a field and on every line of a run;
 * serialising the whole studio each time blocks the page for longer the more
 * runs there are. So a write waits half a second and takes whatever is newest
 * then, and a tab that is going away writes at once. A write the browser
 * refuses (the 5 MB quota) is retried once without run timelines, which are
 * most of the weight, and the person is told once rather than on every change.
 */
function browserStorage(): PersistStorage<Persisted> {
  let pending: { name: string; value: StorageValue<Persisted> } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let warned = false;

  const write = (name: string, value: StorageValue<Persisted>) => {
    try {
      window.localStorage.setItem(name, JSON.stringify(value));
      warned = false;
      return;
    } catch {
      // Full, or storage is unavailable (private mode, a blocked site): try the lighter copy.
    }
    try {
      const lighter = { ...value, state: { ...value.state, runs: value.state.runs.map((run) => ({ ...run, events: run.events.slice(-50) })) } };
      window.localStorage.setItem(name, JSON.stringify(lighter));
    } catch {
      // Nothing fits. The tab still has everything; say what that means.
    }
    if (!warned) {
      warned = true;
      toast.warning('This browser’s storage is full', {
        description: 'Your work is still here in this tab, but run timelines may not survive a reload. Clear old runs under Runs to make room.',
        duration: 12_000,
      });
    }
  };

  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (pending === null) return;
    const { name, value } = pending;
    pending = null;
    write(name, value);
  };
  flushStorage = flush;

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    // Another tab saved. A guest's work lives only here, so take theirs
    // rather than write an older copy over it later. An account's tabs each
    // answer to the server instead, which keeps both sides of a conflict.
    window.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_KEY || event.newValue === null) return;
      if (useStudio.getState().owner !== null) return;
      pending = null;
      void useStudio.persist.rehydrate();
    });
  }

  return {
    getItem: (name) => {
      const raw = window.localStorage.getItem(name);
      if (raw === null) return null;
      return JSON.parse(raw) as StorageValue<Persisted>;
    },
    setItem: (name, value) => {
      pending = { name, value };
      if (timer === null) timer = setTimeout(flush, 500);
    },
    removeItem: (name) => {
      pending = null;
      window.localStorage.removeItem(name);
    },
  };
}

/** Writes what is waiting to this browser's storage now. For a change made as the page is going away. */
export let flushStorage: () => void = () => undefined;

/** Forgets everything this browser saved for the studio and starts it again. The account, if any, is untouched. */
export function resetLocalData(): void {
  try {
    useStudio.persist.clearStorage();
  } catch {
    // Nothing to clear.
  }
  window.location.reload();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Enough of a workflow for every screen to draw it without throwing. */
function workflowUsable(value: unknown): value is Workflow {
  if (!isRecord(value) || typeof value['id'] !== 'string' || typeof value['name'] !== 'string') return false;
  if (!Array.isArray(value['nodes']) || !Array.isArray(value['edges'])) return false;
  if (typeof value['createdAt'] !== 'string' || typeof value['updatedAt'] !== 'string') return false;
  const nodesOk = value['nodes'].every((node) => isRecord(node) && typeof node['id'] === 'string' && isRecord(node['position']) && isRecord(node['data']) && typeof node['data']['typeId'] === 'string' && isRecord(node['data']['config']));
  const edgesOk = value['edges'].every((edge) => isRecord(edge) && typeof edge['id'] === 'string' && typeof edge['source'] === 'string' && typeof edge['target'] === 'string');
  return nodesOk && edgesOk;
}

/** Enough of a run for the runs list, the dashboard and the run page. */
function runUsable(value: unknown): value is Run {
  if (!isRecord(value) || typeof value['id'] !== 'string' || typeof value['workflowId'] !== 'string' || typeof value['startedAt'] !== 'string') return false;
  return Array.isArray(value['events']) && Array.isArray(value['phases']) && isRecord(value['nodeStatus']) && isRecord(value['trigger']) && isRecord(value['trigger']['payload']) && typeof value['costUsd'] === 'number';
}

function capEvents(run: Run): Run {
  return run.events.length > MAX_RUN_EVENTS ? { ...run, events: run.events.slice(-MAX_RUN_EVENTS) } : run;
}

export const useStudio = create<StudioState>()(
  persist(
    (set, get) => ({
      hydrated: false,
      storageProblem: null,
      trimmedRuns: new Set<string>(),
      seeded: false,
      owner: null,
      runsClearedAt: 0,
      workflows: {},
      runs: [],
      connections: {},
      settings: DEFAULT_SETTINGS,
      toursSeen: {},
      checklistDismissed: false,

      markHydrated: () => set({ hydrated: true }),

      upsertWorkflow: (workflow) =>
        set((state) => ({ workflows: { ...state.workflows, [workflow.id]: { ...workflow, updatedAt: new Date().toISOString() } } })),

      setGraph: (id, nodes, edges) =>
        set((state) => {
          const existing = state.workflows[id];
          if (existing === undefined) return {};
          return { workflows: { ...state.workflows, [id]: { ...existing, nodes, edges, updatedAt: new Date().toISOString() } } };
        }),

      renameWorkflow: (id, name, description) =>
        set((state) => {
          const existing = state.workflows[id];
          if (existing === undefined) return {};
          return { workflows: { ...state.workflows, [id]: { ...existing, name, description: description ?? existing.description, updatedAt: new Date().toISOString() } } };
        }),

      updateWorkflowMeta: (id, patch) =>
        set((state) => {
          const existing = state.workflows[id];
          if (existing === undefined) return {};
          return { workflows: { ...state.workflows, [id]: { ...existing, ...patch, updatedAt: new Date().toISOString() } } };
        }),

      markExported: (id) =>
        set((state) => {
          const existing = state.workflows[id];
          if (existing === undefined) return {};
          return { workflows: { ...state.workflows, [id]: { ...existing, exportedAt: new Date().toISOString() } } };
        }),

      toggleWorkflow: (id, enabled) =>
        set((state) => {
          const existing = state.workflows[id];
          if (existing === undefined) return {};
          return { workflows: { ...state.workflows, [id]: { ...existing, enabled } } };
        }),

      deleteWorkflow: (id) =>
        set((state) => {
          const workflows = { ...state.workflows };
          delete workflows[id];
          return { workflows, runs: state.runs.filter((run) => run.workflowId !== id) };
        }),

      duplicateWorkflow: (id) => {
        const source = get().workflows[id];
        if (source === undefined) return undefined;
        const now = new Date().toISOString();
        const copy: Workflow = { ...source, id: `wf_${nanoid(10)}`, name: `${source.name} (copy)`, createdAt: now, updatedAt: now, enabled: false };
        set((state) => ({ workflows: { ...state.workflows, [copy.id]: copy } }));
        return copy;
      },

      addRun: (run) =>
        set((state) => {
          const runs = [capEvents(run), ...state.runs];
          if (runs.length <= MAX_RUNS) return { runs };
          return { runs: runs.slice(0, MAX_RUNS), trimmedRuns: new Set([...state.trimmedRuns, ...runs.slice(MAX_RUNS).map((dropped) => dropped.id)]) };
        }),
      updateRun: (run) =>
        set((state) => {
          const kept = capEvents(run);
          return { runs: state.runs.map((existing) => (existing.id === run.id ? kept : existing)) };
        }),
      clearRuns: () => set({ runs: [], runsClearedAt: Date.now() }),
      deleteRun: (id) => set((state) => ({ runs: state.runs.filter((run) => run.id !== id) })),

      markTourSeen: (id, seen = true) => set((state) => ({ toursSeen: { ...state.toursSeen, [id]: seen } })),
      dismissChecklist: (dismissed) => set({ checklistDismissed: dismissed }),

      connect: (connectorId, account) =>
        set((state) => ({
          connections: { ...state.connections, [connectorId]: { connectorId, status: 'connected', account, connectedAt: new Date().toISOString(), mock: true } },
        })),
      setConnection: (connection) => set((state) => ({ connections: { ...state.connections, [connection.connectorId]: connection } })),
      disconnect: (connectorId) =>
        set((state) => {
          const connections = { ...state.connections };
          delete connections[connectorId];
          return { connections };
        }),

      updateSettings: (patch) => set((state) => ({ settings: { ...state.settings, ...patch } })),

      seedDemo: async () => {
        const state = get();
        if (state.seeded) return;
        const brand = BRAND;
        const workflows: Record<string, Workflow> = {};
        for (const template of TEMPLATES) {
          const workflow = instantiateTemplate(template.id, brand, state.settings.defaultRepository);
          if (workflow !== undefined) workflows[workflow.id] = { ...workflow, demo: true };
        }
        const runs: Run[] = [];
        const list = Object.values(workflows);
        let seed = 7;
        for (const workflow of list.slice(0, 4)) {
          for (let i = 0; i < (workflow.templateId === 'ticket-to-pr' ? 3 : 1); i += 1) {
            seed += 13;
            const run = await simulateRun(workflow, { speed: 'instant', seed, brand, repository: workflow.repository });
            // Spread the demo runs over the last few days so the dashboard has a shape.
            const ago = (runs.length + 1) * 7 * 3600 * 1000 + seed * 60_000;
            run.startedAt = new Date(Date.now() - ago).toISOString();
            run.finishedAt = new Date(Date.now() - ago + 18 * 60_000).toISOString();
            runs.push(run);
          }
        }
        const connections: Record<string, Connection> = {};
        for (const id of ['github', 'linear', 'slack']) {
          connections[id] = { connectorId: id, status: 'connected', account: id === 'github' ? 'acme' : id === 'linear' ? 'Acme Engineering' : 'acme.slack.com', connectedAt: new Date(Date.now() - 86_400_000 * 3).toISOString(), mock: true };
        }
        set({ workflows, runs, connections, seeded: true });
      },

      // Signed in, an empty workspace stays empty: seeding is for guests.
      resetAll: () =>
        set((state) => ({ workflows: {}, runs: [], runsClearedAt: Date.now(), connections: {}, seeded: state.owner !== null, settings: DEFAULT_SETTINGS, toursSeen: {}, checklistDismissed: false })),

      replaceWorkspace: (snapshot) =>
        set({
          owner: snapshot.owner,
          seeded: true,
          workflows: snapshot.workflows,
          runs: snapshot.runs,
          connections: snapshot.connections,
          settings: snapshot.settings,
          toursSeen: snapshot.toursSeen,
          checklistDismissed: snapshot.checklistDismissed,
        }),

      resetToGuest: () => set({ owner: null, seeded: false, workflows: {}, runs: [], connections: {}, settings: DEFAULT_SETTINGS, toursSeen: {}, checklistDismissed: false }),

      // Secret fields stay in the browser they were typed in: a backup file is something people email and commit.
      exportAll: () => {
        const { workflows, runs, connections, settings } = get();
        const safe = Object.fromEntries(Object.entries(workflows).map(([id, workflow]) => [id, withoutSecrets(workflow)]));
        return JSON.stringify({ exportedAt: new Date().toISOString(), workflows: safe, runs, connections, settings }, null, 2);
      },

      applyImport: (plan, clashes) => {
        const state = get();
        const workflows = { ...state.workflows };
        let added = 0;
        let replaced = 0;
        let copied = 0;
        for (const workflow of plan.workflows) {
          const incoming = repairKnownTemplateIssues(repairEdges({ ...workflow, demo: undefined }));
          if (workflows[incoming.id] === undefined) {
            workflows[incoming.id] = incoming;
            added += 1;
          } else if (clashes === 'replace') {
            workflows[incoming.id] = { ...incoming, updatedAt: new Date().toISOString() };
            replaced += 1;
          } else if (clashes === 'copy') {
            const id = `wf_${nanoid(10)}`;
            workflows[id] = { ...incoming, id, name: `${incoming.name} (imported)`, enabled: false, updatedAt: new Date().toISOString() };
            copied += 1;
          }
        }
        // Runs are only ever added: the ones already here stay, whatever the file holds.
        const known = new Set(state.runs.map((run) => run.id));
        const fresh = plan.runs.filter((run) => !known.has(run.id) && workflows[run.workflowId] !== undefined).map(capEvents);
        const merged = [...state.runs, ...fresh].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
        const trimmed = merged.slice(MAX_RUNS).map((run) => run.id);
        set({
          workflows,
          runs: merged.slice(0, MAX_RUNS),
          trimmedRuns: trimmed.length === 0 ? state.trimmedRuns : new Set([...state.trimmedRuns, ...trimmed]),
          // An app already connected here stays as it is; the file can only add markers for the rest.
          connections: { ...plan.connections, ...state.connections },
          seeded: true,
        });
        const parts = [
          added > 0 ? `${added} new` : null,
          replaced > 0 ? `${replaced} replaced` : null,
          copied > 0 ? `${copied} added as ${copied === 1 ? 'a copy' : 'copies'}` : null,
        ].filter(Boolean);
        const count = added + replaced + copied;
        if (plan.kind === 'workflow' && count === 1) return `Imported “${plan.workflows[0]!.name}”${copied === 1 ? ' as a copy' : ''}.`;
        return `Imported ${count} ${count === 1 ? 'workflow' : 'workflows'}${parts.length > 1 || replaced + copied > 0 ? ` (${parts.join(', ')})` : ''}${fresh.length > 0 ? ` and ${fresh.length} ${fresh.length === 1 ? 'run' : 'runs'}` : ''}.`;
      },
    }),
    {
      name: STORAGE_KEY,
      version: 2,
      storage: typeof window === 'undefined' ? undefined : browserStorage(),
      partialize: (state): Persisted => ({
        seeded: state.seeded,
        owner: state.owner,
        workflows: state.workflows,
        runs: state.runs,
        connections: state.connections,
        settings: state.settings,
        toursSeen: state.toursSeen,
        checklistDismissed: state.checklistDismissed,
      }),
      // Version 1 (and the unversioned saves before it) kept a product name
      // people could change, and attached new workflows to a made-up
      // repository. Neither exists any more.
      migrate: (persisted, version) => {
        const saved = (isRecord(persisted) ? { ...persisted } : {}) as Record<string, unknown>;
        if (version < 2) {
          delete saved['brand'];
          if (isRecord(saved['settings']) && saved['settings']['defaultRepository'] === 'acme/api') saved['settings'] = { ...saved['settings'], defaultRepository: '' };
          if (isRecord(saved['workflows'])) {
            saved['workflows'] = Object.fromEntries(
              Object.entries(saved['workflows']).map(([id, workflow]) => [id, isRecord(workflow) && workflow['repository'] === 'acme/api' ? { ...workflow, repository: '' } : workflow]),
            );
          }
        }
        return saved as Persisted;
      },
      // What was saved is data from another time: an older build, a file
      // somebody imported, a write cut short by a full disk. One bad workflow
      // must not take the studio down with it, so each is checked and
      // repaired on its own and left out if it cannot be drawn.
      merge: (persisted, current) => {
        try {
          const saved = (isRecord(persisted) ? persisted : {}) as Partial<Persisted>;
          let dropped = 0;
          const workflows: Record<string, Workflow> = {};
          for (const [id, workflow] of Object.entries(isRecord(saved.workflows) ? saved.workflows : {})) {
            try {
              if (!workflowUsable(workflow)) throw new Error('not a workflow');
              workflows[id] = repairKnownTemplateIssues(repairEdges(workflow));
            } catch {
              dropped += 1;
            }
          }
          const runs: Run[] = [];
          for (const run of Array.isArray(saved.runs) ? saved.runs : []) {
            if (!runUsable(run)) {
              dropped += 1;
              continue;
            }
            // A test run still marked running after a reload was interrupted: the
            // simulator lived in the tab that went away. Say so instead of
            // leaving it spinning forever. A run on the paired machine did not
            // live here, and is picked back up once the machine answers.
            runs.push(
              run.status === 'running' && run.source !== 'machine'
                ? { ...run, status: 'cancelled' as const, finishedAt: run.finishedAt ?? run.events.at(-1)?.at ?? run.startedAt, summary: run.summary ?? 'Interrupted: the tab was closed or reloaded while this test run was playing.' }
                : run,
            );
          }
          const settings = isRecord(saved.settings) ? (saved.settings as Partial<Settings>) : {};
          return {
            ...current,
            seeded: saved.seeded === true,
            owner: typeof saved.owner === 'string' ? saved.owner : null,
            workflows,
            runs,
            connections: isRecord(saved.connections) ? (saved.connections as Record<string, Connection>) : {},
            settings: { ...DEFAULT_SETTINGS, ...settings, auth: { ...DEFAULT_SETTINGS.auth, ...(isRecord(settings.auth) ? settings.auth : {}) } },
            toursSeen: isRecord(saved.toursSeen) ? (saved.toursSeen as Record<string, boolean>) : {},
            checklistDismissed: saved.checklistDismissed === true,
            storageProblem: dropped > 0 ? { dropped } : null,
          };
        } catch {
          return { ...current, storageProblem: 'unreadable' as const };
        }
      },
      onRehydrateStorage: () => (state, error) => {
        if (state === undefined || error !== undefined) {
          // The saved copy could not be parsed at all. Start empty rather than
          // never start: nothing on the page draws until the store says it is
          // hydrated. The store may not be assigned yet, hence the microtask.
          queueMicrotask(() => useStudio.setState({ hydrated: true, storageProblem: 'unreadable' }));
          return;
        }
        // Before the first animation can start, not after the first effect.
        MotionGlobalConfig.skipAnimations = state.settings.motion === 'reduced';
        state.markHydrated();
      },
    },
  ),
);

/** Sorted newest first. Memoised on the map reference, because a selector that
 * returns a fresh array on every call is an infinite loop under useSyncExternalStore. */
export function useWorkflows(): Workflow[] {
  const map = useStudio((state) => state.workflows);
  return useMemo(() => Object.values(map).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [map]);
}
