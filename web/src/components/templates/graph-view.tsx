'use client';

import { useMemo } from 'react';
import { Background, BackgroundVariant, Controls, ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { BuilderActionsContext, type BuilderActions } from '@/components/builder/builder-context';
import { WorkflowEdge } from '@/components/builder/edge';
import { WorkflowNode } from '@/components/builder/node';
import type { CanvasEdge, CanvasNode } from '@/components/builder/types';
import { getNodeType } from '@/lib/connectors';
import type { Workflow } from '@/lib/workflow/schema';
import { cn } from '@/lib/utils';

const NODE_TYPES = { wf: WorkflowNode };
const EDGE_TYPES = { wf: WorkflowEdge };

const noop = () => undefined;
/** Nodes and edges hide their add / delete controls when the builder says it is read-only. */
const READ_ONLY: BuilderActions = { addAfter: noop, duplicate: noop, remove: noop, removeEdge: noop, select: noop, readOnly: true };

/**
 * The real builder nodes and edges, drawn read-only: pan and the zoom buttons
 * work, nothing can be dragged, connected or selected. Scroll-to-zoom is off
 * so the page around it still scrolls.
 */
export function GraphView({ workflow, className }: { workflow: Workflow; className?: string }) {
  const nodes = useMemo<CanvasNode[]>(
    () => workflow.nodes.map((node) => ({ id: node.id, type: 'wf', position: node.position, data: { ...node.data }, draggable: false, selectable: false, connectable: false })),
    [workflow],
  );
  const edges = useMemo<CanvasEdge[]>(
    () =>
      workflow.edges.map((edge) => {
        const source = workflow.nodes.find((node) => node.id === edge.source);
        const def = source === undefined ? undefined : getNodeType(source.data.typeId);
        const port = def !== undefined && def.outputs.length > 1 ? def.outputs.find((output) => output.id === (edge.sourceHandle ?? def.outputs[0]?.id)) : undefined;
        return {
          id: edge.id,
          type: 'wf',
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle ?? undefined,
          targetHandle: edge.targetHandle ?? undefined,
          selectable: false,
          focusable: false,
          data: port === undefined ? {} : { branch: port.label },
        };
      }),
    [workflow],
  );

  return (
    <div className={cn('h-80 overflow-hidden rounded-lg border', className)}>
      <BuilderActionsContext.Provider value={READ_ONLY}>
        <ReactFlow<CanvasNode, CanvasEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
          minZoom={0.15}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          zoomOnScroll={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          className="bg-background"
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <Controls position="bottom-right" showInteractive={false} />
        </ReactFlow>
      </BuilderActionsContext.Provider>
    </div>
  );
}
