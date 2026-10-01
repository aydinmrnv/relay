import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { errorMessage } from '../util/errors.ts';
import type { LoginSessions } from './agents.ts';
import { terminalConfirm, type Confirm } from './confirm.ts';
import { companionListening, redeemPairingTicket, sessionToken, tokensMatch } from './pairing.ts';
import { isLoopbackOrigin, type AccountId, type AgentsStatus, type CompanionRepository, type InstallResponse, type RunStreamRecord } from './protocol.ts';
import { createRouter, parseRequestTarget, RouteError, type AuthorizeRequest, type CompanionEvent, type RouteResult } from './router.ts';
import type { StudioRuns } from './runs.ts';

export type { CompanionEvent } from './router.ts';

/**
 * The companion's HTTP side: a server on the loopback interface that only a
 * paired studio can use.
 *
 * Four independent locks, because the thing behind them can start agents
 * that write code:
 *
 *   1. **Loopback only, by name.** It binds to 127.0.0.1, and it refuses any
 *      request whose Host is not this port on a loopback name — which is what
 *      defeats DNS rebinding, where a hostile page points its own domain at
 *      127.0.0.1 and becomes "same-origin" with it.
 *   2. **Studio origins only.** A browser always says which page is asking.
 *      Anything that is not a studio this companion was told about is refused
 *      before the token is even looked at, and gets no CORS headers, so the
 *      page cannot read the refusal either. A studio served from this machine
 *      itself (`http://localhost:3000`) counts only in development
 *      (`RELAY_STUDIO_DEV=1`): otherwise whatever happens to be listening on
 *      that port would be a page this companion answers.
 *   3. **This start's session token.** Every route but the greeting needs it,
 *      and the greeting says nothing about this machine without it. It is
 *      derived when `relay connect` starts and dies when it stops
 *      (`pairing.ts`); the machine's own secret never goes to a browser.
 *   4. **The person at the terminal.** The first time a studio asks to start
 *      a run or write files, `relay connect` asks in its terminal whether
 *      that studio may (`confirm.ts`). A token alone starts nothing.
 */

