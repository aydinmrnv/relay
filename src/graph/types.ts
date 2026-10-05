import { RelayError } from '../util/errors.ts';

/**
 * A workflow as the engine runs it.
 *
 * The studio draws a graph against a catalog of a couple of hundred node
 * types; the engine has no catalog and wants none. So the studio compiles the
 * canvas into this: every node with its defaults already filled in, its
 * output handles named, its secrets left out, and the engine config the
 * pipeline runs with alongside. The file is self-contained — `relay workflow
 * run` needs nothing else from the studio, and nothing in it is a credential.
 *
 * Exported by the studio to `.relay/workflows/<name>.json`, and sent whole
 * when the studio starts a run on a paired machine.
 */

export const GRAPH_VERSION = 1;

export type GraphNodeKind = 'trigger' | 'action';

export interface GraphNode {
  id: string;
  /** The catalog's id for what this node is: `gates.action.budget`, `slack.action.post-message`. */
  type: string;
  kind: GraphNodeKind;
  /** What a person calls it: the label they gave it, or `Slack · Post a message`. */
  name: string;
  /** Field values with the catalog's defaults applied. Secret fields are never here. */
  config: Record<string, unknown>;
  /** Output handles, in order. An edge that names no handle leaves from the first. */
  outputs: string[];
}

export interface GraphEdge {
  from: string;
  /** The output it leaves from, or null for the node's first. */
  handle: string | null;
  to: string;
}

