import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hostname } from 'node:os';

import { errorMessage } from '../util/errors.ts';
import { agentsStatus as liveAgentsStatus, AGENT_META, isAgentId, isLoginMode, LoginSessions, logout as liveLogout } from './agents.ts';
import { InstallError, installFiles as liveInstallFiles } from './install.ts';
import { tokensMatch } from './pairing.ts';
import {
  PROTOCOL_VERSION,
  type AgentId,
  type AgentsStatus,
  type CompanionCapability,
  type CompanionRepository,
  type CompanionRunView,
  type HelloResponse,
  type InstallResponse,
  type RunStreamRecord,
} from './protocol.ts';
import { parseStartRequest, TaskError, type StudioRuns } from './runs.ts';

/**
 * The companion's HTTP side: a server on the loopback interface that only a
 * paired studio can use.
 *
 * Three independent locks, because the thing behind them can start agents
 * that write code:
 *
 *   1. **Loopback only, by name.** It binds to 127.0.0.1, and it refuses any
 *      request whose Host is not this port on a loopback name — which is what
 *      defeats DNS rebinding, where a hostile page points its own domain at
 *      127.0.0.1 and becomes "same-origin" with it.
 *   2. **Studio origins only.** A browser always says which page is asking.
 *      Anything that is not a studio this companion was told about is refused
 *      before the token is even looked at, and gets no CORS headers, so the
 *      page cannot read the refusal either.
 *   3. **The pairing token.** Every route but the greeting needs it, and the
 *      greeting says nothing about this machine without it.
 */

export interface CompanionEvent {
  kind: 'paired' | 'refused' | 'login' | 'run-started' | 'run-finished' | 'installed' | 'error';
  message: string;
}

export interface CompanionOptions {
  token: string;
  /** Origins allowed to call, e.g. `https://studio.example` and `http://localhost:3000`. */
  origins: readonly string[];
  version: string;
  repository: CompanionRepository | null;
  /** Absent when the companion is not inside a repository: agents only, no runs or installs. */
  runs: StudioRuns | null;
  host?: string;
  log?: (event: CompanionEvent) => void;
  /** Seams for the tests; the defaults ask the real CLIs and write the real repository. */
  agentsStatus?: () => Promise<AgentsStatus>;
  logout?: (agent: AgentId) => Promise<{ ok: boolean; detail: string }>;
  logins?: LoginSessions;
  installFiles?: (root: string, files: unknown) => Promise<InstallResponse>;
  heartbeatMs?: number;
}

export interface Companion {
  server: Server;
  listen(port: number): Promise<number>;
  close(): Promise<void>;
  port(): number;
}

const MAX_BODY = 2_000_000;
const LOOPBACK_NAMES = ['127.0.0.1', 'localhost', '[::1]'];

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function normalizeOrigin(value: string): string {
  const url = new URL(value);
  return url.origin;
}

