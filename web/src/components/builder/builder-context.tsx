'use client';

import { createContext, useContext } from 'react';

/**
 * What a node or an edge on the canvas can ask the builder to do. React Flow
 * renders nodes and edges itself, so their buttons and menus reach the
 * builder's state through this rather than through props.
 */
export interface BuilderActions {
  /** Open the node picker to add a node after this one, connected from `handleId`. */
  addAfter: (nodeId: string, handleId?: string) => void;
  duplicate: (nodeId: string) => void;
  remove: (nodeId: string) => void;
  removeEdge: (edgeId: string) => void;
  select: (nodeId: string) => void;
  readOnly: boolean;
}

const noop = () => undefined;

export const BuilderActionsContext = createContext<BuilderActions>({ addAfter: noop, duplicate: noop, remove: noop, removeEdge: noop, select: noop, readOnly: false });

export function useBuilderActions(): BuilderActions {
  return useContext(BuilderActionsContext);
}
