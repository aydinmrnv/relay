import { hostname } from 'node:os';

import { agentsStatus as liveAgentsStatus, AGENT_META, isAgentId, isLoginMode, LoginSessions, logout as liveLogout } from './agents.ts';
import { githubStatus as liveGithubStatus, isAccountId, ACCOUNT_NAMES } from './accounts.ts';
import { InstallError, installFiles as liveInstallFiles } from './install.ts';
import {
  PROTOCOL_VERSION,
  type AccountId,
  type AgentsStatus,
  type CompanionCapability,
  type CompanionRepository,
  type CompanionRunView,
  type GithubAccount,
  type HelloResponse,
  type InstallResponse,
  type RunStreamRecord,
} from './protocol.ts';
import { parseStartRequest, TaskError, type StudioRuns } from './runs.ts';

/**
 * The companion's routes, apart from how they arrive.
 *
 * The same routes answer two transports: the loopback HTTP server a studio on
 * this machine's browser calls (`server.ts`), and the WebSocket a cloud runner
 * keeps open to the hub (`../cloud/dialout.ts`), which carries the studio's
 * requests as frames. Each transport decides who is allowed in — the loopback
 * server with its three locks, the hub with a signed-in account — and then
 * hands the request here. Nothing in this file knows which one it came from.
 */

export interface CompanionEvent {
  kind: 'paired' | 'refused' | 'login' | 'run-started' | 'run-finished' | 'installed' | 'error';
  message: string;
}

export interface RouterOptions {
  version: string;
  /** The one repository runs and installs go to, or null. Ignored for runs when `runs` takes a repository per run. */
  repository: CompanionRepository | null;
  /** Absent when there is nowhere to run: agents only. */
  runs: StudioRuns | null;
  /** What this companion says it can do. Defaults from `runs` and `repository`. */
  capabilities?: CompanionCapability[];
  /** The name the studio shows for this machine. */
  machine?: string;
  log?: (event: CompanionEvent) => void;
  /** Seams for the tests; the defaults ask the real CLIs and write the real repository. */
  agentsStatus?: () => Promise<AgentsStatus>;
  githubStatus?: () => Promise<GithubAccount>;
  logout?: (account: AccountId) => Promise<{ ok: boolean; detail: string }>;
  logins?: LoginSessions;
  installFiles?: (root: string, files: unknown) => Promise<InstallResponse>;
}

export interface RouteRequest {
  method: string;
  /** The path and query, e.g. `/v1/runs/sr_x/events?since=12`. */
  url: string;
  /** The body as JSON. Transports enforce the size and the content type. */
  json(options?: { optional?: boolean }): Promise<unknown>;
}

export type RouteResult =
  | { kind: 'json'; status: number; body: unknown }
  /** Follows a run: replays from `since`, then calls `write` for each record until `exit`. Returns the unsubscribe. */
  | { kind: 'stream'; follow: (write: (record: RunStreamRecord) => void) => () => void };

export class RouteError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Router {
  hello(authorized: boolean): HelloResponse;
  handle(request: RouteRequest): Promise<RouteResult>;
  capabilities: readonly CompanionCapability[];
  logins: LoginSessions;
  /** Sign-ins still waiting for the person, for a runner deciding whether it is idle. */
  pendingLogins(): number;
}