export function createCompanion(options: CompanionOptions): Companion {
  const origins = new Set(options.origins.map(normalizeOrigin));
  const log = options.log ?? (() => undefined);
  const logins = options.logins ?? new LoginSessions();
  const agentsStatus = options.agentsStatus ?? liveAgentsStatus;
  const logout = options.logout ?? liveLogout;
  const install = options.installFiles ?? liveInstallFiles;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const startedAt = new Date().toISOString();
  const pairedOrigins = new Set<string>();
  const refusedOrigins = new Set<string>();
  const streams = new Set<ServerResponse>();
  let boundPort = 0;

  const capabilities: CompanionCapability[] = options.runs === null ? ['agents'] : ['agents', 'runs', 'install'];

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) log({ kind: 'error', message: errorMessage(error) });
      if (!response.headersSent) send(response, status, { error: errorMessage(error) });
      else response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // 1. Loopback, by name.
    const host = (request.headers.host ?? '').toLowerCase();
    if (!LOOPBACK_NAMES.some((name) => host === `${name}:${boundPort}`)) {
      throw new HttpError(403, 'This companion only answers on 127.0.0.1.');
    }

    // 2. A studio, or no browser at all.
    const origin = request.headers.origin;
    if (origin !== undefined) {
      let allowed = false;
      try {
        allowed = origins.has(normalizeOrigin(origin));
      } catch {
        allowed = false;
      }
      if (!allowed) {
        if (!refusedOrigins.has(origin)) {
          refusedOrigins.add(origin);
          log({ kind: 'refused', message: `Refused ${origin}: not a studio this companion was started for (--allow-origin adds one).` });
        }
        throw new HttpError(403, 'This origin is not a studio this companion was started for.');
      }
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('vary', 'Origin');
    }

    if (request.method === 'OPTIONS') {
      response.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
      response.setHeader('access-control-allow-headers', 'authorization, content-type');
      response.setHeader('access-control-max-age', '600');
      // Chrome asks before a public page may reach a private address, and
      // this is the answer it wants to hear from the private side.
      if (request.headers['access-control-request-private-network'] === 'true') {
        response.setHeader('access-control-allow-private-network', 'true');
      }
      response.writeHead(204).end();
      return;
    }

    // 3. The token.
    const header = request.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;
    const authorized = tokensMatch(options.token, presented);

    const url = new URL(request.url ?? '/', `http://127.0.0.1:${boundPort}`);
    const parts = url.pathname.split('/').filter(Boolean);
    const route = `${request.method ?? 'GET'} /${parts.map((part, index) => (index >= 2 ? ':' : part)).join('/')}`;

    if (route === 'GET /v1/hello') {
      const hello: HelloResponse = { product: 'relay', protocol: PROTOCOL_VERSION, authorized };
      if (authorized) {
        if (origin !== undefined && !pairedOrigins.has(origin)) {
          pairedOrigins.add(origin);
          log({ kind: 'paired', message: `Studio connected from ${origin}.` });
        }
        Object.assign(hello, {
          version: options.version,
          machine: hostname(),
          platform: process.platform,
          repository: options.repository,
          capabilities,
          startedAt,
        });
      }
      send(response, 200, hello);
      return;
    }

    if (!authorized) throw new HttpError(401, 'Pair this studio first: open the link `relay connect` printed.');

    const [, , a, b, c] = parts;
    switch (route) {
      case 'GET /v1/agents':
        send(response, 200, await agentsStatus());
        return;

      case 'POST /v1/agents/:/:': {
        if (!isAgentId(a)) throw new HttpError(404, 'Unknown agent.');
        if (b === 'logout') {
          const result = await logout(a);
          if (result.ok) log({ kind: 'login', message: `Signed out of ${AGENT_META[a].name}.` });
          send(response, result.ok ? 200 : 500, result);
          return;
        }
        if (b !== 'login') throw new HttpError(404, 'No such route.');
        const body = await readJson(request, { optional: true });
        const mode = (body as { mode?: unknown } | undefined)?.mode ?? 'browser';
        if (!isLoginMode(mode)) throw new HttpError(400, 'Unknown sign-in mode.');
        const started = await logins.start(a, mode);
        if (!started.ok) throw new HttpError(500, started.error);
        log({ kind: 'login', message: `Started ${AGENT_META[a].name}'s own sign-in for the studio.` });
        send(response, 200, (await logins.awaitDetails(started.session.id)) ?? started.session);
        return;
      }

      case 'GET /v1/logins/:': {
        const found = logins.get(a ?? '');
        if (found === undefined) throw new HttpError(404, 'No such sign-in.');
        send(response, 200, found);
        return;
      }

      case 'DELETE /v1/logins/:':
        send(response, 200, { ok: logins.cancel(a ?? '') });
        return;

      case 'POST /v1/logins/:/:': {
        if (b !== 'code') throw new HttpError(404, 'No such route.');
        const body = (await readJson(request)) as { code?: unknown };
        const result = logins.submitCode(a ?? '', typeof body.code === 'string' ? body.code : '');
        send(response, result.ok ? 200 : 400, result);
        return;
      }

      case 'GET /v1/runs':
        send(response, 200, { runs: requireRuns().list() });
        return;

      case 'POST /v1/runs': {
        const runs = requireRuns();
        let started: CompanionRunView;
        try {
          started = await runs.start(parseStartRequest(await readJson(request)));
        } catch (error) {
          if (error instanceof TaskError) throw new HttpError(400, error.message);
          throw error;
        }
        log({ kind: 'run-started', message: `Running "${started.workflow.name}" for the studio: ${describeTask(started)}.` });
        send(response, 201, started);
        return;
      }

      case 'GET /v1/runs/:':
      case 'GET /v1/runs/:/:': {
        const found = requireRuns().get(a ?? '');
        if (found === undefined) throw new HttpError(404, 'No such run on this companion.');
        if (b === 'events' && c === undefined) {
          stream(response, a ?? '');
          return;
        }
        if (b !== undefined) throw new HttpError(404, 'No such route.');
        send(response, 200, found);
        return;
      }

      case 'DELETE /v1/runs/:': {
        const stopped = await requireRuns().cancel(a ?? '');
        if (!stopped) throw new HttpError(404, 'That run is not running here.');
        send(response, 202, { ok: true });
        return;
      }

      case 'POST /v1/install': {
        if (options.repository === null) throw new HttpError(409, 'This companion was started outside a repository, so there is nowhere to install to.');
        const body = (await readJson(request)) as { files?: unknown };
        try {
          const result = await install(options.repository.root, body.files);
          const changed = result.files.filter((file) => file.status !== 'unchanged').map((file) => file.path);
          log({ kind: 'installed', message: changed.length === 0 ? 'Installed an export; every file was already up to date.' : `Installed ${changed.join(', ')}.` });
          send(response, 200, result);
        } catch (error) {
          if (error instanceof InstallError) throw new HttpError(400, error.message);
          throw error;
        }
        return;
      }

      default:
        throw new HttpError(404, 'No such route.');
    }
  }

  function requireRuns(): StudioRuns {
    if (options.runs === null) throw new HttpError(409, 'This companion was started outside a repository. Start `relay connect` inside the repository the workflow runs on.');
    return options.runs;
  }

  function stream(response: ServerResponse, id: string): void {
    response.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    streams.add(response);
    const heartbeat = setInterval(() => write({ seq: -1, type: 'ping' }), heartbeatMs);
    heartbeat.unref();
    let unsubscribe: (() => void) | undefined;
    const done = () => {
      clearInterval(heartbeat);
      unsubscribe?.();
      streams.delete(response);
    };
    function write(record: RunStreamRecord): void {
      if (response.writableEnded) return;
      response.write(`${JSON.stringify(record)}\n`);
      if (record.type === 'exit') {
        done();
        response.end();
      }
    }
    response.on('close', done);
    unsubscribe = options.runs?.subscribe(id, write);
  }

  return {
    server,
    port: () => boundPort,
    listen: (port) =>
      new Promise<number>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once('error', onError);
        server.listen(port, options.host ?? '127.0.0.1', () => {
          server.off('error', onError);
          const address = server.address();
          boundPort = typeof address === 'object' && address !== null ? address.port : port;
          resolve(boundPort);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        logins.cancelAll();
        for (const response of streams) response.end();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function describeTask(run: CompanionRunView): string {
  if (run.task.kind === 'issue') return `issue ${run.task.ref}`;
  const text = run.task.text.replace(/\s+/g, ' ');
  return `"${text.length > 60 ? `${text.slice(0, 57)}…` : text}"`;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(text);
}

async function readJson(request: IncomingMessage, options: { optional?: boolean } = {}): Promise<unknown> {
  // A JSON body is also what keeps a plain HTML form from reaching a route:
  // browsers cannot send this content type without a preflight.
  const type = request.headers['content-type'] ?? '';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'That request is larger than anything the studio sends.');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0 && options.optional === true) return undefined;
  if (!type.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'That body is not valid JSON.');
  }
}