export interface WorkflowGraph {
  version: typeof GRAPH_VERSION;
  id: string;
  name: string;
  /** `owner/name`, when the workflow says which repository it is for. */
  repository: string | null;
  /** False for a paused workflow: nothing starts it by itself. A person still can. */
  enabled: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** The engine config the studio compiled: what `.relay/config.json` would hold. Layered over the repository's own. */
  config: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* What starts a run                                                   */
/* ------------------------------------------------------------------ */

/** What the agents work on: a tracker issue, or a description. */
export type GraphTask = { kind: 'issue'; ref: string } | { kind: 'prompt'; text: string };

export interface WorkflowEvent {
  /** Stable for one delivery, so the same webhook sent twice starts one run. */
  id: string;
  source: 'manual' | 'webhook' | 'schedule' | 'issue';
  /**
   * Whether a person started this, at the controls. The guardrails that decide
   * whether an *event* may start a run (the kill switch, the allowlist) have
   * nothing to decide then. A budget still applies: it is the same money.
   */
  attended: boolean;
  /** Who the event says did it: a login, or null when it does not say. */
  actor: string | null;
  /** The ticket-shaped payload: what `{{issue.title}}` and `{{trigger.*}}` read. */
  payload: Record<string, unknown>;
  /** What the pipeline works on. Null when the event carries nothing to work on. */
  task: GraphTask | null;
  at: string;
}

/* ------------------------------------------------------------------ */
/* What a run says as it goes                                          */
/* ------------------------------------------------------------------ */

/**
 * `done`: performed. `refused`: a guardrail said no. `failed`: tried, and it
 * did not work. `skipped`: on a path the run did not take. `unwired`: Relay
 * has no way to perform this step yet, so it did not, and says so.
 */
export type GraphNodeStatus = 'done' | 'refused' | 'failed' | 'skipped' | 'unwired';

export type GraphRunStatus = 'succeeded' | 'failed' | 'refused' | 'cancelled';

/**
 * One line of `relay workflow run --json`. Lines of the pipeline's own run
 * (`run_started`, `phase_started`, … `summary`) pass through between a
 * pipeline node's `node_started` and `node_finished`, verbatim, so a reader
 * of `relay run --json` already understands the middle of this stream.
 */
export type GraphRecord =
  | {
      type: 'workflow_started';
      at: string;
      workflow: { id: string; name: string };
      event: { id: string; source: WorkflowEvent['source']; attended: boolean; actor: string | null; title: string };
      /** Every node, and whether this run can perform it. */
      nodes: Array<{ id: string; nodeType: string; name: string; real: boolean }>;
    }
  | { type: 'node_started'; at: string; node: string; nodeType: string; name: string }
  | { type: 'node_waiting'; at: string; node: string; message: string; detail: string | null; /** The approval being waited on, when that is what the wait is: what `relay workflow approve` and the studio answer. */ approval?: string }
  | {
      type: 'node_finished';
      at: string;
      node: string;
      nodeType: string;
      status: GraphNodeStatus;
      message: string;
      detail: string | null;
      durationMs: number;
      /** What this step itself cost, when it cost anything (an AI step). The pipeline reports its own. */
      costUsd: number | null;
    }
  | {
      type: 'workflow_finished';
      at: string;
      status: GraphRunStatus;
      exitCode: number;
      summary: string;
      /** The engine's run id, when the pipeline ran. */
      runId: string | null;
      pullRequest: string | null;
      costUsd: number | null;
      /** Steps Relay could not perform, by name. */
      unwired: string[];
    };

/* ------------------------------------------------------------------ */
/* Reading one                                                         */
/* ------------------------------------------------------------------ */

function bad(message: string): RelayError {
  return new RelayError(message, {
    code: 'BAD_WORKFLOW',
    hint: 'Export the workflow again from the studio: the file to run is .relay/workflows/<name>.json.',
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** How many nodes a workflow may have. The studio's canvases are a few dozen; this bounds what a file can ask of the walk. */
const MAX_NODES = 500;

/**
 * Reads a compiled workflow, refusing anything that is not one.
 *
 * Strict, because this file decides what runs on a machine that holds
 * sign-ins: an unknown shape is an error naming what is wrong, never a guess.
 */
export function parseGraph(value: unknown): WorkflowGraph {
  if (!isRecord(value)) throw bad('A workflow file must hold a JSON object.');
  // The studio also exports the canvas itself, to import back. That is a different file.
  if (isRecord(value['workflow']) && Array.isArray((value['workflow'] as Record<string, unknown>)['nodes']) && value['version'] === undefined) {
    throw bad('This is the studio’s canvas file, which is for importing back into the studio. The engine runs the compiled one.');
  }
  if (value['version'] !== GRAPH_VERSION) throw bad(`This workflow file is version ${JSON.stringify(value['version'] ?? null)}; this Relay reads version ${GRAPH_VERSION}.`);
  if (typeof value['id'] !== 'string' || value['id'].length === 0) throw bad('The workflow has no id.');
  if (typeof value['name'] !== 'string' || value['name'].trim().length === 0) throw bad('The workflow has no name.');
  if (!Array.isArray(value['nodes']) || !Array.isArray(value['edges'])) throw bad('The workflow has no nodes or no edges list.');
  if (value['nodes'].length > MAX_NODES) throw bad(`The workflow has ${value['nodes'].length} nodes; the most this Relay runs is ${MAX_NODES}.`);

  const ids = new Set<string>();
  const nodes = value['nodes'].map((raw, index): GraphNode => {
    if (!isRecord(raw)) throw bad(`Node ${index + 1} is not an object.`);
    const { id, type, kind, name, config, outputs } = raw;
    if (typeof id !== 'string' || id.length === 0) throw bad(`Node ${index + 1} has no id.`);
    if (ids.has(id)) throw bad(`Two nodes share the id "${id}".`);
    ids.add(id);
    if (typeof type !== 'string' || !/^[a-z0-9-]+\.(trigger|action)\.[a-z0-9-]+$/.test(type)) throw bad(`Node "${id}" has no usable type.`);
    if (kind !== 'trigger' && kind !== 'action') throw bad(`Node "${id}" is neither a trigger nor an action.`);
    if (kind !== type.split('.')[1]) throw bad(`Node "${id}" says it is a ${kind}, and its type ${type} says otherwise.`);
    if (config !== undefined && !isRecord(config)) throw bad(`Node "${id}" has settings that are not an object.`);
    if (outputs !== undefined && (!Array.isArray(outputs) || outputs.some((handle) => typeof handle !== 'string'))) throw bad(`Node "${id}" has outputs that are not a list of names.`);
    return {
      id,
      type,
      kind,
      name: typeof name === 'string' && name.trim().length > 0 ? name.trim() : type,
      config: config ?? {},
      outputs: (outputs as string[] | undefined) ?? [],
    };
  });

  const edges = value['edges'].map((raw, index): GraphEdge => {
    if (!isRecord(raw)) throw bad(`Edge ${index + 1} is not an object.`);
    const { from, to, handle } = raw;
    if (typeof from !== 'string' || !ids.has(from)) throw bad(`Edge ${index + 1} starts at a node that is not in the workflow.`);
    if (typeof to !== 'string' || !ids.has(to)) throw bad(`Edge ${index + 1} ends at a node that is not in the workflow.`);
    if (handle !== undefined && handle !== null && typeof handle !== 'string') throw bad(`Edge ${index + 1} names an output that is not text.`);
    return { from, to, handle: typeof handle === 'string' && handle.length > 0 ? handle : null };
  });

  if (!nodes.some((node) => node.kind === 'trigger')) throw bad('The workflow has no trigger, so nothing can start it.');

  const config = value['config'];
  if (config !== undefined && !isRecord(config)) throw bad('The workflow’s engine config is not an object.');
  const repository = value['repository'];

  return {
    version: GRAPH_VERSION,
    id: value['id'],
    name: value['name'].trim(),
    repository: typeof repository === 'string' && repository.trim().length > 0 ? repository.trim() : null,
    enabled: value['enabled'] !== false,
    nodes,
    edges,
    config: config ?? {},
  };
}

/** The trigger a workflow starts from: its first, as in a test run. A parsed workflow always has one. */
export function triggerOf(graph: WorkflowGraph): GraphNode {
  return graph.nodes.find((node) => node.kind === 'trigger')!;
}

export const PIPELINE_TYPES: ReadonlySet<string> = new Set(['pipeline.action.run', 'pipeline.action.fast']);

/** The pipeline node, when the workflow has one. */
export function pipelineOf(graph: WorkflowGraph): GraphNode | undefined {
  return graph.nodes.find((node) => PIPELINE_TYPES.has(node.type));
}

/* ------------------------------------------------------------------ */
/* What an event nobody vetted may name                                */
/* ------------------------------------------------------------------ */

/**
 * Whether text names a tracker issue, and nothing else.
 *
 * `relay run <ref>` reads anything that is not an issue as a file: a spec on
 * this machine, whose first line becomes the pull request's title. A person
 * naming a file means it. An event does not get to: a webhook body that said
 * `"issue": "../.env"` would have the agents handed the file. So a reference
 * that arrives in an event is held to the shapes a tracker's own references
 * have — a number, `owner/repo#n`, a GitHub issue address, a Linear key or
 * address — and anything else is not a reference.
 */
export function isIssueReference(ref: string): boolean {
  return (
    /^#?\d{1,10}$/.test(ref) ||
    /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?#)[A-Za-z0-9._-]{1,100}#\d{1,10}$/.test(ref) ||
    /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?\/)[A-Za-z0-9._-]{1,100}\/issues\/\d{1,10}$/.test(ref) ||
    /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,7}$/.test(ref) ||
    /^https:\/\/linear\.app\/[A-Za-z0-9-]{1,60}\/issue\/[A-Za-z][A-Za-z0-9]{0,9}-\d{1,7}(?:\/[A-Za-z0-9-]{0,200})?$/.test(ref)
  );
}

/**
 * The keys of a ticket the walk writes itself: the estimate a step priced,
 * what a model answered, the issue a step filed. An event's body is spread
 * into the same object, so these are taken out of it first — a webhook that
 * said `"estimate": 0` would otherwise walk through a Filter that exists to
 * stop expensive work.
 */
export const ENGINE_KEYS: readonly string[] = ['estimate', 'estimateUsd', 'triage', 'createdRef'];

/**
 * The variables only a workflow's own steps read: the chat webhooks, the
 * bridge, the webhook's signing secret, the headers of an HTTP request. Never
 * passed to anything an agent runs in. (`LINEAR_API_KEY` is not here: the
 * engine itself reads Linear issues with it.)
 */
export function isWorkflowCredential(name: string): boolean {
  return ['SLACK_WEBHOOK_URL', 'DISCORD_WEBHOOK_URL', 'BRIDGE_WEBHOOK_URL', 'RELAY_WEBHOOK_SECRET'].includes(name) || /^HTTP_HEADERS(_\d+)?$/.test(name);
}

/** Text from an event, made safe to print and to store: control characters and direction overrides become spaces. */
export function plainText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');
}
