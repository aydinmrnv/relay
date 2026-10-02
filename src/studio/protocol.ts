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

/**
 * THE TRUSTED STUDIO ORIGIN. This is the one place it is written.
 *
 * Whatever page is served from this origin can drive a paired machine: it is
 * where `relay connect` sends a person to pair, the only web origin the
 * companion answers by default, and the origin a Relay Cloud hub accepts
 * sessions from unless told otherwise. Whoever controls this hostname
 * controls those machines, so it must be a domain the project owns before
 * the CLI is shipped to anyone. Today it is a `vercel.app` address, which is
 * the studio's until the day the deployment is renamed or removed.
 *
 * Changing it is this line, and nothing else in the CLI: `relay connect`,
 * `relay hub serve` and `scripts/azure/deploy-hub.sh` all read it from here.
 * A person or an operator can point at another studio without a new build by
 * setting `RELAY_STUDIO_URL` (see `trustedStudioOrigin`).
 */
export const TRUSTED_STUDIO_ORIGIN = 'https://relay-olive-omega.vercel.app';

/** The environment variable that names another studio to trust instead of `TRUSTED_STUDIO_ORIGIN`. */
export const STUDIO_URL_VARIABLE = 'RELAY_STUDIO_URL';

/** Where the hosted studio lives, and so where `relay connect` sends you to pair: the trusted origin, under its older name. */
export const DEFAULT_STUDIO_URL = TRUSTED_STUDIO_ORIGIN;

/** The studio origin to trust: `RELAY_STUDIO_URL` when it is set, `TRUSTED_STUDIO_ORIGIN` otherwise. Throws on a value that is not an http(s) URL. */
export function trustedStudioOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[STUDIO_URL_VARIABLE]?.trim();
  if (raw === undefined || raw.length === 0) return TRUSTED_STUDIO_ORIGIN;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${STUDIO_URL_VARIABLE}="${raw}" is not a URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${STUDIO_URL_VARIABLE}="${raw}" is not an http(s) URL.`);
  return url.origin;
}

/** Whether an origin is this machine itself: `localhost`, a `.localhost` name, or a loopback address. A studio there is a development studio. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

/**
 * `agents`: the coding CLIs' sign-ins. `runs`: running a workflow. `install`:
 * writing an export into the repository. `repositories`: each run names the
 * GitHub repository it works on, and the companion checks it out (a cloud
 * runner, which has no repository of its own). `github`: the companion signs
 * in to GitHub itself, through `gh`'s device flow (a cloud runner again).
 * `chatgpt`: Sign in with ChatGPT, which finishes on a loopback address and so
 * only on the machine whose browser the person is using — never a cloud runner.
 */
export type CompanionCapability = 'agents' | 'runs' | 'install' | 'repositories' | 'github' | 'chatgpt';

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
  /** `relay` when the sign-in is Relay's own (Sign in with ChatGPT) and not the CLI's. Absent for the CLI's. */
  source?: 'relay';
  installCommand: string;
  loginCommand: string;
}

export interface AgentsStatus {
  bridge: true;
  checkedAt: string;
  agents: Record<AgentId, AgentAccount>;
}

/**
 * `browser`, `device` and `console` are the vendor CLI's own logins. `chatgpt`
 * is Sign in with ChatGPT, which the companion runs itself: Codex then spends
 * the person's ChatGPT plan as Relay, within the limit they set for it.
 */
export type LoginMode = 'browser' | 'device' | 'console' | 'chatgpt';

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
