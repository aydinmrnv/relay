'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ReactFlowProvider, addEdge, applyEdgeChanges, applyNodeChanges, useReactFlow, type EdgeChange, type NodeChange, type OnConnect } from '@xyflow/react';
import { nanoid } from 'nanoid';
import { AlertTriangle, Check, ChevronDown, CircleAlert, CircleDollarSign, Cloud, FileCode2, FileJson, Globe, History, Laptop, LayoutTemplate, Loader2, PanelLeft, PanelRight, Play, Plug, Plus, Redo2, Sparkles, Undo2, Wand2, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Kbd } from '@/components/ui/kbd';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { HelpTip } from '@/components/app/help-tip';
import { defaultConfig, getNodeType, type NodeTypeDef, type PortSpec } from '@/lib/connectors';
import { useStudio } from '@/lib/store';
import { useAccount } from '@/lib/cloud/account';
import { useSyncStatus } from '@/lib/cloud/sync';
import { useSignedIn } from '@/hooks/use-agent-accounts';
import { validateWorkflow, type ValidationIssue } from '@/lib/workflow/validate';
import { launchRun, launchMachineRun, cancelRun } from '@/lib/run-launcher';
import { useCompanion, useCompanionCan } from '@/lib/companion/client';
import type { RunTask } from '@/lib/companion/types';
import { isTypingTarget } from '@/lib/shortcuts';
import type { Run, RunEvent, Workflow, WorkflowEdge, WorkflowNode } from '@/lib/workflow/schema';
import { cn } from '@/lib/utils';
import { Canvas } from './canvas';
import { Palette } from './palette';
import { Inspector } from './inspector';
import { RunPanel } from './run-panel';
import { ExportDialog } from './export-dialog';
import { PayloadDialog } from './payload-dialog';
import { MachineRunDialog } from './machine-run-dialog';
import { ShareDialog } from './share-dialog';
import { HistorySheet } from './history-sheet';
import { ForecastDialog } from './forecast-dialog';
import { BuilderTour } from './builder-tour';
import { NodePicker, compatibleInput, type PickerSource } from './node-picker';
import { BuilderActionsContext, type BuilderActions } from './builder-context';
import { fromCanvas, toCanvasEdges, toCanvasNodes, type CanvasEdge, type CanvasNode, type EdgeRunState } from './types';

export function Builder({ workflowId }: { workflowId: string }) {
  return (
    <ReactFlowProvider>
      <BuilderInner workflowId={workflowId} />
    </ReactFlowProvider>
  );
}

interface Snapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/** Copied nodes survive switching workflows in the same tab, like any clipboard. */
let clipboard: { nodes: WorkflowNode[]; edges: WorkflowEdge[] } | null = null;

const COLUMN = 340;
const ROW = 170;

/** A node's saved shape, without the run colours and validation marks the canvas adds. */
function clean(node: CanvasNode): CanvasNode {
  const { status: _status, phase: _phase, invalid: _invalid, ...data } = node.data;
  void _status;
  void _phase;
  void _invalid;
  return { ...node, data };
}

