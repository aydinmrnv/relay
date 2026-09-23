'use client';

import { useCallback, useRef } from 'react';
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
  type IsValidConnection,
  type NodeChange,
  type OnConnect,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { getNodeType, type NodeTypeDef } from '@/lib/connectors';
import { portsCompatible } from '@/lib/workflow/validate';
import { WorkflowNode } from './node';
import { DRAG_MIME } from './palette';
import type { CanvasEdge, CanvasNode } from './types';

const NODE_TYPES = { wf: WorkflowNode };

interface Props {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  onNodesChange: (changes: NodeChange<CanvasNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<CanvasEdge>[]) => void;
  onConnect: OnConnect;
  onSelect: (nodeId: string | null) => void;
  onDrop: (def: NodeTypeDef, position: { x: number; y: number }) => void;
  readOnly?: boolean;
  children?: React.ReactNode;
}

export function Canvas({ nodes, edges, onNodesChange, onEdgesChange, onConnect, onSelect, onDrop, readOnly = false, children }: Props) {
  const wrapper = useRef<HTMLDivElement>(null);
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

  return (
    <div ref={wrapper} className="h-full w-full">
      <ReactFlow<CanvasNode, CanvasEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onSelectionChange={({ nodes: selected }) => onSelect(selected[0]?.id ?? null)}
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
          onDrop(def, { x: position.x - 128, y: position.y - 30 });
        }}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable
        deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={1.75}
        defaultEdgeOptions={{ type: 'default' }}
        proOptions={{ hideAttribution: false }}
        className="bg-background"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeColor={(node) => getNodeType((node as CanvasNode).data.typeId)?.connector.icon.color ?? '#94a3b8'}
          nodeStrokeWidth={2}
          className="!rounded-lg !border !border-border"
        />
        {children === undefined ? null : <Panel position="top-center">{children}</Panel>}
      </ReactFlow>
    </div>
  );
}
