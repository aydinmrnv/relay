/**
 * The saved shape of a workflow. Deliberately free of React Flow types so the
 * same JSON can be compiled, simulated, exported and imported without a canvas.
 */

export interface WorkflowNodeData {
  /** A `NodeTypeDef.id`, e.g. `linear.trigger.issue-assigned`. */
  typeId: string;
  /** User override of the node title. */
  label?: string;
  /** Field values keyed by `FieldSpec.key`. */
  config: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WorkflowNode {
  id: string;
  type: 'wf';
  position: { x: number; y: number };
  data: WorkflowNodeData;
  width?: number;
  height?: number;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  sourceHandle?: string | null;
  target: string;
  targetHandle?: string | null;
  label?: string;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  templateId?: string;
  /** Repository this workflow is attached to, e.g. `acme/api`. Free text in the prototype. */
  repository?: string;
  /** When the export dialog last produced files for this workflow. */
  exportedAt?: string;
}

/* ------------------------------------------------------------------ */
/* Runs                                                                */
/* ------------------------------------------------------------------ */

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'refused' | 'cancelled' | 'waiting';

export type NodeRunStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'refused' | 'waiting';

export interface RunEvent {
  at: string;
  nodeId: string | null;
  /** `phase` events come from inside the pipeline node. */
  kind: 'node-started' | 'node-finished' | 'log' | 'phase' | 'cost' | 'artifact' | 'message' | 'run-finished';
  status?: NodeRunStatus;
  message: string;
  detail?: string;
  /** For `phase` events: the Relay phase name. */
  phase?: string;
  durationMs?: number;
  costUsd?: number;
}

export interface RunPhase {
  phase: string;
  label: string;
  ms: number;
  status: 'done' | 'failed' | 'skipped';
  rounds?: number;
  costUsd?: number;
  agent?: string;
}

export interface Run {
  id: string;
  shortId: string;
  workflowId: string;
  workflowName: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  trigger: { typeId: string; connectorId: string; label: string; payload: Record<string, unknown> };
  events: RunEvent[];
  nodeStatus: Record<string, NodeRunStatus>;
  phases: RunPhase[];
  costUsd: number;
  prUrl?: string;
  branch?: string;
  diff?: { files: number; additions: number; deletions: number };
  tests?: { passed: boolean; command: string; durationMs: number };
  summary?: string;
  /** Set when a real GitHub Actions run is behind this record (not in the prototype). */
  externalUrl?: string;
  /** Where the run happened. Absent on runs recorded before there was a choice: those were simulated. */
  source?: 'simulated' | 'machine';
  /** For a run on the paired machine: which machine, which repository, and the engine's own run id. */
  machine?: MachineRunInfo;
}

export interface MachineRunInfo {
  /** The machine's hostname, as `relay connect` reported it. */
  host: string;
  /** `owner/name`, or the folder, of the repository the companion runs in. */
  repository: string | null;
  /** The companion's handle on the run, for following and stopping it. */
  companionRunId: string;
  /** The engine's run id, once it announced one: what `relay status`, `relay diff` and `relay logs` take. */
  runId: string | null;
  task: { kind: 'issue'; ref: string } | { kind: 'prompt'; text: string };
  exitCode?: number | null;
}

/* ------------------------------------------------------------------ */
/* Connections & settings                                              */
/* ------------------------------------------------------------------ */

export interface Connection {
  connectorId: string;
  status: 'connected' | 'error';
  account: string;
  connectedAt: string;
  /** Prototype only: nothing is real, and the UI says so. */
  mock: true;
}

export type ExecutionTier = 'actions' | 'hosted' | 'self-hosted';

export type AuthPreference = 'subscription' | 'api-key';

export interface Settings {
  executionTier: ExecutionTier;
  /**
   * How each agent authenticates in exported GitHub Actions workflows.
   * `subscription` uses the vendor's supported way of carrying a personal plan
   * into CI; `api-key` uses a Console / Platform key. Locally, the CLIs decide
   * for themselves and the studio only asks them.
   */
  auth: { claude: AuthPreference; codex: AuthPreference };
  defaultRepository: string;
  simulationSpeed: 'instant' | 'fast' | 'realistic';
  /** `system` follows the OS reduced-motion setting; `reduced` makes every animation instant. */
  motion: 'system' | 'full' | 'reduced';
}

export const DEFAULT_SETTINGS: Settings = {
  executionTier: 'actions',
  auth: { claude: 'subscription', codex: 'subscription' },
  defaultRepository: 'acme/api',
  simulationSpeed: 'fast',
  motion: 'system',
};
