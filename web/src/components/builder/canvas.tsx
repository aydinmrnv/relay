'use client';

import { useCallback } from 'react';
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
  const { screenToFlowPosition } = useReactFlow();

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
    <div className="relative h-full w-full">
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
        fitViewOptions={{ padding: 0.14, maxZoom: 1, minZoom: 0.5 }}
        minZoom={0.2}
        maxZoom={1.75}
        defaultEdgeOptions={{ type: 'wf' }}
        connectionRadius={28}
        proOptions={{ hideAttribution: false }}
        className="bg-background"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          ariaLabel="Overview of the whole workflow"
          nodeColor={(node) => getNodeType((node as CanvasNode).data.typeId)?.connector.icon.color ?? '#94a3b8'}
          nodeBorderRadius={6}
          style={{ width: 168, height: 108 }}
          className="!rounded-lg !border !border-border !shadow-xs"
        />
        {children === undefined ? null : <Panel position="top-center">{children}</Panel>}
      </ReactFlow>
      {nodes.length === 0 && empty !== undefined ? <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">{empty}</div> : null}
    </div>
  );
}
