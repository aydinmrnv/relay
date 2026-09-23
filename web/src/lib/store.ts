'use client';

import { useMemo } from 'react';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { nanoid } from 'nanoid';
import { MotionGlobalConfig } from 'motion/react';
import { brandFromName, DEFAULT_BRAND, type Brand } from './brand';
import { DEFAULT_SETTINGS, type Connection, type Run, type Settings, type Workflow, type WorkflowEdge, type WorkflowNode } from './workflow/schema';
import { instantiateTemplate, TEMPLATES } from './workflow/templates';
import { simulateRun } from './workflow/simulate';

export interface StudioState {
  hydrated: boolean;
  seeded: boolean;
  brand: Brand;
  workflows: Record<string, Workflow>;
  runs: Run[];
  connections: Record<string, Connection>;
  settings: Settings;

  setBrand: (name: string, tagline?: string) => void;
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
  connect: (connectorId: string, account: string) => void;
  disconnect: (connectorId: string) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  seedDemo: () => Promise<void>;
  resetAll: () => void;
  importAll: (payload: unknown) => { ok: boolean; message: string };
  exportAll: () => string;
  markHydrated: () => void;
}

const STORAGE_KEY = 'agent-workflow-studio';

export const useStudio = create<StudioState>()(
  persist(
    (set, get) => ({
      hydrated: false,
      seeded: false,
      brand: DEFAULT_BRAND,
      workflows: {},
      runs: [],
      connections: {},
      settings: DEFAULT_SETTINGS,
      toursSeen: {},
      checklistDismissed: false,

      markHydrated: () => set({ hydrated: true }),

      setBrand: (name, tagline) => set({ brand: brandFromName(name, tagline ?? get().brand.tagline) }),

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

      addRun: (run) => set((state) => ({ runs: [run, ...state.runs].slice(0, 200) })),
      updateRun: (run) => set((state) => ({ runs: state.runs.map((existing) => (existing.id === run.id ? run : existing)) })),
      clearRuns: () => set({ runs: [] }),
      deleteRun: (id) => set((state) => ({ runs: state.runs.filter((run) => run.id !== id) })),

      markTourSeen: (id, seen = true) => set((state) => ({ toursSeen: { ...state.toursSeen, [id]: seen } })),
      dismissChecklist: (dismissed) => set({ checklistDismissed: dismissed }),

      connect: (connectorId, account) =>
        set((state) => ({
          connections: { ...state.connections, [connectorId]: { connectorId, status: 'connected', account, connectedAt: new Date().toISOString(), mock: true } },
        })),
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
        const brand = state.brand;
        const workflows: Record<string, Workflow> = {};
        for (const template of TEMPLATES) {
          const workflow = instantiateTemplate(template.id, brand, state.settings.defaultRepository);
          if (workflow !== undefined) workflows[workflow.id] = workflow;
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

      resetAll: () => set({ workflows: {}, runs: [], connections: {}, seeded: false, settings: DEFAULT_SETTINGS, brand: DEFAULT_BRAND, toursSeen: {}, checklistDismissed: false }),

      exportAll: () => {
        const { brand, workflows, runs, connections, settings } = get();
        return JSON.stringify({ exportedAt: new Date().toISOString(), brand, workflows, runs, connections, settings }, null, 2);
      },

      importAll: (payload) => {
        if (payload === null || typeof payload !== 'object') return { ok: false, message: 'Not a JSON object.' };
        const data = payload as Record<string, unknown>;
        // A single exported workflow bundle.
        if (data['workflow'] !== undefined && typeof data['workflow'] === 'object') {
          const workflow = data['workflow'] as Workflow;
          if (typeof workflow.id !== 'string' || !Array.isArray(workflow.nodes)) return { ok: false, message: 'The workflow is missing an id or nodes.' };
          const id = get().workflows[workflow.id] === undefined ? workflow.id : `wf_${nanoid(10)}`;
          get().upsertWorkflow({ ...workflow, id, name: id === workflow.id ? workflow.name : `${workflow.name} (imported)` });
          return { ok: true, message: `Imported "${workflow.name}".` };
        }
        if (data['workflows'] !== undefined && typeof data['workflows'] === 'object') {
          const workflows = data['workflows'] as Record<string, Workflow>;
          set((state) => ({
            workflows: { ...state.workflows, ...workflows },
            runs: Array.isArray(data['runs']) ? (data['runs'] as Run[]) : state.runs,
            connections: typeof data['connections'] === 'object' && data['connections'] !== null ? (data['connections'] as Record<string, Connection>) : state.connections,
            brand: typeof data['brand'] === 'object' && data['brand'] !== null ? (data['brand'] as Brand) : state.brand,
            seeded: true,
          }));
          return { ok: true, message: `Imported ${Object.keys(workflows).length} workflow(s).` };
        }
        return { ok: false, message: 'Unrecognised file. Expected a workflow bundle or a full export.' };
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => (typeof window === 'undefined' ? (undefined as unknown as Storage) : window.localStorage)),
      partialize: (state) => ({
        seeded: state.seeded,
        brand: state.brand,
        workflows: state.workflows,
        runs: state.runs,
        connections: state.connections,
        settings: state.settings,
        toursSeen: state.toursSeen,
        checklistDismissed: state.checklistDismissed,
      }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<StudioState>;
        // A run still marked running after a reload was interrupted: the
        // simulator lived in the tab that went away. Say so instead of
        // leaving it spinning forever.
        const runs = (saved.runs ?? current.runs).map((run) =>
          run.status === 'running'
            ? { ...run, status: 'cancelled' as const, finishedAt: run.finishedAt ?? run.events.at(-1)?.at ?? run.startedAt, summary: run.summary ?? 'Interrupted: the tab was closed or reloaded while this test run was playing.' }
            : run,
        );
        return { ...current, ...saved, runs, settings: { ...DEFAULT_SETTINGS, ...(saved.settings ?? {}), auth: { ...DEFAULT_SETTINGS.auth, ...(saved.settings?.auth ?? {}) } } };
      },
      onRehydrateStorage: () => (state) => {
        // Before the first animation can start, not after the first effect.
        MotionGlobalConfig.skipAnimations = state?.settings.motion === 'reduced';
        state?.markHydrated();
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
