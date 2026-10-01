'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type FinalConnectionState,
  type IsValidConnection,
  type NodeChange,
  type OnConnect,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { getNodeType, type NodeTypeDef, type PortSpec } from '@/lib/connectors';
import { portsCompatible } from '@/lib/workflow/validate';
import { WorkflowNode } from './node';
import { WorkflowEdge } from './edge';
import { DRAG_MIME } from './palette';
import type { CanvasEdge, CanvasNode } from './types';

/** The smallest a fit may make the graph: below this a node's text cannot be read, so the rest is reached by panning. */
const FIT_MIN_ZOOM = 0.6;

const NODE_TYPES = { wf: WorkflowNode };
const EDGE_TYPES = { wf: WorkflowEdge };

interface Props {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  onNodesChange: (changes: NodeChange<CanvasNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<CanvasEdge>[]) => void;
  onConnect: OnConnect;
  onSelect: (nodeId: string | null) => void;
  onDrop: (def: NodeTypeDef, position: { x: number; y: number }) => void;
  /** A connection dragged from a port and let go over empty canvas: offer to add a node there. */
  onDropConnection: (source: { nodeId: string; port: PortSpec }, position: { x: number; y: number }) => void;
  /** Called once before a drag moves nodes, so the move can be undone. */
  onBeforeChange: () => void;
  readOnly?: boolean;
  children?: React.ReactNode;
  empty?: React.ReactNode;
}