export function createRouter(options: RouterOptions): Router {
  const log = options.log ?? (() => undefined);
  const logins = options.logins ?? new LoginSessions();
  const agentsStatus = options.agentsStatus ?? liveAgentsStatus;
  const githubStatus = options.githubStatus ?? liveGithubStatus;
  const logout = options.logout ?? liveLogout;
  const install = options.installFiles ?? liveInstallFiles;
  const startedAt = new Date().toISOString();
  const capabilities: CompanionCapability[] = options.capabilities ?? (options.runs === null ? ['agents'] : ['agents', 'runs', 'install']);
  const repositoryPerRun = capabilities.includes('repositories');

  function hello(authorized: boolean): HelloResponse {
    const answer: HelloResponse = { product: 'relay', protocol: PROTOCOL_VERSION, authorized };
    if (!authorized) return answer;
    return {
      ...answer,
      version: options.version,
      machine: options.machine ?? hostname(),
      platform: process.platform,
      repository: options.repository,
      capabilities: [...capabilities],
      startedAt,
    };
  }

  function requireRuns(): StudioRuns {
    if (options.runs === null) throw new RouteError(409, 'This companion was started outside a repository. Start `relay connect` inside the repository the workflow runs on.');
    return options.runs;
  }

  function json(status: number, body: unknown): RouteResult {
    return { kind: 'json', status, body };
  }

  async function handle(request: RouteRequest): Promise<RouteResult> {
    const url = new URL(request.url, 'http://companion.invalid');
    const parts = url.pathname.split('/').filter(Boolean);
    const route = `${request.method} /${parts.map((part, index) => (index >= 2 ? ':' : part)).join('/')}`;
    const [, , a, b, c] = parts;

    switch (route) {
      case 'GET /v1/hello':
        return json(200, hello(true));

      case 'GET /v1/agents':
        return json(200, await agentsStatus());

      case 'GET /v1/github':
        if (!capabilities.includes('github')) throw new RouteError(404, 'No such route.');
        return json(200, await githubStatus());

      case 'POST /v1/agents/:/:':
      case 'POST /v1/github/:': {
        // `/v1/github/login` names the account in the path's second segment.
        const account = route === 'POST /v1/github/:' ? 'github' : a;
        const action = route === 'POST /v1/github/:' ? a : b;
        if (!isAccountId(account) || (account === 'github' && !capabilities.includes('github'))) throw new RouteError(404, 'Unknown agent.');
        if (action === 'logout') {
          const result = await logout(account);
          if (result.ok) log({ kind: 'login', message: `Signed out of ${ACCOUNT_NAMES[account]}.` });
          return json(result.ok ? 200 : 500, result);
        }
        if (action !== 'login') throw new RouteError(404, 'No such route.');
        const body = await request.json({ optional: true });
        const mode = (body as { mode?: unknown } | undefined)?.mode ?? (account === 'github' ? 'device' : 'browser');
        if (!isLoginMode(mode)) throw new RouteError(400, 'Unknown sign-in mode.');
        const started = await logins.start(account, mode);
        if (!started.ok) throw new RouteError(500, started.error);
        log({ kind: 'login', message: `Started ${isAgentId(account) ? AGENT_META[account].name : ACCOUNT_NAMES[account]}'s own sign-in for the studio.` });
        return json(200, (await logins.awaitDetails(started.session.id)) ?? started.session);
      }

      case 'GET /v1/logins/:': {
        const found = logins.get(a ?? '');
        if (found === undefined) throw new RouteError(404, 'No such sign-in.');
        return json(200, found);
      }

      case 'DELETE /v1/logins/:':
        return json(200, { ok: logins.cancel(a ?? '') });

      case 'POST /v1/logins/:/:': {
        if (b !== 'code') throw new RouteError(404, 'No such route.');
        const body = (await request.json()) as { code?: unknown };
        const result = logins.submitCode(a ?? '', typeof body.code === 'string' ? body.code : '');
        return json(result.ok ? 200 : 400, result);
      }

      case 'GET /v1/runs':
        return json(200, { runs: requireRuns().list() });

      case 'POST /v1/runs': {
        const runs = requireRuns();
        let started: CompanionRunView;
        try {
          const parsed = parseStartRequest(await request.json(), { repositoryPerRun });
          started = await runs.start(parsed);
        } catch (error) {
          if (error instanceof TaskError) throw new RouteError(400, error.message);
          throw error;
        }
        log({ kind: 'run-started', message: `Running "${started.workflow.name}" for the studio: ${describeTask(started)}.` });
        return json(201, started);
      }

      case 'GET /v1/runs/:':
      case 'GET /v1/runs/:/:': {
        const runs = requireRuns();
        const id = a ?? '';
        const found = runs.get(id);
        if (found === undefined) throw new RouteError(404, 'No such run on this companion.');
        if (b === 'events' && c === undefined) {
          const since = Number(url.searchParams.get('since') ?? '0');
          const from = Number.isInteger(since) && since > 0 ? since : 0;
          return { kind: 'stream', follow: (write) => runs.subscribe(id, write, from) ?? (() => undefined) };
        }
        if (b !== undefined) throw new RouteError(404, 'No such route.');
        return json(200, found);
      }

      case 'DELETE /v1/runs/:': {
        const stopped = await requireRuns().cancel(a ?? '');
        if (!stopped) throw new RouteError(404, 'That run is not running here.');
        return json(202, { ok: true });
      }

      case 'POST /v1/install': {
        if (!capabilities.includes('install') || options.repository === null) {
          throw new RouteError(409, 'This companion was started outside a repository, so there is nowhere to install to.');
        }
        const body = (await request.json()) as { files?: unknown };
        try {
          const result = await install(options.repository.root, body.files);
          const changed = result.files.filter((file) => file.status !== 'unchanged').map((file) => file.path);
          log({ kind: 'installed', message: changed.length === 0 ? 'Installed an export; every file was already up to date.' : `Installed ${changed.join(', ')}.` });
          return json(200, result);
        } catch (error) {
          if (error instanceof InstallError) throw new RouteError(400, error.message);
          throw error;
        }
      }

      default:
        throw new RouteError(404, 'No such route.');
    }
  }

  return { hello, handle, capabilities, logins, pendingLogins: () => logins.pending() };
}

function describeTask(run: CompanionRunView): string {
  const where = run.repository === undefined || run.repository === null ? '' : ` in ${run.repository}`;
  if (run.task.kind === 'issue') return `issue ${run.task.ref}${where}`;
  const text = run.task.text.replace(/\s+/g, ' ');
  return `"${text.length > 60 ? `${text.slice(0, 57)}…` : text}"${where}`;
}

