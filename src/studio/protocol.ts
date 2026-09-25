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

/**
 * `agents`: the coding CLIs' sign-ins. `runs`: running a workflow. `install`:
 * writing an export into the repository. `repositories`: each run names the
 * GitHub repository it works on, and the companion checks it out (a cloud
 * runner, which has no repository of its own). `github`: the companion signs
 * in to GitHub itself, through `gh`'s device flow (a cloud runner again).
 */
export type CompanionCapability = 'agents' | 'runs' | 'install' | 'repositories' | 'github';

export interface CompanionRepository {
  root: string;
  owner: string | null;
  name: string | null;
  defaultBranch: string;
}

/**
 * A Relay Cloud runner, as the hub describes it: whether the person's machine
 * is awake, on its way, or asleep, and why not when it should be.
 *
 * `none`: no machine yet. `queued`: waiting for room in its region.
 * `creating`: being made (the first time takes a few minutes). `starting`:
 * booting, or reconnecting. `ready`: connected. `stopping`: going to sleep.
 * `asleep`: deallocated, sign-ins kept. `failed`: see `error`. `deleting`:
 * being removed. `offline`: a runner of the person's own that is not connected.
 */
export type CloudRunnerState = 'none' | 'queued' | 'creating' | 'starting' | 'ready' | 'stopping' | 'asleep' | 'failed' | 'deleting' | 'offline';

export interface CloudRunnerStatus {
  state: CloudRunnerState;
  /** Whether the hub starts and stops this machine, or it runs somewhere of the person's own. */
  managed: boolean;
  region: string | null;
  /** When it entered this state. */
  since: string;
  /** 1-based place in the queue for its region, while `queued`. */
  position: number | null;
  error: string | null;
  /** What is keeping it awake, while it is connected. */
  activity: { runs: number; queued: number; logins: number } | null;
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
  /** Present when the answer came through a Relay Cloud hub. */
  cloud?: CloudRunnerStatus;
}

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */

export type AgentId = 'claude' | 'codex';

export const AGENT_IDS: readonly AgentId[] = ['claude', 'codex'];

/** Everything a companion can sign in to: the coding agents, and GitHub on a cloud runner. */
export type AccountId = AgentId | 'github';

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

/** `GET /v1/github`, on a companion with the `github` capability. */
export interface GithubAccount {
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  /** The GitHub login, e.g. `octocat`. */
  login: string | null;
  loginCommand: string;
}

export interface LoginSessionView {
  id: string;
  agent: AccountId;
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
  /** `owner/name` on GitHub. Required by a companion with the `repositories` capability, refused by one without. */
  repository?: string;
}

export type RunStatus = 'running' | 'exited';

/**
 * Where a running run is, before the engine's own stream says more.
 * `queued`: waiting for an earlier run on this machine to finish.
 * `preparing`: checking out the repository.
 */
export type RunStage = 'queued' | 'preparing' | 'running' | 'exited';

export interface CompanionRunView {
  id: string;
  workflow: { id: string; name: string };
  task: RunTask;
  status: RunStatus;
  stage?: RunStage;
  /** `owner/name`, when the run named its repository. */
  repository?: string | null;
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
 * idle connections open and carries nothing. `?since=<seq>` skips the records
 * before that one, for a follower picking a stream back up.
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
