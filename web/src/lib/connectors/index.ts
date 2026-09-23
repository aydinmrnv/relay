import { CORE_CONNECTORS } from './catalog/core';
import { DEV_CONNECTORS } from './catalog/dev';
import { BUSINESS_CONNECTORS } from './catalog/business';
import {
  CATEGORY_LABELS,
  type ActionSpec,
  type Connector,
  type ConnectorCategory,
  type FieldSpec,
  type PortSpec,
  type TriggerSpec,
} from './types';

export * from './types';

/** Every connector, core first so the palette leads with the pipeline. */
export const CONNECTORS: Connector[] = dedupe([...CORE_CONNECTORS, ...DEV_CONNECTORS, ...BUSINESS_CONNECTORS]);

const BY_ID = new Map(CONNECTORS.map((connector) => [connector.id, connector]));

export function getConnector(id: string): Connector | undefined {
  return BY_ID.get(id);
}

export function connectorsByCategory(): Array<{ category: ConnectorCategory; label: string; connectors: Connector[] }> {
  const groups = new Map<ConnectorCategory, Connector[]>();
  for (const connector of CONNECTORS) {
    const list = groups.get(connector.category) ?? [];
    list.push(connector);
    groups.set(connector.category, list);
  }
  return (Object.keys(CATEGORY_LABELS) as ConnectorCategory[])
    .filter((category) => groups.has(category))
    .map((category) => ({ category, label: CATEGORY_LABELS[category], connectors: groups.get(category)! }));
}

export const CATALOG_STATS = {
  connectors: CONNECTORS.length,
  triggers: CONNECTORS.reduce((sum, connector) => sum + connector.triggers.length, 0),
  actions: CONNECTORS.reduce((sum, connector) => sum + connector.actions.length, 0),
  categories: new Set(CONNECTORS.map((connector) => connector.category)).size,
};

/* ------------------------------------------------------------------ */
/* Node types                                                          */
/* ------------------------------------------------------------------ */

export type NodeKind = 'trigger' | 'action';

/** One draggable thing in the palette: a trigger or an action of a connector. */
export interface NodeTypeDef {
  id: string;
  kind: NodeKind;
  connectorId: string;
  connector: Connector;
  specId: string;
  name: string;
  description: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
  fields: FieldSpec[];
  sample?: Record<string, unknown>;
}

export function nodeTypeId(connectorId: string, kind: NodeKind, specId: string): string {
  return `${connectorId}.${kind}.${specId}`;
}

function fromTrigger(connector: Connector, trigger: TriggerSpec): NodeTypeDef {
  return {
    id: nodeTypeId(connector.id, 'trigger', trigger.id),
    kind: 'trigger',
    connectorId: connector.id,
    connector,
    specId: trigger.id,
    name: trigger.name,
    description: trigger.description,
    inputs: [],
    outputs: trigger.outputs ?? [],
    fields: trigger.fields ?? [],
    ...(trigger.sample === undefined ? {} : { sample: trigger.sample }),
  };
}

function fromAction(connector: Connector, action: ActionSpec): NodeTypeDef {
  return {
    id: nodeTypeId(connector.id, 'action', action.id),
    kind: 'action',
    connectorId: connector.id,
    connector,
    specId: action.id,
    name: action.name,
    description: action.description,
    inputs: action.inputs ?? [],
    outputs: action.outputs ?? [],
    fields: action.fields ?? [],
  };
}

export const NODE_TYPES: NodeTypeDef[] = CONNECTORS.flatMap((connector) => [
  ...connector.triggers.map((trigger) => fromTrigger(connector, trigger)),
  ...connector.actions.map((action) => fromAction(connector, action)),
]);

const NODE_TYPE_BY_ID = new Map(NODE_TYPES.map((def) => [def.id, def]));

export function getNodeType(id: string): NodeTypeDef | undefined {
  return NODE_TYPE_BY_ID.get(id);
}

/** The config a freshly dropped node starts with: every field's default. */
export function defaultConfig(def: NodeTypeDef): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const field of def.fields) {
    if (field.default !== undefined) config[field.key] = field.default;
  }
  return config;
}

/** Case-insensitive keyword pick, falling back to the first spec. */
export function pickTrigger(connector: Connector, keywords: string[]): TriggerSpec | undefined {
  return pick(connector.triggers, keywords);
}

export function pickAction(connector: Connector, keywords: string[]): ActionSpec | undefined {
  return pick(connector.actions, keywords);
}

function pick<T extends { id: string; name: string; description: string }>(specs: T[], keywords: string[]): T | undefined {
  for (const keyword of keywords) {
    const needle = keyword.toLowerCase();
    const hit = specs.find((spec) => spec.id.includes(needle) || spec.name.toLowerCase().includes(needle));
    if (hit !== undefined) return hit;
  }
  return specs[0];
}

/** Full-text search over connectors and node types for the palette and ⌘K. Every word must match somewhere. */
export function searchNodeTypes(query: string, limit = 40): NodeTypeDef[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const scored: Array<{ def: NodeTypeDef; score: number }> = [];
  for (const def of NODE_TYPES) {
    const fields: Array<[string, number]> = [
      [def.connector.name.toLowerCase(), 5],
      [def.name.toLowerCase(), 4],
      [(def.connector.tags ?? []).join(' ').toLowerCase(), 3],
      [CATEGORY_LABELS[def.connector.category].toLowerCase(), 2],
      [def.description.toLowerCase(), 1],
      [def.kind, 1],
    ];
    let score = 0;
    let matchedAll = true;
    for (const token of tokens) {
      let best = 0;
      for (const [text, weight] of fields) {
        if (text.startsWith(token)) best = Math.max(best, weight * 2);
        else if (text.includes(token)) best = Math.max(best, weight);
      }
      if (best === 0) {
        matchedAll = false;
        break;
      }
      score += best;
    }
    if (!matchedAll) continue;
    if (def.connector.popular === true) score += 1;
    scored.push({ def, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.def.name.localeCompare(b.def.name))
    .slice(0, limit)
    .map((entry) => entry.def);
}

function dedupe(connectors: Connector[]): Connector[] {
  const seen = new Set<string>();
  const out: Connector[] = [];
  for (const connector of connectors) {
    if (seen.has(connector.id)) continue;
    seen.add(connector.id);
    out.push(connector);
  }
  return out;
}
