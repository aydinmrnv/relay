/**
 * One vocabulary for "can a real run talk to this app?", shared by the
 * Integrations page, the builder, template previews and the dashboard, so a
 * marker never looks like a sign-in and a revoked webhook is never green.
 */
import type { Connection, Workflow } from '@/lib/workflow/schema';
import { credentialSpec } from './credentials';
import { nodeSupport } from '@/lib/workflow/engine/support';
import { getNodeType, nodeTypeId, type Connector, type NodeTypeDef } from './index';

export type ConnectionState =
  /** Part of the studio: nothing to connect. */
  | 'builtin'
  /** Reads public data: nothing to sign in to. */
  | 'open'
  /** Runs where the agents run, with that machine's own tools. */
  | 'runner'
  /** A real credential the app confirmed at the last check. */
  | 'verified'
  /** A real credential the app refused at the last check. */
  | 'failing'
  /** Marked ready: a label, with nothing signed in to. */
  | 'marked'
  | 'missing';

export function connectionState(connector: Pick<Connector, 'category' | 'auth'>, connection: Connection | undefined): ConnectionState {
  if (connector.category === 'core') return 'builtin';
  if (connection?.credential !== undefined) return connection.status === 'error' ? 'failing' : 'verified';
  if (connector.auth === 'none') return 'open';
  if (connector.auth === 'local') return 'runner';
  return connection === undefined ? 'missing' : 'marked';
}

/** States with something left to do before a real run: nothing connected, or a credential that stopped working. */
export function needsAction(state: ConnectionState): boolean {
  return state === 'missing' || state === 'failing';
}

/** States where there is nothing to connect at all. */
export function nothingToConnect(state: ConnectionState): boolean {
  return state === 'builtin' || state === 'open' || state === 'runner';
}

export const STATE_LABEL: Record<ConnectionState, string> = {
  builtin: 'Built in',
  open: 'No sign-in needed',
  runner: 'Runs on your runner',
  verified: 'Connected',
  failing: 'Failing',
  marked: 'Marked ready',
  missing: 'Not connected',
};

/** Worst first, so lists lead with what needs doing. */
export const STATE_ORDER: ConnectionState[] = ['failing', 'missing', 'marked', 'verified', 'runner', 'open', 'builtin'];

/* ------------------------------------------------------------------ */
/* Which workflows use which app                                        */
/* ------------------------------------------------------------------ */

export interface AppUsage {
  connectorId: string;
  workflows: Array<{ id: string; name: string }>;
  /** The app's triggers and actions these workflows use. */
  nodes: NodeTypeDef[];
}

/** Every app the workflows use, apart from built-in nodes, with the workflows that use it. */
export function appsInUse(workflows: Workflow[]): Map<string, AppUsage> {
  const usage = new Map<string, AppUsage>();
  for (const workflow of workflows) {
    for (const node of workflow.nodes) {
      const def = getNodeType(node.data.typeId);
      if (def === undefined || def.connector.category === 'core') continue;
      const entry = usage.get(def.connectorId) ?? { connectorId: def.connectorId, workflows: [], nodes: [] };
      if (!entry.workflows.some((used) => used.id === workflow.id)) entry.workflows.push({ id: workflow.id, name: workflow.name });
      if (!entry.nodes.some((used) => used.id === def.id)) entry.nodes.push(def);
      usage.set(def.connectorId, entry);
    }
  }
  return usage;
}

/**
 * What a real run does for this app with nothing connected in the studio:
 * how many of its triggers and steps the engine performs with the runner's
 * own tools and environment (`gh`, a Linear key, a webhook), and which
 * variables those read. Zero performed means the app is designed against
 * only: its steps go to a bridge, or are skipped and reported.
 */
export function runnerSupport(connector: Connector): { performed: number; total: number; needs: string[] } {
  const types = [...connector.triggers.map((spec) => nodeTypeId(connector.id, 'trigger', spec.id)), ...connector.actions.map((spec) => nodeTypeId(connector.id, 'action', spec.id))];
  const real = types.map((type) => nodeSupport(type)).filter((support) => support.real);
  return { performed: real.length, total: types.length, needs: [...new Set(real.flatMap((support) => support.needs))] };
}

/**
 * The triggers and actions a real credential cannot carry out: a webhook can
 * post, but it cannot listen or react. Empty when the app has no real
 * credential kind, since then nothing is covered or uncovered yet, and for
 * an app that connects with a token, which is its whole sign-in.
 */
export function uncoveredNodes(connectorId: string, nodes: NodeTypeDef[]): NodeTypeDef[] {
  const actions = credentialSpec(connectorId)?.actions;
  if (actions === undefined) return [];
  return nodes.filter((def) => def.kind === 'trigger' || !actions.includes(def.specId));
}
