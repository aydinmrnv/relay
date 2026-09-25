import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { errorMessage } from '../util/errors.ts';
import type { LoginSessions } from './agents.ts';
import { tokensMatch } from './pairing.ts';
import type { AccountId, AgentsStatus, CompanionRepository, InstallResponse, RunStreamRecord } from './protocol.ts';
import { createRouter, RouteError, type CompanionEvent, type RouteResult } from './router.ts';
import type { StudioRuns } from './runs.ts';

export type { CompanionEvent } from './router.ts';

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
  logout?: (account: AccountId) => Promise<{ ok: boolean; detail: string }>;
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

/** The loopback server's own refusals share the router's error, so one handler answers both. */
const HttpError = RouteError;

export function normalizeOrigin(value: string): string {
  const url = new URL(value);
  return url.origin;
}

export function createCompanion(options: CompanionOptions): Companion {
  const origins = new Set(options.origins.map(normalizeOrigin));
  const log = options.log ?? (() => undefined);
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const pairedOrigins = new Set<string>();
  const refusedOrigins = new Set<string>();
  const streams = new Set<ServerResponse>();
  let boundPort = 0;

  const router = createRouter({
    version: options.version,
    repository: options.repository,
    runs: options.runs,
    log,
    ...(options.agentsStatus === undefined ? {} : { agentsStatus: options.agentsStatus }),
    ...(options.logout === undefined ? {} : { logout: options.logout }),
    ...(options.logins === undefined ? {} : { logins: options.logins }),
    ...(options.installFiles === undefined ? {} : { installFiles: options.installFiles }),
  });

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const status = error instanceof RouteError ? error.status : 500;
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
    const method = request.method ?? 'GET';
    const url = request.url ?? '/';

    if (method === 'GET' && new URL(url, 'http://127.0.0.1').pathname.replace(/\/+$/, '') === '/v1/hello') {
      if (authorized && origin !== undefined && !pairedOrigins.has(origin)) {
        pairedOrigins.add(origin);
        log({ kind: 'paired', message: `Studio connected from ${origin}.` });
      }
      send(response, 200, router.hello(authorized));
      return;
    }

    if (!authorized) throw new HttpError(401, 'Pair this studio first: open the link `relay connect` printed.');

    const result: RouteResult = await router.handle({ method, url, json: (opts) => readJson(request, opts) });
    if (result.kind === 'json') send(response, result.status, result.body);
    else stream(response, result.follow);
  }

  function stream(response: ServerResponse, follow: (write: (record: RunStreamRecord) => void) => () => void): void {
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
    unsubscribe = follow(write);
    if (response.writableEnded) done();
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
        router.logins.cancelAll();
        for (const response of streams) response.end();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
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
