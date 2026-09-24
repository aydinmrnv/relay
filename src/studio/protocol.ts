/**
 * The companion protocol: what `relay connect` answers, and what the workflow
 * studio sends it.
 *
 * The studio is where a workflow is drawn, validated and compiled. This
 * machine is where the agents, the repository and the sign-ins are. The
 * companion is the narrow door between the two: the studio asks it whether the
 * coding CLIs are signed in, starts their own login flows, hands it a compiled
 * workflow to run for real, and installs an export into the repository.
 *
 * Mirrored by `web/src/lib/companion/types.ts`. `PROTOCOL_VERSION` is bumped
 * when a field is removed or changes meaning, never when one is added.
 */

export const PROTOCOL_VERSION = 1;

/** The port the studio looks on before it has been told another. */
export const DEFAULT_COMPANION_PORT = 4477;

/** Where the hosted studio lives, and so where `relay connect` sends you to pair. */
export const DEFAULT_STUDIO_URL = 'https://relay-olive-omega.vercel.app';

export type CompanionCapability = 'agents' | 'runs' | 'install';

export interface CompanionRepository {
  root: string;
  owner: string | null;
  name: string | null;
  defaultBranch: string;
}

/** `GET /v1/hello`. Everything past `authorized` is only sent to a paired studio. */
export interface HelloResponse {
  product: 'relay';
  protocol: number;
  authorized: boolean;
  version?: string;
  machine?: string;
  platform?: NodeJS.Platform;
  repository?: CompanionRepository | null;
  capabilities?: CompanionCapability[];
  startedAt?: string;
}

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */

export type AgentId = 'claude' | 'codex';

export const AGENT_IDS: readonly AgentId[] = ['claude', 'codex'];

export type AuthMethod = 'subscription' | 'api-key' | 'none' | 'unknown';

export interface AgentAccount {
  id: AgentId;
  name: string;
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  method: AuthMethod;
  /** Plan name as the CLI reports it, e.g. `max`, `pro`, `team`. Claude only. */
  plan: string | null;
  /** Account email when the CLI reports one. Shown to the user, never stored. */
  email: string | null;
  installCommand: string;
  loginCommand: string;
}

export interface AgentsStatus {
  bridge: true;
  checkedAt: string;
  agents: Record<AgentId, AgentAccount>;
}

export type LoginMode = 'browser' | 'device' | 'console';

export type LoginStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled';

export interface LoginSessionView {
  id: string;
  agent: AgentId;
  mode: LoginMode;
  status: LoginStatus;
  url: string | null;
  code: string | null;
  needsCode: boolean;
  error: string | null;
  startedAt: string;
}

/* ------------------------------------------------------------------ */
/* Runs                                                                */
/* ------------------------------------------------------------------ */

/** What the agents work on: a tracker issue, a spec file, or a description. */
export type RunTask = { kind: 'issue'; ref: string } | { kind: 'prompt'; text: string };

/** `POST /v1/runs`. */
export interface StartRunRequest {
  workflow: { id: string; name: string };
  /** The workflow compiled to `.relay/config.json` by the studio. Layered over the repository's own. */
  config: Record<string, unknown>;
  task: RunTask;
}

export type RunStatus = 'running' | 'exited';

export interface CompanionRunView {
  id: string;
  workflow: { id: string; name: string };
  task: RunTask;
  status: RunStatus;
  /** The engine's run id, once `relay run` has announced it. */
  runId: string | null;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * One line of `GET /v1/runs/:id/events`, which is newline-delimited JSON.
 *
 * `engine` carries a line of `relay run --json` verbatim — the documented
 * stream, not a re-description of it. `exit` is the last record. `ping` keeps
 * idle connections open and carries nothing.
 */
export type RunStreamRecord =
  | { seq: number; type: 'engine'; data: Record<string, unknown> }
  | { seq: number; type: 'exit'; code: number | null; error: string | null }
  | { seq: number; type: 'ping' };

/* ------------------------------------------------------------------ */
/* Install                                                             */
/* ------------------------------------------------------------------ */

export interface InstallFile {
  /** Relative to the repository root, with forward slashes. */
  path: string;
  content: string;
}

export interface InstallRequest {
  files: InstallFile[];
}

export interface InstallResponse {
  root: string;
  files: Array<{ path: string; status: 'created' | 'updated' | 'unchanged' }>;
}
