import type { Edge, Node } from '@xyflow/react';
import type { NodeRunStatus, WorkflowEdge, WorkflowNode, WorkflowNodeData } from '@/lib/workflow/schema';

/** What the canvas keeps per node on top of the saved data: live run status. */
export interface CanvasNodeData extends WorkflowNodeData {
  status?: NodeRunStatus;
  /** Current pipeline phase label while the node is running. */
  phase?: string;
  /** Set by the validator so the node can show a red ring. */
  invalid?: boolean;
}

export type CanvasNode = Node<CanvasNodeData, 'wf'>;

/** How a test run treated an edge: the run is crossing it, crossed it, never took it, or was refused on it. */
export type EdgeRunState = 'active' | 'travelled' | 'skipped' | 'refused';

export interface CanvasEdgeData extends Record<string, unknown> {
  state?: EdgeRunState;
  /** The source output's name when the source branches ("Refused", "True"). */
  branch?: string;
}

export type CanvasEdge = Edge<CanvasEdgeData, 'wf'>;

export function toCanvasNodes(nodes: WorkflowNode[]): CanvasNode[] {
  return nodes.map((node) => ({
    id: node.id,
    type: 'wf',
    position: node.position,
    data: { ...node.data },
    ...(node.width === undefined ? {} : { width: node.width }),
    ...(node.height === undefined ? {} : { height: node.height }),
  }));
}

export function toCanvasEdges(edges: WorkflowEdge[]): CanvasEdge[] {
  return edges.map((edge) => ({
    id: edge.id,
    type: 'wf' as const,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? undefined,
    targetHandle: edge.targetHandle ?? undefined,
    ...(edge.label === undefined ? {} : { label: edge.label }),
  }));
}

export function fromCanvas(nodes: CanvasNode[], edges: CanvasEdge[]): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      type: 'wf' as const,
      position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
      data: { typeId: node.data.typeId, config: node.data.config ?? {}, ...(node.data.label === undefined ? {} : { label: node.data.label }) },
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? null,
      targetHandle: edge.targetHandle ?? null,
      ...(typeof edge.label === 'string' ? { label: edge.label } : {}),
    })),
  };
}