export function Canvas({ nodes, edges, onNodesChange, onEdgesChange, onConnect, onSelect, onDrop, onDropConnection, onBeforeChange, readOnly = false, children, empty }: Props) {
  const { screenToFlowPosition, fitView, getNodes, getNodesBounds, setViewport } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  // Too narrow for an overview map: it would sit on top of the nodes it is a map of.
  const [roomy, setRoomy] = useState(true);

  // Opening or closing a side panel changes how much room the graph has.
  // Fit it again when that happens, never smaller than can be read: a graph
  // shrunk until its labels are specks is fitted, and useless.
  //
  // A graph too wide to fit at that size (any real one, on a phone) is shown
  // from where it starts, the trigger at the left edge, and read by panning
  // right. Centring it instead opens on the middle of the workflow with its
  // start off screen.
  const fit = useCallback(
    (duration = 0) => {
      const element = wrapper.current;
      const all = getNodes();
      if (element === null || all.length === 0) return;
      const bounds = getNodesBounds(all);
      const pad = 24;
      const wide = (element.clientWidth - pad * 2) / Math.max(1, bounds.width);
      const tall = (element.clientHeight - pad * 2) / Math.max(1, bounds.height);
      if (Math.min(wide, tall) >= FIT_MIN_ZOOM) {
        void fitView({ padding: 0.14, maxZoom: 1, minZoom: FIT_MIN_ZOOM, duration });
        return;
      }
      const zoom = FIT_MIN_ZOOM;
      const x = wide >= zoom ? (element.clientWidth - bounds.width * zoom) / 2 - bounds.x * zoom : pad - bounds.x * zoom;
      const y = tall >= zoom ? (element.clientHeight - bounds.height * zoom) / 2 - bounds.y * zoom : pad + 40 - bounds.y * zoom;
      void setViewport({ x, y, zoom }, { duration });
    },
    [fitView, getNodes, getNodesBounds, setViewport],
  );

  useEffect(() => {
    const element = wrapper.current;
    if (element === null) return;
    let width = element.clientWidth;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setRoomy(width >= 760);
    const observer = new ResizeObserver(() => {
      const next = element.clientWidth;
      setRoomy(next >= 760);
      // A panel, not the pixel or two of a scrollbar appearing.
      if (Math.abs(next - width) < 80) return;
      width = next;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => fit(250), 120);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
    };
  }, [fit]);

  const isValidConnection: IsValidConnection<CanvasEdge> = useCallback(
    (connection) => {
      const conn = connection as Connection;
      if (conn.source === conn.target) return false;
      const source = nodes.find((node) => node.id === conn.source);
      const target = nodes.find((node) => node.id === conn.target);
      if (source === undefined || target === undefined) return false;
      const sourceDef = getNodeType(source.data.typeId);
      const targetDef = getNodeType(target.data.typeId);
      if (sourceDef === undefined || targetDef === undefined) return false;
      const out = sourceDef.outputs.find((port) => port.id === (conn.sourceHandle ?? sourceDef.outputs[0]?.id));
      const inp = targetDef.inputs.find((port) => port.id === (conn.targetHandle ?? targetDef.inputs[0]?.id));
      if (out === undefined || inp === undefined) return false;
      if (edges.some((edge) => edge.source === conn.source && edge.target === conn.target && (edge.sourceHandle ?? null) === (conn.sourceHandle ?? null))) return false;
      return portsCompatible(out.type, inp.type);
    },
    [nodes, edges],
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (readOnly || state.isValid === true || state.toNode !== null || state.fromNode === null || state.fromHandle === null) return;
      // Only when dragging out of an output: dropping an input's wire on the pane has no obvious meaning.
      if (state.fromHandle.type !== 'source') return;
      const def = getNodeType((state.fromNode.data as CanvasNode['data']).typeId);
      const port = def?.outputs.find((candidate) => candidate.id === state.fromHandle?.id) ?? def?.outputs[0];
      if (port === undefined) return;
      const point = 'changedTouches' in event ? event.changedTouches[0] : event;
      if (point === undefined) return;
      const position = screenToFlowPosition({ x: point.clientX, y: point.clientY });
      onDropConnection({ nodeId: state.fromNode.id, port }, { x: position.x, y: position.y - 36 });
    },
    [readOnly, screenToFlowPosition, onDropConnection],
  );

  return (
    <div ref={wrapper} className="relative h-full w-full">
      <ReactFlow<CanvasNode, CanvasEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onNodeDragStart={onBeforeChange}
        onSelectionDragStart={onBeforeChange}
        isValidConnection={isValidConnection}
        onSelectionChange={({ nodes: selected }) => onSelect(selected.length === 1 ? (selected[0]?.id ?? null) : null)}
        onPaneClick={() => onSelect(null)}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(DRAG_MIME)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
          }
        }}
        onDrop={(event) => {
          const typeId = event.dataTransfer.getData(DRAG_MIME);
          if (typeId.length === 0) return;
          event.preventDefault();
          const def = getNodeType(typeId);
          if (def === undefined) return;
          const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
          onDrop(def, { x: position.x - 136, y: position.y - 36 });
        }}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable
        selectionOnDrag={false}
        multiSelectionKeyCode={['Meta', 'Shift']}
        deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
        fitView
        fitViewOptions={{ padding: 0.14, maxZoom: 1, minZoom: FIT_MIN_ZOOM }}
        // After the first fit, which centres: a graph that cannot fit starts at its trigger instead.
        onInit={() => setTimeout(() => fit(), 0)}
        minZoom={0.35}
        maxZoom={1.75}
        defaultEdgeOptions={{ type: 'wf' }}
        connectionRadius={28}
        proOptions={{ hideAttribution: false }}
        className="bg-background"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
        <Controls position="bottom-left" showInteractive={false} />
        {roomy ? (
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            ariaLabel="Overview of the whole workflow"
            nodeColor="color-mix(in oklch, var(--foreground) 35%, transparent)"
            nodeBorderRadius={6}
            style={{ width: 168, height: 108 }}
            className="!rounded-lg !border !border-border !shadow-xs"
          />
        ) : null}
        {children === undefined ? null : <Panel position="top-center">{children}</Panel>}
      </ReactFlow>
      {nodes.length === 0 && empty !== undefined ? <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">{empty}</div> : null}
    </div>
  );
}