function BuilderInner({ workflowId }: { workflowId: string }) {
  const saved = useStudio((state) => state.workflows[workflowId]);
  const setGraph = useStudio((state) => state.setGraph);
  const renameWorkflow = useStudio((state) => state.renameWorkflow);
  const toggleWorkflow = useStudio((state) => state.toggleWorkflow);
  const toursSeen = useStudio((state) => state.toursSeen);
  const markTourSeen = useStudio((state) => state.markTourSeen);
  const speed = useStudio((state) => state.settings.simulationSpeed);
  const signedIn = useSignedIn();
  const signedInKey = `${signedIn.claude}|${signedIn.codex}`;
  const { fitView, screenToFlowPosition, setCenter, getZoom } = useReactFlow();
  // On a phone there is no room beside the canvas, so the side panels slide over it instead.
  const mobile = useIsMobile();

  const [nodes, setNodes] = useState<CanvasNode[]>(() => toCanvasNodes(saved?.nodes ?? []));
  const [edges, setEdges] = useState<CanvasEdge[]>(() => toCanvasEdges(saved?.edges ?? []));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Side panels start open only where the canvas still has room to be read;
  // the settings panel opens by itself as soon as a node is selected.
  const [showPalette, setShowPalette] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1200);
  const [showInspector, setShowInspector] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 1680);
  const [exportOpen, setExportOpen] = useState(false);
  const [payloadOpen, setPayloadOpen] = useState(false);
  const [machineOpen, setMachineOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [forecastOpen, setForecastOpen] = useState(false);
  const cloudTarget = useCompanion((state) => state.target === 'cloud' && state.cloudHub !== null);
  const machineCanRun = useCompanionCan('runs');
  // A cloud machine that is asleep can still be picked: the dialog offers to start it.
  const canRunOnMachine = cloudTarget || machineCanRun;
  const machineHost = useCompanion((state) => state.hello?.machine);
  const [picker, setPicker] = useState<{ open: boolean; source: PickerSource | null; position: { x: number; y: number } | null }>({ open: false, source: null, position: null });
  const [runOpen, setRunOpen] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [running, setRunning] = useState(false);
  const [showRunState, setShowRunState] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [history, setHistory] = useState({ past: 0, future: 0 });

  const canvasRef = useRef<HTMLDivElement>(null);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const lastCommit = useRef(0);
  const committedFrom = useRef<{ nodes: CanvasNode[] | null; edges: CanvasEdge[] | null }>({ nodes: null, edges: null });
  const runIdRef = useRef<string | null>(null);

  useEffect(() => {
    nodesRef.current = nodes;
    edgesRef.current = edges;
  }, [nodes, edges]);

  // The saved graph is the source of truth; the canvas is a working copy that
  // writes back after a short pause so dragging does not thrash the store.
  useEffect(() => {
    if (!dirty || saved === undefined) return;
    const handle = setTimeout(() => {
      const graph = fromCanvas(nodes, edges);
      setGraph(saved.id, graph.nodes, graph.edges);
      setDirty(false);
    }, 400);
    return () => clearTimeout(handle);
  }, [dirty, nodes, edges, saved, setGraph]);

  /* ---------------------------------------------------------------- */
  /* Undo / redo                                                        */
  /* ---------------------------------------------------------------- */

  /** Remember the graph as it is now, before a change. `coalesce` folds a burst of edits (typing) into one step. */
  const commit = useCallback((coalesce = false) => {
    const now = Date.now();
    const recent = now - lastCommit.current < 900;
    lastCommit.current = now;
    if (coalesce && recent) return;
    // One gesture can report several changes before the graph re-renders (a
    // Backspace removes nodes, then their edges); remember that graph once.
    if (committedFrom.current.nodes === nodesRef.current && committedFrom.current.edges === edgesRef.current) return;
    committedFrom.current = { nodes: nodesRef.current, edges: edgesRef.current };
    past.current.push({ nodes: nodesRef.current.map(clean), edges: edgesRef.current });
    if (past.current.length > 100) past.current.shift();
    future.current = [];
    setHistory({ past: past.current.length, future: 0 });
  }, []);

  const undo = useCallback(() => {
    const previous = past.current.pop();
    if (previous === undefined) return;
    future.current.push({ nodes: nodesRef.current.map(clean), edges: edgesRef.current });
    setNodes(previous.nodes);
    setEdges(previous.edges);
    setHistory({ past: past.current.length, future: future.current.length });
    setDirty(true);
  }, []);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (next === undefined) return;
    past.current.push({ nodes: nodesRef.current.map(clean), edges: edgesRef.current });
    setNodes(next.nodes);
    setEdges(next.edges);
    setHistory({ past: past.current.length, future: future.current.length });
    setDirty(true);
  }, []);

  /* ---------------------------------------------------------------- */
  /* Derived state                                                      */
  /* ---------------------------------------------------------------- */

  const workflow: Workflow | null = useMemo(() => {
    if (saved === undefined) return null;
    const graph = fromCanvas(nodes, edges);
    return { ...saved, nodes: graph.nodes, edges: graph.edges };
  }, [saved, nodes, edges]);

  const validation = useMemo(
    () => (workflow === null ? null : validateWorkflow(workflow, { signedIn: Object.keys(signedIn).length > 0 ? signedIn : undefined })),
    // signedInKey folds the two booleans into one stable dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workflow, signedInKey],
  );

  // Mark invalid nodes so the canvas can ring them.
  const decoratedNodes = useMemo(() => {
    const invalid = new Set((validation?.issues ?? []).filter((issue) => issue.level === 'error' && issue.nodeId !== undefined).map((issue) => issue.nodeId!));
    return nodes.map((node) => ((node.data.invalid === true) === invalid.has(node.id) ? node : { ...node, data: { ...node.data, invalid: invalid.has(node.id) } }));
  }, [nodes, validation]);

  // Name branch edges after the output they leave from, and colour the path a run took.
  const decoratedEdges = useMemo(() => {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    return edges.map((edge) => {
      const source = byId.get(edge.source);
      const def = source === undefined ? undefined : getNodeType(source.data.typeId);
      const branch = def !== undefined && def.outputs.length > 1 ? def.outputs.find((port) => port.id === (edge.sourceHandle ?? def.outputs[0]?.id))?.label : undefined;
      let state: EdgeRunState | undefined;
      if (showRunState) {
        const from = source?.data.status;
        const to = byId.get(edge.target)?.data.status;
        const left = from === 'done' || from === 'refused' || from === 'waiting';
        if (left && to === 'running') state = 'active';
        else if (left && (to === 'done' || to === 'failed' || to === 'refused' || to === 'waiting')) state = to === 'refused' ? 'refused' : 'travelled';
        else if (to === 'skipped' || (!running && from !== undefined && to === 'pending')) state = 'skipped';
      }
      if (edge.data?.branch === branch && edge.data?.state === state) return edge;
      return { ...edge, data: { ...edge.data, branch, state } };
    });
  }, [nodes, edges, showRunState, running]);

  const hasTrigger = nodes.some((node) => getNodeType(node.data.typeId)?.kind === 'trigger');
  const selected = decoratedNodes.find((node) => node.id === selectedId) ?? null;

  /* ---------------------------------------------------------------- */
  /* Editing                                                            */
  /* ---------------------------------------------------------------- */

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      if (changes.some((change) => change.type === 'remove')) commit();
      setNodes((current) => applyNodeChanges(changes, current));
      if (changes.some((change) => change.type !== 'select' && change.type !== 'dimensions')) setDirty(true);
    },
    [commit],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<CanvasEdge>[]) => {
      if (changes.some((change) => change.type === 'remove')) commit();
      setEdges((current) => applyEdgeChanges(changes, current));
      if (changes.some((change) => change.type !== 'select')) setDirty(true);
    },
    [commit],
  );

  const onConnect: OnConnect = useCallback(
    (connection) => {
      commit();
      setEdges((current) => addEdge({ ...connection, id: `e_${nanoid(8)}`, type: 'wf' }, current));
      setDirty(true);
    },
    [commit],
  );

  const selectNode = useCallback(
    (nodeId: string | null, focus = false) => {
      setSelectedId(nodeId);
      setNodes((current) => current.map((node) => (node.selected === (node.id === nodeId) ? node : { ...node, selected: node.id === nodeId })));
      if (nodeId !== null && focus) void fitView({ nodes: [{ id: nodeId }], duration: 400, maxZoom: 1, padding: 0.6 });
      if (nodeId !== null) setShowInspector(true);
    },
    [fitView],
  );

  /** Where a new node goes after `sourceId`: one column right, below any siblings already there. */
  const placeAfter = useCallback((sourceId: string): { x: number; y: number } => {
    const source = nodesRef.current.find((node) => node.id === sourceId);
    if (source === undefined) return { x: 120, y: 200 };
    const siblings = edgesRef.current.filter((edge) => edge.source === sourceId).length;
    return { x: source.position.x + COLUMN, y: source.position.y + siblings * ROW };
  }, []);

  /** Centre of what is on screen, in canvas coordinates. */
  const viewportCentre = useCallback((): { x: number; y: number } => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (rect === undefined) return { x: 120, y: 200 };
    const point = screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    return { x: point.x - 136, y: point.y - 40 };
  }, [screenToFlowPosition]);

  const addNode = useCallback(
    (def: NodeTypeDef, position?: { x: number; y: number }, from?: { nodeId: string; port: PortSpec }) => {
      commit();
      const id = `n_${nanoid(8)}`;
      const at = position ?? (from !== undefined ? placeAfter(from.nodeId) : viewportCentre());
      const created: CanvasNode = { id, type: 'wf', position: at, data: { typeId: def.id, config: defaultConfig(def) }, selected: true };
      setNodes((current) => [...current.map((node) => (node.selected === true ? { ...node, selected: false } : node)), created]);
      if (from !== undefined) {
        const input = compatibleInput(def, from.port);
        if (input !== undefined) {
          setEdges((current) => [...current, { id: `e_${nanoid(8)}`, type: 'wf', source: from.nodeId, sourceHandle: from.port.id, target: id, targetHandle: input.id }]);
        }
      }
      setSelectedId(id);
      setShowInspector(true);
      setDirty(true);
      // A node placed by the builder rather than by a drop may land off screen; bring it into view.
      if (position === undefined) setTimeout(() => void setCenter(at.x + 136, at.y + 40, { zoom: Math.max(getZoom(), 0.7), duration: 350 }), 30);
    },
    [commit, placeAfter, viewportCentre, setCenter, getZoom],
  );

  /** Palette click: add next to the selected node, connected, when the two fit; otherwise in view. */
  const addFromPalette = useCallback(
    (def: NodeTypeDef) => {
      const source = selectedId === null ? undefined : nodesRef.current.find((node) => node.id === selectedId);
      const sourceDef = source === undefined ? undefined : getNodeType(source.data.typeId);
      if (source !== undefined && sourceDef !== undefined && def.kind === 'action') {
        const port = sourceDef.outputs.find((candidate) => compatibleInput(def, candidate) !== undefined);
        if (port !== undefined) {
          addNode(def, undefined, { nodeId: source.id, port });
          return;
        }
      }
      addNode(def);
    },
    [addNode, selectedId],
  );

  const updateNode = useCallback(
    (nodeId: string, patch: { label?: string | null; config?: Record<string, unknown> }) => {
      commit(true);
      setNodes((current) =>
        current.map((node) => {
          if (node.id !== nodeId) return node;
          const data = { ...node.data };
          if (patch.label !== undefined) {
            if (patch.label === null) delete data.label;
            else data.label = patch.label;
          }
          if (patch.config !== undefined) data.config = patch.config;
          return { ...node, data };
        }),
      );
      setDirty(true);
    },
    [commit],
  );

  const deleteNode = useCallback(
    (nodeId: string) => {
      commit();
      setNodes((current) => current.filter((node) => node.id !== nodeId));
      setEdges((current) => current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId));
      setSelectedId((current) => (current === nodeId ? null : current));
      setDirty(true);
    },
    [commit],
  );

  const removeEdge = useCallback(
    (edgeId: string) => {
      commit();
      setEdges((current) => current.filter((edge) => edge.id !== edgeId));
      setDirty(true);
    },
    [commit],
  );

  const pasteNodes = useCallback(
    (payload: { nodes: WorkflowNode[]; edges: WorkflowEdge[] }, offset = 48) => {
      commit();
      const ids = new Map(payload.nodes.map((node) => [node.id, `n_${nanoid(8)}`]));
      const created: CanvasNode[] = toCanvasNodes(payload.nodes).map((node) => ({ ...node, id: ids.get(node.id)!, position: { x: node.position.x + offset, y: node.position.y + offset }, selected: true }));
      const wired: CanvasEdge[] = toCanvasEdges(payload.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))).map((edge) => ({ ...edge, id: `e_${nanoid(8)}`, source: ids.get(edge.source)!, target: ids.get(edge.target)! }));
      setNodes((current) => [...current.map((node) => (node.selected === true ? { ...node, selected: false } : node)), ...created]);
      setEdges((current) => [...current, ...wired]);
      setSelectedId(created.length === 1 ? created[0]!.id : null);
      setDirty(true);
      return created.length;
    },
    [commit],
  );

  const duplicate = useCallback(
    (nodeId: string) => {
      const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
      if (node === undefined) return;
      pasteNodes(fromCanvas([node], []), 40);
    },
    [pasteNodes],
  );

  const copySelection = useCallback(() => {
    const chosen = nodesRef.current.filter((node) => node.selected === true);
    if (chosen.length === 0) return;
    const ids = new Set(chosen.map((node) => node.id));
    clipboard = fromCanvas(
      chosen,
      edgesRef.current.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
    );
    toast(`Copied ${chosen.length} node${chosen.length === 1 ? '' : 's'}`, { description: 'Paste with ⌘V here or in another workflow.' });
  }, []);

  /** Lay the graph out in columns by distance from the trigger, ordering each column after its parents to keep lines from crossing. */
  const autoLayout = useCallback(() => {
    commit();
    const current = nodesRef.current;
    const links = edgesRef.current;
    const incoming = new Map<string, string[]>();
    const outgoing = new Map<string, string[]>();
    for (const edge of links) {
      incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]);
      outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
    }
    // Longest path from a root, capped so a loop someone drew cannot spin forever.
    const depth = new Map<string, number>();
    const cap = current.length;
    const queue = current.filter((node) => (incoming.get(node.id) ?? []).length === 0).map((node) => ({ id: node.id, d: 0 }));
    while (queue.length > 0) {
      const { id, d } = queue.shift()!;
      if ((depth.get(id) ?? -1) >= d || d > cap) continue;
      depth.set(id, d);
      for (const target of outgoing.get(id) ?? []) queue.push({ id: target, d: d + 1 });
    }
    const columns = new Map<number, CanvasNode[]>();
    for (const node of current) {
      const d = depth.get(node.id) ?? 0;
      columns.set(d, [...(columns.get(d) ?? []), node]);
    }
    const row = new Map<string, number>();
    const positions = new Map<string, { x: number; y: number }>();
    for (const d of [...columns.keys()].sort((a, b) => a - b)) {
      const column = columns.get(d)!;
      const weight = (node: CanvasNode) => {
        const parents = (incoming.get(node.id) ?? []).map((id) => row.get(id)).filter((value): value is number => value !== undefined);
        return parents.length === 0 ? node.position.y / ROW : parents.reduce((sum, value) => sum + value, 0) / parents.length;
      };
      column.sort((a, b) => weight(a) - weight(b));
      column.forEach((node, index) => {
        const offset = index - (column.length - 1) / 2;
        row.set(node.id, offset);
        positions.set(node.id, { x: 80 + d * COLUMN, y: 280 + offset * ROW });
      });
    }
    setNodes((list) => list.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position })));
    setDirty(true);
    setTimeout(() => void fitView({ duration: 500, padding: 0.18, maxZoom: 1 }), 30);
  }, [commit, fitView]);

  /** Swap in a saved version of the graph, as one undoable edit. */
  const replaceGraph = useCallback(
    (version: Workflow, label: string) => {
      commit();
      setNodes(toCanvasNodes(version.nodes));
      setEdges(toCanvasEdges(version.edges));
      setSelectedId(null);
      setDirty(true);
      setHistoryOpen(false);
      toast.success(`Restored ${label}`, { description: 'Press ⌘Z to undo.' });
      setTimeout(() => void fitView({ duration: 400, padding: 0.18, maxZoom: 1 }), 30);
    },
    [commit, fitView],
  );

  /* ---------------------------------------------------------------- */
  /* Node picker                                                        */
  /* ---------------------------------------------------------------- */

  const openPicker = useCallback((source: PickerSource | null, position: { x: number; y: number } | null = null) => setPicker({ open: true, source, position }), []);

  const addAfter = useCallback(
    (nodeId: string, handleId?: string) => {
      const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
      const def = node === undefined ? undefined : getNodeType(node.data.typeId);
      if (node === undefined || def === undefined) return;
      const port = def.outputs.find((candidate) => candidate.id === handleId) ?? def.outputs[0];
      if (port === undefined) return;
      openPicker({ nodeId, port, label: node.data.label ?? def.name });
    },
    [openPicker],
  );

  const onPick = useCallback(
    (def: NodeTypeDef) => {
      const { source, position } = picker;
      setPicker({ open: false, source: null, position: null });
      addNode(def, position ?? undefined, source === null ? undefined : { nodeId: source.nodeId, port: source.port });
    },
    [picker, addNode],
  );

  /* ---------------------------------------------------------------- */
  /* Test runs                                                          */
  /* ---------------------------------------------------------------- */

  const applyEvent = useCallback((event: RunEvent, snapshot: Run) => {
    setRun(snapshot);
    setNodes((current) =>
      current.map((node) => {
        const status = snapshot.nodeStatus[node.id];
        const phase = event.nodeId === node.id && event.kind === 'phase' && event.status === 'running' ? event.message : event.nodeId === node.id && event.kind === 'node-finished' ? undefined : node.data.phase;
        if (node.data.status === status && node.data.phase === phase) return node;
        return { ...node, data: { ...node.data, status, phase } };
      }),
    );
  }, []);

  const testRun = useCallback(
    async (payload?: Record<string, unknown>) => {
      if (workflow === null || running) return;
      if (validation !== null && !validation.ok) {
        toast.error(`Fix ${validation.errors} problem${validation.errors === 1 ? '' : 's'} before running`, { description: validation.issues.find((issue) => issue.level === 'error')?.message });
        return;
      }
      setRunning(true);
      setRunOpen(true);
      setShowRunState(true);
      setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, status: 'pending', phase: undefined } })));
      try {
        const result = await launchRun(workflow, {
          ...(payload === undefined ? {} : { payload }),
          onEvent: (event, snapshot) => {
            runIdRef.current = snapshot.id;
            applyEvent(event, snapshot);
          },
        });
        setRun(result);
        setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, status: result.nodeStatus[node.id], phase: undefined } })));
        if (result.status === 'succeeded') toast.success(`Test run succeeded · $${result.costUsd.toFixed(2)}`, { description: result.prUrl === undefined ? 'Every node finished.' : 'The pipeline delivered a (simulated) pull request.' });
        else if (result.status === 'refused') toast.warning('A guardrail refused the run', { description: 'Open the run panel to see which gate said no, and why.' });
        else if (result.status === 'failed') toast.error('The test run failed', { description: 'Open the run panel to see which node failed.' });
        else if (result.status === 'cancelled') toast('Test run stopped');
      } finally {
        setRunning(false);
        runIdRef.current = null;
      }
    },
    [workflow, running, validation, applyEvent],
  );

  /** The same as a test run, except that it happens: on the paired machine, through `relay connect`. */
  const machineRun = useCallback(
    async (task: RunTask, repository?: string) => {
      if (workflow === null || running) return;
      if (validation !== null && !validation.ok) {
        toast.error(`Fix ${validation.errors} problem${validation.errors === 1 ? '' : 's'} before running`, { description: validation.issues.find((issue) => issue.level === 'error')?.message });
        return;
      }
      setRunning(true);
      setRunOpen(true);
      setShowRunState(true);
      setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, status: 'pending', phase: undefined } })));
      try {
        const result = await launchMachineRun(workflow, task, {
          ...(repository === undefined ? {} : { repository }),
          onEvent: (event, snapshot) => {
            runIdRef.current = snapshot.id;
            applyEvent(event, snapshot);
          },
        });
        setRun(result);
        setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, status: result.nodeStatus[node.id], phase: undefined } })));
        const where = result.machine?.host ?? 'your machine';
        if (result.status === 'succeeded') toast.success(`Finished on ${where}${result.costUsd > 0 ? ` · $${result.costUsd.toFixed(2)}` : ''}`, { description: result.prUrl ?? 'The work is on its run branch.' });
        else if (result.status === 'failed') toast.error(`The run on ${where} failed`, { description: result.summary });
        else if (result.status === 'cancelled') toast(`Stopped the run on ${where}`, { description: result.summary });
      } catch (error) {
        setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, status: undefined, phase: undefined } })));
        setShowRunState(false);
        toast.error('The run did not start', { description: error instanceof Error ? error.message : String(error) });
      } finally {
        setRunning(false);
        runIdRef.current = null;
      }
    },
    [workflow, running, validation, applyEvent],
  );

  const clearRunState = useCallback(() => {
    setShowRunState(false);
    setNodes((current) => current.map((node) => (node.data.status === undefined && node.data.phase === undefined ? node : { ...node, data: { ...node.data, status: undefined, phase: undefined } })));
  }, []);

  /* ---------------------------------------------------------------- */
  /* Keyboard                                                           */
  /* ---------------------------------------------------------------- */

  const dialogOpen = picker.open || exportOpen || payloadOpen || machineOpen;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (dialogOpen || isTypingTarget(event.target)) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (mod && key === 'y') {
        event.preventDefault();
        redo();
      } else if (mod && key === 'd') {
        event.preventDefault();
        if (selectedId !== null) duplicate(selectedId);
      } else if (mod && key === 'c') {
        copySelection();
      } else if (mod && key === 'v') {
        if (clipboard !== null) {
          event.preventDefault();
          pasteNodes(clipboard);
        }
      } else if (mod && key === 'enter') {
        event.preventDefault();
        void testRun();
      } else if (!mod && !event.altKey && key === 'a') {
        event.preventDefault();
        if (selectedId !== null) addAfter(selectedId);
        else openPicker(null);
      } else if (event.shiftKey && event.code === 'Digit1') {
        event.preventDefault();
        void fitView({ duration: 400, padding: 0.18, maxZoom: 1 });
      } else if (key === 'escape') {
        selectNode(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialogOpen, undo, redo, duplicate, copySelection, pasteNodes, testRun, addAfter, openPicker, fitView, selectNode, selectedId]);

  const actions: BuilderActions = useMemo(() => ({ addAfter, duplicate, remove: deleteNode, removeEdge, select: (nodeId) => selectNode(nodeId), readOnly: running }), [addAfter, duplicate, deleteNode, removeEdge, selectNode, running]);

  if (saved === undefined || workflow === null) return null;
  const tourOpen = toursSeen['builder'] !== true;

  const canvasArea = (
    <>
      <div ref={canvasRef} className="min-h-0 flex-1">
        <Canvas
          nodes={decoratedNodes}
          edges={decoratedEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onSelect={(nodeId) => {
            setSelectedId(nodeId);
            if (nodeId !== null) setShowInspector(true);
          }}
          onDrop={(def, position) => addNode(def, position)}
          onDropConnection={(source, position) => {
            const node = nodesRef.current.find((candidate) => candidate.id === source.nodeId);
            const def = node === undefined ? undefined : getNodeType(node.data.typeId);
            openPicker({ nodeId: source.nodeId, port: source.port, label: node?.data.label ?? def?.name ?? 'this node' }, position);
          }}
          onBeforeChange={() => commit()}
          readOnly={running}
          empty={<EmptyCanvas onAdd={() => openPicker(null)} />}
        >
          {!hasTrigger && nodes.length > 0 ? (
            <Button size="xs" variant="outline" className="bg-card shadow-xs" onClick={() => openPicker(null)}>
              <Zap data-icon="inline-start" className="text-amber-500" /> This workflow needs a trigger — add one
            </Button>
          ) : nodes.length > 0 && !running ? (
            <Button size="xs" variant="outline" className="bg-card/90 text-muted-foreground shadow-xs backdrop-blur" onClick={() => (selectedId === null ? openPicker(null) : addAfter(selectedId))}>
              <Plus data-icon="inline-start" /> Add a node <Kbd className="ml-1">A</Kbd>
            </Button>
          ) : undefined}
        </Canvas>
      </div>
      <RunPanel run={run} workflow={workflow} running={running} open={runOpen} onToggle={() => setRunOpen((value) => !value)} onCancel={() => (runIdRef.current === null ? undefined : cancelRun(runIdRef.current))} onClear={clearRunState} />
    </>
  );

  return (
    <BuilderActionsContext.Provider value={actions}>
      <div className="flex h-[calc(100dvh-3rem)] min-h-0 flex-col">
        {/* Toolbar */}
        <div className="flex h-12 shrink-0 items-center gap-1.5 overflow-x-auto border-b bg-card px-2 [scrollbar-width:none]">
          <IconButton label={showPalette ? 'Hide the node list' : 'Show the node list'} onClick={() => setShowPalette((value) => !value)} active={showPalette}>
            <PanelLeft />
          </IconButton>
          <Input
            value={saved.name}
            onChange={(event) => renameWorkflow(saved.id, event.target.value)}
            onBlur={(event) => {
              if (event.target.value.trim().length === 0) renameWorkflow(saved.id, 'Untitled workflow');
            }}
            className="hidden h-8 w-40 shrink-0 border-transparent bg-transparent font-semibold shadow-none hover:border-border focus-visible:border-border sm:block sm:w-56 lg:w-64 dark:bg-transparent"
            aria-label="Workflow name"
          />
          <label className="hidden items-center gap-1.5 text-xs text-muted-foreground md:flex">
            <Switch size="sm" checked={saved.enabled} onCheckedChange={(checked) => toggleWorkflow(saved.id, checked)} aria-label="Active" />
            {saved.enabled ? 'Active' : 'Paused'}
            <HelpTip title="Active or paused">A paused workflow exports with its trigger switched off, so the repository ignores new events until you turn it back on. Test runs work either way.</HelpTip>
          </label>
          <SaveState saving={dirty} />

          <div className="ml-auto flex items-center gap-1">
            <IconButton label="Undo" shortcut="⌘Z" onClick={undo} disabled={history.past === 0 || running}>
              <Undo2 />
            </IconButton>
            <IconButton label="Redo" shortcut="⇧⌘Z" onClick={redo} disabled={history.future === 0 || running}>
              <Redo2 />
            </IconButton>
            <IconButton label="Tidy the layout" onClick={autoLayout} disabled={running || nodes.length < 2}>
              <Wand2 />
            </IconButton>
            <div className="mx-1 h-5 w-px bg-border" />
            {validation === null ? null : <ValidationButton issues={validation.issues} errors={validation.errors} warnings={validation.warnings} onSelect={(nodeId) => selectNode(nodeId, true)} />}
            <IconButton label="Spend forecast: what this workflow will cost" onClick={() => setForecastOpen(true)}>
              <CircleDollarSign />
            </IconButton>
            <IconButton label="Version history" onClick={() => setHistoryOpen(true)}>
              <History />
            </IconButton>
            <Button variant="outline" size="sm" onClick={() => setShareOpen(true)}>
              <Globe data-icon="inline-start" /> <span className="hidden lg:inline">Share</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => setExportOpen(true)}>
              <FileCode2 data-icon="inline-start" /> <span className="hidden sm:inline">Export</span>
            </Button>
            <ButtonGroup>
              <Button size="sm" onClick={() => void testRun()} disabled={running}>
                {running ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Play data-icon="inline-start" className="fill-current" />}
                {running ? 'Running…' : 'Test run'}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button size="icon-sm" aria-label="More ways to test" disabled={running} className="border-l border-primary-foreground/20" />}>
                  <ChevronDown />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Test run</DropdownMenuLabel>
                    <DropdownMenuItem onClick={() => void testRun()}>
                      <Play /> With a sample ticket
                      <Kbd className="ml-auto">⌘↵</Kbd>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setPayloadOpen(true)} disabled={!hasTrigger}>
                      <FileJson /> With my own payload…
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>For real</DropdownMenuLabel>
                    <DropdownMenuItem onClick={() => setMachineOpen(true)} disabled={!canRunOnMachine || !hasTrigger}>
                      {cloudTarget ? <Cloud /> : <Laptop />} {cloudTarget ? 'Run in Relay Cloud…' : canRunOnMachine ? `Run on ${machineHost ?? 'this machine'}…` : 'Run on this machine…'}
                    </DropdownMenuItem>
                    {canRunOnMachine ? null : (
                      <DropdownMenuItem render={<Link href="/connect" />}>
                        <Plug /> Connect your machine
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem render={<Link href="/settings#appearance" />}>
                    <Sparkles /> Playback speed: {speed}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </ButtonGroup>
            <IconButton label={showInspector ? 'Hide settings panel' : 'Show settings panel'} onClick={() => setShowInspector((value) => !value)} active={showInspector}>
              <PanelRight />
            </IconButton>
          </div>
        </div>

        {mobile ? (
          <>
            <div className="flex min-h-0 flex-1 flex-col">{canvasArea}</div>
            <Sheet open={showPalette} onOpenChange={setShowPalette}>
              <SheetContent side="left" className="w-[88vw] gap-0 p-0 sm:max-w-sm" showCloseButton={false}>
                <SheetTitle className="sr-only">Nodes</SheetTitle>
                <Palette
                  onAdd={(def) => {
                    addFromPalette(def);
                    setShowPalette(false);
                  }}
                />
              </SheetContent>
            </Sheet>
            <Sheet open={showInspector} onOpenChange={setShowInspector}>
              <SheetContent side="right" className="w-[92vw] gap-0 p-0 sm:max-w-sm">
                <SheetTitle className="sr-only">Settings</SheetTitle>
                <Inspector node={selected} workflow={workflow} issues={validation?.issues ?? []} run={run} onChange={updateNode} onDelete={deleteNode} onDuplicate={duplicate} onSelect={(nodeId) => selectNode(nodeId, true)} />
              </SheetContent>
            </Sheet>
          </>
        ) : (
          <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
            {showPalette ? (
              <>
                <ResizablePanel id="palette" defaultSize={290} minSize={230} maxSize={440} className="bg-card">
                  <Palette onAdd={addFromPalette} />
                </ResizablePanel>
                <ResizableHandle />
              </>
            ) : null}
            <ResizablePanel id="canvas" minSize={360} className="flex min-h-0 flex-col">
              {canvasArea}
            </ResizablePanel>
            {showInspector ? (
              <>
                <ResizableHandle />
                <ResizablePanel id="inspector" defaultSize={340} minSize={280} maxSize={560} className="bg-card">
                  <Inspector node={selected} workflow={workflow} issues={validation?.issues ?? []} run={run} onChange={updateNode} onDelete={deleteNode} onDuplicate={duplicate} onSelect={(nodeId) => selectNode(nodeId, true)} />
                </ResizablePanel>
              </>
            ) : null}
          </ResizablePanelGroup>
        )}

        <ExportDialog workflow={workflow} open={exportOpen} onOpenChange={setExportOpen} />
        <ShareDialog workflow={workflow} open={shareOpen} onOpenChange={setShareOpen} />
        <ForecastDialog workflow={workflow} open={forecastOpen} onOpenChange={setForecastOpen} />
        <HistorySheet workflow={workflow} open={historyOpen} onOpenChange={setHistoryOpen} onRestore={replaceGraph} />
        <PayloadDialog
          workflow={workflow}
          open={payloadOpen}
          onOpenChange={setPayloadOpen}
          onRun={(payload) => {
            setPayloadOpen(false);
            void testRun(payload);
          }}
        />
        <MachineRunDialog
          workflow={workflow}
          open={machineOpen}
          onOpenChange={setMachineOpen}
          onRun={(task, repository) => {
            setMachineOpen(false);
            void machineRun(task, repository);
          }}
        />
        <NodePicker open={picker.open} onOpenChange={(open) => setPicker((current) => ({ ...current, open }))} source={picker.source} needsTrigger={!hasTrigger} onPick={onPick} />
        <BuilderTour open={tourOpen} onClose={() => markTourSeen('builder')} />
      </div>
    </BuilderActionsContext.Provider>
  );
}

