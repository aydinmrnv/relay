'use client';

import { useMemo } from 'react';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { getNodeType, type NodeTypeDef } from '@/lib/connectors';
import type { Workflow } from '@/lib/workflow/schema';
import { cn } from '@/lib/utils';

/** Builder node size, so centres line up with what the canvas would draw. */
const NODE_W = 272;
const NODE_H = 72;
/** Breathing room inside the thumbnail, in percent of its width / height. */
const PAD_X = 7;
const PAD_Y = 22;

interface ThumbNode {
  id: string;
  def: NodeTypeDef;
  name: string;
  x: number;
  y: number;
  wired: boolean;
}

interface ThumbEdge {
  id: string;
  d: string;
  /** Leaves a non-first output (Refused, False…): drawn dashed, like a side path. */
  branch: boolean;
}

/**
 * A workflow as a tiny map: one app icon per node, curves for the edges.
 * Plain HTML and one SVG, no canvas library, so six of them cost nothing. The
 * graph is stretched to fill the box on both axes — it is a sketch of the
 * shape, not a to-scale drawing — and the icons stay crisp at a fixed size.
 */
export function GraphThumbnail({ workflow, className }: { workflow: Workflow; className?: string }) {
  const { nodes, edges } = useMemo(() => layout(workflow), [workflow]);
  return (
    <div
      className={cn('relative overflow-hidden rounded-lg border bg-muted/30 [background-image:radial-gradient(color-mix(in_oklch,var(--foreground)_12%,transparent)_1px,transparent_1px)] [background-size:14px_14px]', className)}
      aria-hidden
    >
      <svg className="absolute inset-0 size-full text-foreground/25" viewBox="0 0 100 100" preserveAspectRatio="none">
        {edges.map((edge) => (
          <path key={edge.id} d={edge.d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray={edge.branch ? '4 3' : undefined} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      {nodes.map((node) => {
        const trigger = node.def.kind === 'trigger';
        return (
          <span
            key={node.id}
            title={node.name}
            className={cn(
              'absolute flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-lg border bg-card shadow-xs',
              // A heavier ink border: the trigger is where the workflow starts.
              trigger ? 'border-foreground/60' : '',
              node.wired ? '' : 'border-dashed opacity-60',
            )}
            style={{ left: `${node.x}%`, top: `${node.y}%` }}
          >
            <ConnectorIcon connector={node.def.connector} size={14} variant="mark" />
          </span>
        );
      })}
    </div>
  );
}

function layout(workflow: Workflow): { nodes: ThumbNode[]; edges: ThumbEdge[] } {
  const placed = workflow.nodes
    .map((node) => ({ node, def: getNodeType(node.data.typeId) }))
    .filter((entry): entry is { node: Workflow['nodes'][number]; def: NodeTypeDef } => entry.def !== undefined && entry.def.id !== 'logic.action.note');
  if (placed.length === 0) return { nodes: [], edges: [] };

  const cx = placed.map(({ node }) => node.position.x + NODE_W / 2);
  const cy = placed.map(({ node }) => node.position.y + NODE_H / 2);
  const minX = Math.min(...cx);
  const maxX = Math.max(...cx);
  const minY = Math.min(...cy);
  const maxY = Math.max(...cy);
  const scale = (value: number, min: number, max: number, pad: number) => (max === min ? 50 : pad + ((value - min) / (max - min)) * (100 - pad * 2));

  const wired = new Set(workflow.edges.flatMap((edge) => [edge.source, edge.target]));
  const nodes: ThumbNode[] = placed.map(({ node, def }, index) => ({
    id: node.id,
    def,
    name: node.data.label ?? def.name,
    x: scale(cx[index]!, minX, maxX, PAD_X),
    y: scale(cy[index]!, minY, maxY, PAD_Y),
    wired: wired.has(node.id) || placed.length === 1,
  }));

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: ThumbEdge[] = [];
  for (const edge of workflow.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) continue;
    const mid = (source.x + target.x) / 2;
    const firstOutput = source.def.outputs[0]?.id;
    edges.push({
      id: edge.id,
      d: `M ${source.x} ${source.y} C ${mid} ${source.y}, ${mid} ${target.y}, ${target.x} ${target.y}`,
      branch: source.def.outputs.length > 1 && (edge.sourceHandle ?? firstOutput) !== firstOutput,
    });
  }
  return { nodes, edges };
}
