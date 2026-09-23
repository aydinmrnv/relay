'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider, addEdge, applyEdgeChanges, applyNodeChanges, type EdgeChange, type NodeChange, type OnConnect } from '@xyflow/react';
import { nanoid } from 'nanoid';
import { AlertTriangle, Check, CircleAlert, FileCode2, LayoutGrid, PanelLeft, PanelRight, Play, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { defaultConfig, getNodeType, type NodeTypeDef } from '@/lib/connectors';
import { useStudio } from '@/lib/store';
import { useBrand } from '@/hooks/use-brand';
import { useSignedIn } from '@/hooks/use-agent-accounts';
import { validateWorkflow } from '@/lib/workflow/validate';
import { simulateRun } from '@/lib/workflow/simulate';
import type { Run, RunEvent, Workflow } from '@/lib/workflow/schema';
import { Canvas } from './canvas';
import { Palette } from './palette';
import { Inspector } from './inspector';
import { RunPanel } from './run-panel';
import { ExportDialog } from './export-dialog';
import { fromCanvas, toCanvasEdges, toCanvasNodes, type CanvasEdge, type CanvasNode } from './types';

export function Builder({ workflowId }: { workflowId: string }) {
  return (
    <ReactFlowProvider>
      <BuilderInner workflowId={workflowId} />
    </ReactFlowProvider>
  );
}

function BuilderInner({ workflowId }: { workflowId: string }) {
  const brand = useBrand();
  const saved = useStudio((state) => state.workflows[workflowId]);
  const setGraph = useStudio((state) => state.setGraph);
  const renameWorkflow = useStudio((state) => state.renameWorkflow);
  const toggleWorkflow = useStudio((state) => state.toggleWorkflow);
  const addRun = useStudio((state) => state.addRun);
  const updateRun = useStudio((state) => state.updateRun);
  const speed = useStudio((state) => state.settings.simulationSpeed);
  const signedIn = useSignedIn();
  const signedInKey = `${signedIn.claude}|${signedIn.codex}`;

  const [nodes, setNodes] = useState<CanvasNode[]>(() => toCanvasNodes(saved?.nodes ?? []));
  const [edges, setEdges] = useState<CanvasEdge[]>(() => toCanvasEdges(saved?.edges ?? []));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showPalette, setShowPalette] = useState(true);
  const [showInspector, setShowInspector] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [running, setRunning] = useState(false);
  const [dirty, setDirty] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

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

  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
    if (changes.some((change) => change.type !== 'select' && change.type !== 'dimensions')) setDirty(true);
  }, []);
  const onEdgesChange = useCallback((changes: EdgeChange<CanvasEdge>[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
    if (changes.some((change) => change.type !== 'select')) setDirty(true);
  }, []);
  const onConnect: OnConnect = useCallback((connection) => {
    setEdges((current) => addEdge({ ...connection, id: `e_${nanoid(8)}` }, current));
    setDirty(true);
  }, []);

  const addNode = useCallback((def: NodeTypeDef, position?: { x: number; y: number }) => {
    const id = `n_${nanoid(8)}`;
    setNodes((current) => {
      const last = current[current.length - 1];
      const fallback = last === undefined ? { x: 120, y: 200 } : { x: last.position.x + 320, y: last.position.y };
      const created: CanvasNode = { id, type: 'wf', position: position ?? fallback, data: { typeId: def.id, config: defaultConfig(def) }, selected: true };
      return [...current.map((node) => ({ ...node, selected: false })), created];
    });
    setSelectedId(id);
    setDirty(true);
  }, []);

  const updateNode = useCallback((nodeId: string, patch: { label?: string | null; config?: Record<string, unknown> }) => {
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
  }, []);

  const deleteNode = useCallback((nodeId: string) => {
    setNodes((current) => current.filter((node) => node.id !== nodeId));
    setEdges((current) => current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId));
    setSelectedId((current) => (current === nodeId ? null : current));
    setDirty(true);
  }, []);

  const autoLayout = useCallback(() => {
    const depth = new Map<string, number>();
    const incoming = new Map<string, number>();
    for (const edge of edges) incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    const roots = nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0);
    const queue = roots.map((node) => ({ id: node.id, d: 0 }));
    while (queue.length > 0) {
      const { id, d } = queue.shift()!;
      if ((depth.get(id) ?? -1) >= d) continue;
      depth.set(id, d);
      for (const edge of edges.filter((candidate) => candidate.source === id)) queue.push({ id: edge.target, d: d + 1 });
    }
    const rows = new Map<number, number>();
    setNodes((current) =>
      current.map((node) => {
        const d = depth.get(node.id) ?? 0;
        const row = rows.get(d) ?? 0;
        rows.set(d, row + 1);
        return { ...node, position: { x: 80 + d * 320, y: 120 + row * 150 } };
      }),
    );
    setDirty(true);
  }, [nodes, edges]);

  const applyEvent = useCallback((event: RunEvent, snapshot: Run) => {
    setRun({ ...snapshot, events: [...snapshot.events], nodeStatus: { ...snapshot.nodeStatus } });
    setNodes((current) =>
      current.map((node) => {
        const status = snapshot.nodeStatus[node.id];
        const phase = event.nodeId === node.id && event.kind === 'phase' && event.status === 'running' ? event.message : event.nodeId === node.id && event.kind === 'node-finished' ? undefined : node.data.phase;
        if (node.data.status === status && node.data.phase === phase) return node;
        return { ...node, data: { ...node.data, status, phase } };
      }),
    );
  }, []);

  const testRun = useCallback(async () => {
    if (workflow === null || running) return;
    if (validation !== null && !validation.ok) {
      toast.error(`Fix ${validation.errors} error${validation.errors === 1 ? '' : 's'} before running.`);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setRunOpen(true);
    setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, status: 'pending', phase: undefined } })));
    let added = false;
    try {
      const result = await simulateRun(workflow, {
        speed,
        brand,
        repository: workflow.repository,
        signal: controller.signal,
        onEvent: (event, snapshot) => {
          applyEvent(event, snapshot);
          if (!added) {
            addRun({ ...snapshot, events: [...snapshot.events] });
            added = true;
          } else {
            updateRun({ ...snapshot, events: [...snapshot.events], nodeStatus: { ...snapshot.nodeStatus } });
          }
        },
      });
      setRun(result);
      updateRun(result);
      setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, status: result.nodeStatus[node.id], phase: undefined } })));
      if (result.status === 'succeeded') toast.success(`Run ${result.shortId} succeeded · $${result.costUsd.toFixed(2)}`);
      else if (result.status === 'refused') toast.warning(`Run ${result.shortId} was refused by a gate.`);
      else if (result.status === 'failed') toast.error(`Run ${result.shortId} failed.`);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [workflow, running, validation, speed, brand, applyEvent, addRun, updateRun]);

  const clearRunState = () => {
    setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, status: undefined, phase: undefined } })));
  };

  if (saved === null || saved === undefined || workflow === null) return null;
  const selected = decoratedNodes.find((node) => node.id === selectedId) ?? null;

  return (
    <div className="flex h-[calc(100dvh-3rem)] min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b bg-card px-2">
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => setShowPalette((value) => !value)} aria-label="Toggle palette" />}>
            <PanelLeft />
          </TooltipTrigger>
          <TooltipContent>Node palette</TooltipContent>
        </Tooltip>
        <Input
          value={saved.name}
          onChange={(event) => renameWorkflow(saved.id, event.target.value)}
          className="h-8 w-64 border-transparent bg-transparent font-medium shadow-none hover:border-border focus-visible:border-border"
          aria-label="Workflow name"
        />
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Switch size="sm" checked={saved.enabled} onCheckedChange={(checked) => toggleWorkflow(saved.id, checked)} />
          {saved.enabled ? 'Enabled' : 'Disabled'}
        </div>
        <span className="text-xs text-muted-foreground">{dirty ? 'Saving…' : 'Saved'}</span>

        <div className="ml-auto flex items-center gap-1.5">
          {validation === null ? null : (
            <Popover>
              <PopoverTrigger render={<Button variant={validation.errors > 0 ? 'destructive' : validation.warnings > 0 ? 'outline' : 'ghost'} size="sm" />}>
                {validation.errors > 0 ? <CircleAlert data-icon="inline-start" /> : validation.warnings > 0 ? <AlertTriangle data-icon="inline-start" /> : <Check data-icon="inline-start" />}
                {validation.errors > 0 ? `${validation.errors} error${validation.errors === 1 ? '' : 's'}` : validation.warnings > 0 ? `${validation.warnings} warning${validation.warnings === 1 ? '' : 's'}` : 'Valid'}
              </PopoverTrigger>
              <PopoverContent align="end" className="w-96 p-0">
                <div className="border-b px-3 py-2 text-sm font-medium">Validation</div>
                <ul className="max-h-80 overflow-auto p-2">
                  {validation.issues.length === 0 ? <li className="p-2 text-sm text-muted-foreground">Nothing to report. This graph compiles cleanly.</li> : null}
                  {validation.issues.map((issue, index) => (
                    <li key={index}>
                      <button
                        type="button"
                        className="flex w-full flex-col items-start gap-0.5 rounded-md p-2 text-left hover:bg-muted"
                        onClick={() => {
                          if (issue.nodeId !== undefined) {
                            setSelectedId(issue.nodeId);
                            setNodes((current) => current.map((node) => ({ ...node, selected: node.id === issue.nodeId })));
                          }
                        }}
                      >
                        <span className="flex items-center gap-1.5 text-sm">
                          <Badge variant={issue.level === 'error' ? 'destructive' : issue.level === 'warning' ? 'secondary' : 'outline'} className="h-4 px-1 text-[9px] uppercase">
                            {issue.level}
                          </Badge>
                          {issue.message}
                        </span>
                        {issue.hint !== undefined ? <span className="text-xs text-muted-foreground">{issue.hint}</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </PopoverContent>
            </Popover>
          )}
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={autoLayout} aria-label="Auto layout" />}>
              <LayoutGrid />
            </TooltipTrigger>
            <TooltipContent>Tidy the layout</TooltipContent>
          </Tooltip>
          <Button variant="outline" size="sm" onClick={() => setExportOpen(true)}>
            <FileCode2 data-icon="inline-start" /> Export
          </Button>
          <Button size="sm" onClick={() => void testRun()} disabled={running}>
            {running ? <Sparkles data-icon="inline-start" className="animate-pulse" /> : <Play data-icon="inline-start" />}
            {running ? 'Running…' : 'Test run'}
          </Button>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => setShowInspector((value) => !value)} aria-label="Toggle inspector" />}>
              <PanelRight />
            </TooltipTrigger>
            <TooltipContent>Inspector</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        {showPalette ? (
          <>
            <ResizablePanel defaultSize={280} minSize={220} maxSize={440} className="bg-card">
              <Palette onAdd={(def) => addNode(def)} />
            </ResizablePanel>
            <ResizableHandle />
          </>
        ) : null}
        <ResizablePanel minSize={360} className="flex min-h-0 flex-col">
          <div className="min-h-0 flex-1">
            <Canvas
              nodes={decoratedNodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onSelect={setSelectedId}
              onDrop={(def, position) => addNode(def, position)}
              readOnly={running}
            >
              {run !== null && !running ? (
                <Button size="xs" variant="outline" className="bg-card" onClick={clearRunState}>
                  Clear run highlights
                </Button>
              ) : null}
            </Canvas>
          </div>
          <RunPanel
            run={run}
            workflow={workflow}
            running={running}
            open={runOpen}
            onToggle={() => setRunOpen((value) => !value)}
            onCancel={() => abortRef.current?.abort()}
          />
        </ResizablePanel>
        {showInspector ? (
          <>
            <ResizableHandle />
            <ResizablePanel defaultSize={320} minSize={260} maxSize={520} className="bg-card">
              <Inspector node={selected} issues={validation?.issues ?? []} onChange={updateNode} onDelete={deleteNode} />
            </ResizablePanel>
          </>
        ) : null}
      </ResizablePanelGroup>

      <ExportDialog workflow={workflow} open={exportOpen} onOpenChange={setExportOpen} />
    </div>
  );
}

export type { NodeTypeDef };
export { getNodeType };