function IconButton({ label, shortcut, onClick, disabled, active, children }: { label: string; shortcut?: string; onClick: () => void; disabled?: boolean; active?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={onClick} disabled={disabled} aria-label={label} className={cn(active === true ? 'text-foreground' : 'text-muted-foreground')} />}>{children}</TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut === undefined ? null : <Kbd>{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

/** The canvas's own save, and — signed in — whether the account has it yet. */
function SaveState({ saving }: { saving: boolean }) {
  const signedIn = useAccount((state) => state.status === 'signed-in');
  const cloud = useSyncStatus((status) => status.state);
  const pending = useSyncStatus((status) => status.pendingCount);
  const offline = signedIn && (cloud === 'offline' || cloud === 'error');
  const busy = saving || (signedIn && !offline && (cloud === 'saving' || pending > 0));
  const key = busy ? 'saving' : offline ? 'offline' : 'saved';
  return (
    <span className="hidden w-24 text-xs text-muted-foreground sm:inline-flex" aria-live="polite" title={signedIn ? 'Saved to your account' : 'Saved in this browser'}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span key={key} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.15 }} className="inline-flex items-center gap-1">
          {busy ? (
            'Saving…'
          ) : offline ? (
            <span className="text-warning">Not synced yet</span>
          ) : (
            <>
              <Check className="size-3 text-success" /> Saved
            </>
          )}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

function ValidationButton({ issues, errors, warnings, onSelect }: { issues: ValidationIssue[]; errors: number; warnings: number; onSelect: (nodeId: string) => void }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className={cn(errors > 0 ? 'border-destructive/40 text-destructive hover:text-destructive' : warnings > 0 ? 'border-warning/50 text-amber-700 dark:text-warning' : 'text-success hover:text-success')}
          />
        }
      >
        {errors > 0 ? <CircleAlert data-icon="inline-start" /> : warnings > 0 ? <AlertTriangle data-icon="inline-start" /> : <Check data-icon="inline-start" />}
        <span className="hidden md:inline">{errors > 0 ? `${errors} to fix` : warnings > 0 ? `${warnings} warning${warnings === 1 ? '' : 's'}` : 'Ready'}</span>
        <span className="md:hidden">{errors > 0 ? errors : warnings > 0 ? warnings : ''}</span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[26rem] gap-0 p-0">
        <div className="flex items-center gap-1.5 border-b px-3 py-2.5 text-sm font-medium">
          Checks <HelpTip term="validation" />
          <span className="ml-auto text-xs font-normal text-muted-foreground">Errors block test runs and export; warnings are advice.</span>
        </div>
        <ul className="max-h-96 overflow-auto p-1.5">
          {issues.length === 0 ? <li className="p-3 text-sm text-muted-foreground">Nothing to report. This workflow can be test-run and exported.</li> : null}
          {issues.map((issue, index) => (
            <li key={index}>
              <button
                type="button"
                disabled={issue.nodeId === undefined}
                className="flex w-full flex-col items-start gap-0.5 rounded-md p-2 text-left enabled:hover:bg-muted"
                onClick={() => {
                  if (issue.nodeId !== undefined) onSelect(issue.nodeId);
                }}
              >
                <span className="flex items-start gap-1.5 text-sm">
                  <Badge variant={issue.level === 'error' ? 'destructive' : issue.level === 'warning' ? 'secondary' : 'outline'} className="mt-0.5 h-4 px-1 text-[9px] uppercase">
                    {issue.level === 'info' ? 'note' : issue.level}
                  </Badge>
                  {issue.message}
                </span>
                {issue.hint !== undefined ? <span className="pl-12 text-xs text-muted-foreground">{issue.hint}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function EmptyCanvas({ onAdd }: { onAdd: () => void }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="pointer-events-auto flex max-w-sm flex-col items-center gap-3 rounded-2xl border bg-card/95 p-6 text-center shadow-sm backdrop-blur">
      <span className="flex size-11 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500">
        <Zap className="size-5 fill-current" />
      </span>
      <div>
        <p className="font-semibold">Start with a trigger</p>
        <p className="mt-1 text-sm text-muted-foreground">A trigger is what starts the workflow: a ticket assigned, a label added, a schedule, or a button you press.</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button size="sm" onClick={onAdd}>
          <Plus data-icon="inline-start" /> Add a trigger
        </Button>
        <Button size="sm" variant="outline" nativeButton={false} render={<Link href="/templates" />}>
          <LayoutTemplate data-icon="inline-start" /> Use a template
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Or drag one from the list on the left. Press <Kbd>A</Kbd> any time to add a node.
      </p>
    </motion.div>
  );
}
