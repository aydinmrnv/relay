'use client';

import { memo, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBuilderActions } from './builder-context';
import type { CanvasEdge } from './types';

/**
 * A connection on the canvas. Branch edges carry the name of the output they
 * leave from ("Refused", "True"), so a fork reads without hovering; during a
 * test run an edge the run travelled lights up and one it skipped fades. A
 * hovered or selected edge offers a delete button at its midpoint.
 */
function WorkflowEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, markerEnd, data }: EdgeProps<CanvasEdge>) {
  const actions = useBuilderActions();
  const [hover, setHover] = useState(false);
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const state = data?.state;
  const branch = data?.branch;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        className={cn(
          'transition-[stroke,opacity] duration-300',
          state === 'active' ? '!stroke-primary [stroke-dasharray:6] [animation:dashdraw_0.6s_linear_infinite]' : '',
          state === 'travelled' ? '!stroke-success' : '',
          state === 'skipped' ? 'opacity-30' : '',
          state === 'refused' ? '!stroke-warning' : '',
        )}
        style={{ strokeWidth: selected || state === 'active' || state === 'travelled' ? 2.25 : undefined }}
      />
      {/* A wide invisible path, so the edge is easy to hover and click. */}
      <path d={path} fill="none" stroke="transparent" strokeWidth={18} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} className="react-flow__edge-interaction" />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan pointer-events-auto absolute flex items-center gap-1"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
        >
          {branch === undefined ? null : (
            <span
              className={cn(
                'rounded-full border bg-card px-1.5 py-px text-[10px] font-medium text-muted-foreground shadow-xs',
                state === 'travelled' || state === 'active' ? 'border-success/40 text-success' : '',
                state === 'skipped' ? 'opacity-40' : '',
              )}
            >
              {branch}
            </span>
          )}
          {(hover || selected) && !actions.readOnly ? (
            <button
              type="button"
              aria-label="Delete this connection"
              title="Delete this connection"
              onClick={() => actions.removeEdge(id)}
              className="flex size-5 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-xs transition-colors hover:border-destructive hover:bg-destructive hover:text-white"
            >
              <X className="size-3" />
            </button>
          ) : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const WorkflowEdge = memo(WorkflowEdgeView);