export interface CompanionOptions {
  /** The machine's pairing secret. A studio presents the session token derived from it, never the secret. */
  token: string;
  /** Origins allowed to call, e.g. `https://studio.example`. Loopback origins among them count only when `dev` is on. */
  origins: readonly string[];
  version: string;
  repository: CompanionRepository | null;
  /** Absent when the companion is not inside a repository: agents only, no runs or installs. */
  runs: StudioRuns | null;
  host?: string;
  log?: (event: CompanionEvent) => void;
  /** Whether a studio on this machine itself may connect. Defaults to `RELAY_STUDIO_DEV=1`. */
  dev?: boolean;
  /** Asks the person whether a studio may start runs and write files. Defaults to a question on the terminal. */
  confirm?: Confirm;
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
/** The environment variable that lets a studio on this machine itself connect: for working on the studio, not for using it. */
export const STUDIO_DEV_VARIABLE = 'RELAY_STUDIO_DEV';
/** After this many refusals at the terminal, a studio is not asked about again until `relay connect` restarts. */
const MAX_REFUSALS = 3;

/** The loopback server's own refusals share the router's error, so one handler answers both. */
const HttpError = RouteError;

export function normalizeOrigin(value: string): string {
  const url = new URL(value);
  return url.origin;
}

export function createCompanion(options: CompanionOptions): Companion {
  const dev = options.dev ?? process.env[STUDIO_DEV_VARIABLE] === '1';
  const configured = options.origins.map(normalizeOrigin);
  const origins = new Set(configured.filter((origin) => dev || !isLoopbackOrigin(origin)));
  /** Origins that would be allowed in development: refused with a message that says so. */
  const devOnly = new Set(configured.filter((origin) => !origins.has(origin)));
  const session = sessionToken(options.token);
  const confirm = options.confirm ?? terminalConfirm();
  const log = options.log ?? (() => undefined);
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const pairedOrigins = new Set<string>();
  const refusedOrigins = new Set<string>();
  const streams = new Set<ServerResponse>();
  let boundPort = 0;

  /* -------------------------------------------------------------- */
  /* Lock 4: the person at the terminal                              */
  /* -------------------------------------------------------------- */

  const NO_BROWSER = '(not a browser)';
  const approved = new Set<string>();
  const refusals = new Map<string, number>();
  const asking = new Map<string, Promise<void>>();

  /**
   * Resolves once the person has said this studio may start runs and write
   * files here; throws a 403 with what to do otherwise. Asked once per studio
   * per start: requests that arrive while the question is up wait for the
   * same answer, and a studio refused three times is not asked about again.
   */
  function authorize(ask: AuthorizeRequest): Promise<void> {
    const key = ask.origin ?? NO_BROWSER;
    if (approved.has(key)) return Promise.resolve();
    if ((refusals.get(key) ?? 0) >= MAX_REFUSALS) {
      return Promise.reject(new HttpError(403, 'This studio was refused in the terminal several times. Restart `relay connect` to be asked again.'));
    }
    const pending = asking.get(key);
    if (pending !== undefined) return pending;
    const question = confirm({ origin: ask.origin, action: ask.action, summary: ask.summary })
      .then((answer) => {
        if (answer.allowed) {
          approved.add(key);
          log({ kind: 'paired', message: `Allowed ${ask.origin ?? 'this machine'} to start runs and install exports until this stops.` });
          return;
        }
        if (answer.asked) refusals.set(key, (refusals.get(key) ?? 0) + 1);
        log({ kind: 'refused', message: `Did not ${ask.action === 'run' ? 'start a run' : 'install an export'} for ${ask.origin ?? 'a program on this machine'}: not confirmed in this terminal.` });
        throw new HttpError(403, answer.reason);
      })
      .finally(() => asking.delete(key));
    asking.set(key, question);
    return question;
  }

  const router = createRouter({
    version: options.version,
    repository: options.repository,
    runs: options.runs,
    log,
    authorize,
    ...(options.agentsStatus === undefined ? {} : { agentsStatus: options.agentsStatus }),
    ...(options.logout === undefined ? {} : { logout: options.logout }),
    ...(options.logins === undefined ? {} : { logins: options.logins }),
    ...(options.installFiles === undefined ? {} : { installFiles: options.installFiles }),
  });

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      // Nothing may throw from here: this is the last thing between a bad
      // request and an unhandled rejection, which would end `relay connect`.
      try {
        const status = error instanceof RouteError ? error.status : 500;
        if (status === 500) log({ kind: 'error', message: errorMessage(error) });
        if (!response.headersSent) send(response, status, { error: errorMessage(error) });
        else response.end();
      } catch {
        response.destroy();
      }
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // 1. Loopback, by name.
    const host = (request.headers.host ?? '').toLowerCase();
    if (!LOOPBACK_NAMES.some((name) => host === `${name}:${boundPort}`)) {
      throw new HttpError(403, 'This companion only answers on 127.0.0.1.');
    }

    const method = request.method ?? 'GET';
    const url = request.url ?? '/';
    const target = parseRequestTarget(url);
    if (target === null) throw new HttpError(400, 'That is not a path.');

    // Where `relay connect` sends the browser to pair: a single-use ticket,
    // exchanged for the pairing link by a redirect, so the link and its token
    // were never on a command line. A navigation carries no Origin and no
    // token; the ticket is what it has, and it works once.
    const ticket = /^\/pair\/([A-Za-z0-9_-]{16,64})$/.exec(target.pathname);
    if (method === 'GET' && ticket !== null) {
      const link = redeemPairingTicket(ticket[1]!);
      if (link === null) throw new HttpError(410, 'This pairing link was already used, or is too old. Open the link `relay connect` printed in its terminal.');
      response.writeHead(302, { location: link, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      response.end();
      return;
    }

    // 2. A studio, or no browser at all.
    const origin = request.headers.origin;
    if (origin !== undefined) {
      let normalized: string | null = null;
      try {
        normalized = normalizeOrigin(origin);
      } catch {
        normalized = null;
      }
      if (normalized === null || !origins.has(normalized)) {
        if (!refusedOrigins.has(origin)) {
          refusedOrigins.add(origin);
          log({
            kind: 'refused',
            message:
              normalized !== null && (devOnly.has(normalized) || isLoopbackOrigin(normalized))
                ? `Refused ${normalized}: a studio on this machine is only allowed in development. Set ${STUDIO_DEV_VARIABLE}=1 and start \`relay connect\` again.`
                : `Refused ${origin}: not a studio this companion was started for (--allow-origin adds one).`,
          });
        }
        throw new HttpError(403, 'This origin is not a studio this companion was started for.');
      }
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('vary', 'Origin');
    }

    if (method === 'OPTIONS') {
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

    // 3. This start's session token.
    const header = request.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;
    const authorized = tokensMatch(session, presented);
    // The machine's own secret, from a caller that is not a browser, gets the
    // greeting and nothing else: it is how a second `relay connect` finds out
    // that the port is taken by the first.
    const local = origin === undefined && tokensMatch(options.token, presented);

    if (method === 'GET' && target.pathname.replace(/\/+$/, '') === '/v1/hello') {
      if (authorized && origin !== undefined && !pairedOrigins.has(origin)) {
        pairedOrigins.add(origin);
        log({ kind: 'paired', message: `Studio connected from ${origin}.` });
      }
      send(response, 200, router.hello(authorized || local));
      return;
    }

    if (!authorized) throw new HttpError(401, 'Pair this studio first: open the link `relay connect` printed. A link from an earlier start no longer works.');

    const result: RouteResult = await router.handle({ method, url, origin: origin ?? null, json: (opts) => readJson(request, opts) });
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
          companionListening(boundPort, true);
          resolve(boundPort);
        });
      }),
    close: async () => {
      companionListening(boundPort, false);
      router.logins.cancelAll();
      // Before the streams are closed, so each run's last records still reach whoever is following it.
      await options.runs?.shutdown();
      await new Promise<void>((resolve) => {
        for (const response of streams) response.end();
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
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
