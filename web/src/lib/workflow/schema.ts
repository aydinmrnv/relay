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

/** A GitHub repository as `owner/name`: the one shape every screen that asks for one accepts. */
export const REPOSITORY_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export function isRepository(value: string | undefined | null): value is string {
  return typeof value === 'string' && REPOSITORY_PATTERN.test(value.trim());
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
  /** Repository this workflow is attached to, as `owner/name`. Empty until somebody says which. */
  repository?: string;
  /** When the export dialog last produced files for this workflow. */
  exportedAt?: string;
  /** When its files were found in its repository, or its owner said they were there. Per workflow: each has files of its own. */
  installedAt?: string;
  /** One of the starter workflows a first visit is seeded with, rather than something a person made. */
  demo?: boolean;
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
  /** For a real run waiting on a person: the approval to answer, on the runner it is waiting on. */
  approvalId?: string;
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
  /** Where the run happened. Absent on runs recorded before there was a choice: those were simulated. */
  source?: 'simulated' | 'machine';
  /** For a run on the paired machine: which machine, which repository, and the engine's own run id. */
  machine?: MachineRunInfo;
}

export interface MachineRunInfo {
  /** The machine's hostname, as `relay connect` reported it. */
  host: string;
  /** Which runner it went to: the paired machine (absent on older runs), or the person's Relay Cloud machine. */
  runner?: 'machine' | 'cloud';
  /** `owner/name`, or the folder, of the repository the companion runs in. */
  repository: string | null;
  /** The companion's handle on the run, for following and stopping it. */
  companionRunId: string;
  /** The engine's run id, once it announced one: what `relay status`, `relay diff` and `relay logs` take. */
  runId: string | null;
  task: { kind: 'issue'; ref: string } | { kind: 'prompt'; text: string };
  exitCode?: number | null;
  /** `workflow`: the runner walked the whole graph. Absent: the pipeline and its delivery alone, as every run was before runners could. */
  scope?: 'workflow';
}

/* ------------------------------------------------------------------ */
/* Connections & settings                                              */
/* ------------------------------------------------------------------ */

/**
 * An app the workspace may talk to. Either a marker — a label someone typed,
 * with nothing signed in to — or a real credential the studio's server holds
 * encrypted, of which the browser only ever sees `credential`, a summary.
 */
export interface Connection {
  connectorId: string;
  /** `error`: the last check found the credential revoked or wrong. Markers are always `connected`. */
  status: 'connected' | 'error';
  /** What the card and the builder show: a channel, a webhook's name, or a label someone typed. */
  account: string;
  connectedAt: string;
  /** A marker: nothing was signed in to, and nothing can use it yet. */
  mock?: true;
  credential?: CredentialSummary;
}

/**
 * A webhook posts to the one channel it was made for. An `api-token` is a key
 * or token the app issues for its API; which app is the connection's own
 * `connectorId`.
 */
export type CredentialKind = 'slack-webhook' | 'discord-webhook' | 'api-token';

/** What the browser is told about a stored credential. Never the credential itself. */
export interface CredentialSummary {
  kind: CredentialKind;
  /** Its last four characters, to recognise it by. */
  hint: string;
  /** When the app last confirmed it works, or refused it. */
  checkedAt: string;
  /** Why the last check failed, in a sentence. Set when the connection's status is `error`. */
  error?: string;
}

export type ExecutionTier = 'actions' | 'hosted' | 'self-hosted';

export type AuthPreference = 'subscription' | 'api-key';

/**
 * Where a project's automations run: the repository's own GitHub Actions, the
 * person's computer through `relay connect`, or their Relay Cloud machine.
 */
export type ProjectRunner = 'actions' | 'machine' | 'cloud';

/**
 * A repository somebody set Relay up for, and where its automations run. A
 * workflow belongs to the project whose repository it is attached to, so a
 * project holds no list of its own.
 */
export interface Project {
  id: string;
  /** `owner/name`, as on GitHub. */
  repository: string;
  runner: ProjectRunner;
  createdAt: string;
  /** From GitHub, when the repository could be read: public ones only. */
  defaultBranch?: string;
  /** False when GitHub showed it to a signed-out request. Absent when it could not be seen at all. */
  private?: boolean;
  /**
   * Nobody set this one up: it is here because a workflow is attached to its
   * repository, as every repository was before there were projects. Where it
   * runs is a guess until somebody says, so nothing nags about it.
   */
  implied?: true;
}

export interface Settings {
  executionTier: ExecutionTier;
  /**
   * The repositories set up here. Absent on a workspace from before there
   * were projects: those are read off the workflows (see `projectsOf`).
   */
  projects?: Project[];
  /** The project the studio is showing, by id. `null` or absent: all of them. */
  activeProject?: string | null;
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
  defaultRepository: '',
  simulationSpeed: 'fast',
  motion: 'system',
};
