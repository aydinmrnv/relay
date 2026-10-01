import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import { tokensMatch } from '../../studio/pairing.ts';
import { PROTOCOL_VERSION, type HelloResponse, type RunStreamRecord } from '../../studio/protocol.ts';
import { decodeSegment, parseRequestTarget } from '../../studio/router.ts';
import { errorMessage } from '../../util/errors.ts';
import { FrameError, parseRunnerFrame } from '../frames.ts';
import { acceptWebSocket, isWebSocketUpgrade, refuseUpgrade } from '../ws.ts';
import { AuthError, bearer, DEFAULT_OWN_TOKEN_TTL_MS, mintRunnerToken, verifyRunnerToken, type RunnerToken, type SessionClaims } from './auth.ts';
import type { Fleet } from './fleet.ts';
import { LinkLost, RunnerLink } from './link.ts';

/**
 * The hub: the one piece of Relay Cloud with an address on the internet.
 *
 * Runners dial in to `/v1/runner/connect` and stay connected. The studio
 * calls the hub exactly as it calls `relay connect` on 127.0.0.1 — the same
 * `/v1/...` routes, the same bodies — with the person's Clerk session token
 * where the pairing token would be, and the hub carries each request down
 * that person's runner's socket. `/cloud/v1/runner` is the one thing a laptop
 * does not have: the machine's own state, and a way to wake it.
 *
 * What the hub never does: log a body, keep a token, or read a sign-in. A
 * pasted authorization code passes through it on its way to the CLI on the
 * person's own machine, and is forgotten with the request.
 */

export interface SessionVerifier {
  verify(token: string | null): Promise<SessionClaims>;
}

/** Fixed tokens for a development hub, never for one people use: `token=user_id` pairs. */
export class StaticVerifier implements SessionVerifier {
  private readonly users: Map<string, string>;
  constructor(pairs: Iterable<[string, string]>) {
    this.users = new Map(pairs);
  }
  async verify(token: string | null): Promise<SessionClaims> {
    for (const [known, userId] of this.users) {
      if (tokensMatch(known, token)) return { userId, sessionId: null, expiresAt: Date.now() + 60_000 };
    }
    throw new AuthError('Sign in to use Relay Cloud.');
  }
}

export interface HubLogEntry {
  level: 'info' | 'warn' | 'error';
  msg: string;
  [key: string]: unknown;
}

export interface HubOptions {
  fleet: Fleet;
  /** Signs runner tokens. */
  secret: string;
  /** Earlier secrets, whose tokens are still read while the machines holding them are re-keyed. */
  previousSecrets?: readonly string[];
  sessions: SessionVerifier;
  /** Studio origins allowed to call from a browser. */
  origins: readonly string[];
  version: string;
  /** The operator's token for `/admin/v1`; null switches those routes off. */
  adminToken?: string | null;
  /** The Relay tarball runners install, served at `/runner/relay.tgz`. */
  tarballPath?: string | null;
  /** The versions of the coding CLIs runner machines should have, stated beside the package so a changed pin reaches machines that already exist. */
  cliVersions?: { claudeCode: string; codex: string };
  log?: (entry: HubLogEntry) => void;
  requestTimeoutMs?: number;
  /** How long a request that needs the machine waits for it to wake. */
  wakeWaitMs?: number;
  /** How long a run's stream waits for a runner that dropped to come back. */
  resumeWindowMs?: number;
  heartbeatMs?: number;
  /** Requests one person may have open at once. */
  maxInflightPerUser?: number;
  /** Run streams one person may follow at once. A stream outlives the request that opened it, so it is counted on its own. */
  maxStreamsPerUser?: number;
  /** Bytes that may wait unread on a runner's socket, or on a browser's run stream, before it is cut. */
  maxBuffered?: number;
}

export interface Hub {
  server: Server;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
  links(): number;
}

const MAX_BODY = 2_000_000;
const MAX_FRAME = 4 * 1024 * 1024;
/** The request line of anything the hub forwards; the runner's own limit is far above it. */
const MAX_URL = 4_096;
const FORWARDED_METHODS = new Set(['GET', 'POST', 'DELETE']);

class HttpError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function createHub(options: HubOptions): Hub {
  const fleet = options.fleet;
  const log = options.log ?? (() => undefined);
  const origins = new Set(options.origins.map((origin) => new URL(origin).origin));
  const requestTimeout = options.requestTimeoutMs ?? 60_000;
  const wakeWait = options.wakeWaitMs ?? 150_000;
  const resumeWindow = options.resumeWindowMs ?? 180_000;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const maxInflight = options.maxInflightPerUser ?? 16;
  const maxStreams = options.maxStreamsPerUser ?? 8;
  const maxBuffered = options.maxBuffered ?? 16 * 1024 * 1024;
  const streams = new Map<string, number>();
  const secrets = [options.secret, ...(options.previousSecrets ?? [])];
  const links = new Map<string, RunnerLink>();
  const inflight = new Map<string, number>();
  const openResponses = new Set<ServerResponse>();

  /**
   * Nothing a caller sends may end the process. Every entry point — a request,
   * an upgrade, a frame, a socket closing — runs inside a handler that turns a
   * throw into an answer for that one caller, and none of these handlers can
   * throw themselves: an exception here would be an unhandled rejection or an
   * uncaught exception, and the hub going down takes every person's machine
   * and every run stream with it. (`relay hub serve` adds process-level
   * handlers as well, for whatever this still misses.)
   */
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      try {
        const status = error instanceof HttpError ? error.status : error instanceof AuthError ? 401 : 500;
        // The path as sent, cut short: it may be the very thing that could not be parsed.
        if (status === 500) log({ level: 'error', msg: 'request failed', path: pathOf(request) ?? (request.url ?? '').slice(0, 200), error: errorMessage(error) });
        if (!response.headersSent) send(response, status, { error: errorMessage(error), ...(error instanceof HttpError ? error.extra : {}) });
        else response.end();
      } catch {
        response.destroy();
      }
    });
  });
  server.on('upgrade', (request, socket, head) => {
    try {
      onUpgrade(request, socket, head);
    } catch (error) {
      log({ level: 'error', msg: 'upgrade failed', error: errorMessage(error) });
      socket.destroy();
    }
  });
  // An error on the listening socket after start (out of file descriptors, say) is logged, not thrown.
  server.on('error', (error) => log({ level: 'error', msg: 'server error', error: errorMessage(error) }));
  // Long-lived streams and sockets are the point; Node's defaults would cut them.
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 65_000;

  /* -------------------------------------------------------------- */
  /* Runners                                                         */
  /* -------------------------------------------------------------- */

  function onUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => undefined);
    const path = pathOf(request);
    if (path === null) return refuseUpgrade(socket, 400, 'That is not a path.');
    if (path !== '/v1/runner/connect') return refuseUpgrade(socket, 404, 'No such endpoint.');
    if (!isWebSocketUpgrade(request)) return refuseUpgrade(socket, 426, 'Connect with a WebSocket.');
    const verified = verifyRunnerToken(secrets, bearer(request.headers.authorization));
    if (verified === null) {
      log({ level: 'warn', msg: 'refused a runner: bad token', ip: request.socket.remoteAddress });
      return refuseUpgrade(socket, 401, 'That runner token is not one this hub made, or it has expired.');
    }
    // Signed by the hub is not the same as still good: the fleet knows which
    // token each machine holds now (see `Fleet.admits`).
    const admission = fleet.admits(verified);
    if (!admission.ok) {
      log({ level: 'warn', msg: 'refused a runner: its token is not current', runner: verified.runner, reason: admission.reason, ip: request.socket.remoteAddress });
      return refuseUpgrade(socket, admission.status, admission.reason);
    }
    const identity: RunnerToken = verified;
    const ws = acceptWebSocket(request, socket, head, { maxPayload: MAX_FRAME, pingIntervalMs: 20_000, maxBuffered });
    const link = new RunnerLink(ws, identity);
    let greeted = false;
    const greeting = setTimeout(() => {
      if (!greeted) link.close(4408, 'no hello');
    }, 15_000);
    greeting.unref();

    // A frame that is not what its type promises ends this connection and
    // nothing else: the runner dials back, and no other person's link notices.
    ws.onMessage((text) => {
      try {
        onFrame(text);
      } catch (error) {
        const malformed = error instanceof FrameError;
        log({ level: malformed ? 'warn' : 'error', msg: malformed ? 'closed a runner that sent a malformed frame' : 'a runner frame failed', runner: identity.runner, error: errorMessage(error) });
        link.close(malformed ? 1007 : 1011, malformed ? 'malformed frame' : 'internal error');
      }
    });

    function onFrame(text: string): void {
      const frame = parseRunnerFrame(text);
      if (frame === null) return;
      if (frame.t === 'hello') {
        if (greeted) return;
        greeted = true;
        clearTimeout(greeting);
        link.hello = frame.hello;
        link.activity = frame.activity;
        const previous = links.get(identity.userId);
        links.set(identity.userId, link);
        if (!fleet.connected(identity, link, frame.activity)) {
          links.delete(identity.userId);
          if (previous !== undefined) links.set(identity.userId, previous);
          link.close(4000, 'going to sleep');
          return;
        }
        if (previous !== undefined && previous !== link) {
          // Normal when a runner's network blinked and its old socket has not
          // noticed. Two live holders of one token is also what a copied token
          // looks like, so it is said, at a level someone reads.
          if (previous.open) log({ level: 'warn', msg: 'a runner connected while its earlier connection was still open; the earlier one is closed', runner: identity.runner });
          previous.close(4409, 'replaced by a newer connection');
        }
        ws.send(JSON.stringify({ t: 'welcome', runner: identity.runner }));
        log({ level: 'info', msg: 'runner connected', runner: identity.runner, version: frame.hello.version ?? null });
        return;
      }
      if (!greeted) return;
      if (frame.t === 'activity') {
        link.activity = frame.activity;
        // Only from the connection the fleet is routing to: one it refused or replaced says nothing about the machine.
        if (links.get(identity.userId) === link) fleet.reportActivity(identity.userId, frame.activity);
        return;
      }
      link.receive(frame);
    }

    ws.onClose((code) => {
      clearTimeout(greeting);
      try {
        link.failAll();
      } catch (error) {
        log({ level: 'error', msg: 'failing the requests of a lost runner failed', runner: identity.runner, error: errorMessage(error) });
      }
      if (links.get(identity.userId) === link) links.delete(identity.userId);
      fleet.disconnected(identity.userId, link);
      if (greeted) log({ level: 'info', msg: 'runner disconnected', runner: identity.runner, code });
    });
  }

  /* -------------------------------------------------------------- */
  /* HTTP                                                            */
  /* -------------------------------------------------------------- */

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = pathOf(request);
    if (path === null) throw new HttpError(400, 'That is not a path.');
    const method = request.method ?? 'GET';

    // Open to anyone, so it says the hub is up and nothing about who uses it:
    // how many machines exist, are awake or are queued is the operator's to
    // read, behind the admin token, at /admin/v1/fleet.
    if (path === '/healthz' && method === 'GET') {
      send(response, 200, { ok: true, version: options.version });
      return;
    }
    if (path === '/runner/relay.tgz' && (method === 'GET' || method === 'HEAD')) return serveTarball(response, method);
    if (path.startsWith('/admin/')) return admin(request, response, method, path);

    // Everything else is the studio's, from a browser or not.
    const origin = request.headers.origin;
    if (origin !== undefined) {
      if (!origins.has(origin)) throw new HttpError(403, 'This hub does not serve that studio.');
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('vary', 'Origin');
      response.setHeader('access-control-expose-headers', 'retry-after');
    }
    if (method === 'OPTIONS') {
      response.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
      response.setHeader('access-control-allow-headers', 'authorization, content-type');
      response.setHeader('access-control-max-age', '600');
      response.writeHead(204).end();
      return;
    }

    if (!path.startsWith('/v1/') && !path.startsWith('/cloud/v1/')) throw new HttpError(404, 'No such route.');
    const claims = await options.sessions.verify(bearer(request.headers.authorization));
    const userId = claims.userId;

    const open = inflight.get(userId) ?? 0;
    if (open >= maxInflight) throw new HttpError(429, 'Too many requests at once. Wait for the ones in flight.');
    inflight.set(userId, open + 1);
    try {
      if (path.startsWith('/cloud/v1/')) return await cloud(request, response, method, path, userId);
      return await proxy(request, response, method, path, userId);
    } finally {
      const now = (inflight.get(userId) ?? 1) - 1;
      if (now <= 0) inflight.delete(userId);
      else inflight.set(userId, now);
    }
  }

  async function cloud(request: IncomingMessage, response: ServerResponse, method: string, path: string, userId: string): Promise<void> {
    const route = `${method} ${path.replace(/\/+$/, '')}`;
    switch (route) {
      case 'GET /cloud/v1/runner':
        send(response, 200, fleet.status(userId));
        return;
      case 'POST /cloud/v1/runner/wake': {
        await drain(request);
        const status = await fleet.wake(userId);
        log({ level: 'info', msg: 'wake', user: userId, state: status.state });
        send(response, status.error !== null && status.state !== 'ready' && status.state !== 'queued' ? 409 : 202, status);
        return;
      }
      case 'POST /cloud/v1/runner/sleep':
        await drain(request);
        send(response, 202, await fleet.sleep(userId));
        return;
      case 'DELETE /cloud/v1/runner':
        log({ level: 'info', msg: 'remove', user: userId });
        send(response, 202, await fleet.remove(userId));
        return;
      default:
        throw new HttpError(404, 'No such route.');
    }
  }

  async function proxy(request: IncomingMessage, response: ServerResponse, method: string, path: string, userId: string): Promise<void> {
    const url = request.url ?? '/';
    // Refused here rather than forwarded: the runner has nothing to answer them with.
    if (!FORWARDED_METHODS.has(method)) throw new HttpError(405, 'Relay Cloud answers GET, POST and DELETE.');
    if (url.length > MAX_URL) throw new HttpError(414, 'That address is longer than any the studio sends.');

    if (method === 'GET' && path.replace(/\/+$/, '') === '/v1/hello') {
      const status = fleet.status(userId);
      const link = links.get(userId);
      const hello: HelloResponse =
        link?.hello !== null && link?.hello !== undefined
          ? { ...link.hello, authorized: true, cloud: status }
          : { product: 'relay', protocol: PROTOCOL_VERSION, authorized: true, machine: 'Relay Cloud', capabilities: [], cloud: status };
      send(response, 200, hello);
      return;
    }

    const events = /^\/v1\/runs\/([^/]+)\/events\/?$/.exec(path);
    if (method === 'GET' && events !== null) {
      const runId = decodeSegment(events[1]!);
      if (runId === null) throw new HttpError(400, 'That is not a run.');
      const since = Number(parseRequestTarget(url)?.searchParams.get('since') ?? '0');
      return followRun(response, userId, runId, Number.isInteger(since) && since > 0 ? since : 0);
    }

    // The body is read first, so a request that waits for the machine to wake
    // is not also holding an unread upload open.
    const body = method === 'POST' ? await readJson(request) : (await drain(request), undefined);
    // A request that starts something is refused for someone who is no longer
    // admitted, or whose machine has had its day: stopping a run and reading
    // are still allowed, so work in flight can be watched to its end.
    if (method === 'POST') {
      const refusal = fleet.refusal(userId);
      if (refusal !== null) throw new HttpError(403, refusal, { cloud: fleet.status(userId) });
    }
    const link = await runnerFor(userId, method === 'POST');
    const release = fleet.use(userId, { touch: method !== 'GET' });
    try {
      const answer = await link.request(method, url, body, requestTimeout);
      send(response, answer.status, answer.body);
    } catch (error) {
      if (error instanceof LinkLost) throw new HttpError(502, 'Lost the connection to your cloud machine. Try again in a moment.', { cloud: fleet.status(userId) });
      throw new HttpError(504, errorMessage(error));
    } finally {
      release();
    }
  }

  /** The person's runner, woken first when the request is one that should wake it. */
  async function runnerFor(userId: string, wake: boolean): Promise<RunnerLink> {
    let link = links.get(userId);
    if (link !== undefined && link.open) return link;
    if (!wake) {
      throw new HttpError(503, 'Your cloud machine is asleep. Start it from the studio, or run something and it wakes up.', { cloud: fleet.status(userId) });
    }
    const status = await fleet.wake(userId);
    if (status.state !== 'ready' && status.error !== null && status.state !== 'queued' && status.state !== 'creating' && status.state !== 'starting') {
      throw new HttpError(409, status.error, { cloud: status });
    }
    const ready = await fleet.whenReady(userId, wakeWait);
    link = links.get(userId);
    if (!ready || link === undefined || !link.open) {
      throw new HttpError(503, 'Your cloud machine is still starting. This takes about a minute, and a few the first time.', { cloud: fleet.status(userId) });
    }
    return link;
  }

  /**
   * Follows a run for the studio, across the runner's reconnects: when the
   * socket drops mid-run, the browser's stream stays open, and once the runner
   * is back the hub asks again from the first record the browser has not seen.
   */
  function followRun(response: ServerResponse, userId: string, runId: string, since: number): void {
    // A stream stays open long after `handle` has returned and given back the
    // request's place in `inflight`, so streams have a count of their own:
    // without one, a person could hold any number open.
    const open = streams.get(userId) ?? 0;
    if (open >= maxStreams) throw new HttpError(429, 'Too many run streams open at once. Close a studio tab that is following a run.');
    streams.set(userId, open + 1);

    let next = since;
    /** Nothing more is written, and the stream's place has been given back. */
    let done = false;
    let cancel: (() => void) | null = null;
    let started = false;

    /** Ends the stream's bookkeeping, once. False when it had already ended. */
    const settle = (): boolean => {
      if (done) return false;
      done = true;
      clearInterval(heartbeat);
      cancel?.();
      openResponses.delete(response);
      const left = (streams.get(userId) ?? 1) - 1;
      if (left <= 0) streams.delete(userId);
      else streams.set(userId, left);
      return true;
    };
    /** Ends it with a JSON answer if nothing was streamed yet, and by closing the stream if something was. */
    const answer = (status: number, body: unknown): void => {
      if (!settle()) return;
      if (!started && !response.headersSent) send(response, status, body);
      else response.end();
    };
    const finish = (): void => answer(503, { error: 'Your cloud machine is not connected.', cloud: fleet.status(userId) });

    const begin = (): void => {
      if (started) return;
      started = true;
      response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      // Sent now, not with the first record: a run that is quiet for a while has still been found.
      response.flushHeaders();
      openResponses.add(response);
    };
    const write = (record: RunStreamRecord): void => {
      if (done || response.writableEnded) return;
      begin();
      // A browser that has stopped reading gets no more: the records would
      // wait in this process instead. The studio picks a cut stream back up
      // from the first record it has not seen.
      if (response.writableLength > maxBuffered) {
        log({ level: 'warn', msg: 'cut a run stream nobody was reading', user: userId });
        settle();
        response.destroy();
        return;
      }
      response.write(`${JSON.stringify(record)}\n`);
    };
    const heartbeat = setInterval(() => {
      if (started) write({ seq: -1, type: 'ping' });
    }, heartbeatMs);
    heartbeat.unref();
    // The response's close, not the request's: a request's fires as soon as its (empty) body is read.
    response.on('close', () => {
      settle();
    });

    // The stream's steps run on their own, with nobody awaiting them: a step
    // that throws ends this one stream instead of becoming an unhandled rejection.
    const step = (work: () => Promise<void>): void => {
      void work().catch((error: unknown) => {
        log({ level: 'error', msg: 'following a run failed', user: userId, error: errorMessage(error) });
        try {
          finish();
        } catch {
          response.destroy();
        }
      });
    };

    const waitForRunner = async (): Promise<void> => {
      const back = await fleet.whenReady(userId, resumeWindow);
      if (done) return;
      if (back) step(attach);
      else finish();
    };

    const attach = async (): Promise<void> => {
      const link = links.get(userId);
      if (link === undefined || !link.open) {
        // Nothing to resume: the first ask of a stream does not wait for a sleeping machine.
        if (!started) return answer(503, { error: 'Your cloud machine is asleep.', cloud: fleet.status(userId) });
        return waitForRunner();
      }
      const follow = link.follow(
        `/v1/runs/${encodeURIComponent(runId)}/events?since=${next}`,
        (record) => {
          if (record.type === 'ping') return;
          next = Math.max(next, record.seq + 1);
          write(record);
        },
        (reason) => {
          if (reason === 'exit') finish();
          else if (reason === 'lost' && !done) step(waitForRunner);
        },
      );
      cancel = follow.cancel;
      try {
        const opened = await follow.started;
        if (done) return follow.cancel();
        if (!opened.stream) {
          if (!started) return answer(opened.status, opened.body);
          // The runner came back without this run: its process restarted, and the run went with it.
          write({ seq: next, type: 'exit', code: null, error: 'Your cloud machine restarted while this run was going, and the run did not survive it.' });
          finish();
          return;
        }
        begin();
      } catch (error) {
        if (done) return;
        if (error instanceof LinkLost) return waitForRunner();
        answer(504, { error: errorMessage(error) });
      }
    };

    step(attach);
  }

  /* -------------------------------------------------------------- */
  /* The operator                                                    */
  /* -------------------------------------------------------------- */

  async function admin(request: IncomingMessage, response: ServerResponse, method: string, path: string): Promise<void> {
    if (options.adminToken === null || options.adminToken === undefined || !tokensMatch(options.adminToken, bearer(request.headers.authorization))) {
      throw new HttpError(404, 'No such route.');
    }
    const parts = path.split('/').filter(Boolean); // admin v1 ...
    const route = `${method} /${parts.map((part, index) => (index >= 3 ? ':' : part)).join('/')}`;
    const target = parts[3] === undefined ? '' : decodeSegment(parts[3]);
    if (target === null) throw new HttpError(400, 'That is not a user id.');
    switch (route) {
      case 'GET /admin/v1/fleet':
        send(response, 200, {
          summary: fleet.summary(),
          // Machines of people who are no longer admitted: asleep, still on disk, and the operator's to remove.
          revoked: fleet.revoked(),
          links: [...links.values()].map((link) => ({ runner: link.identity.runner, userId: link.identity.userId, since: new Date(link.connectedAt).toISOString(), activity: link.activity })),
        });
        return;
      case 'GET /admin/v1/runners/:':
        send(response, 200, fleet.status(target));
        return;
      case 'POST /admin/v1/runners/:/:': {
        await drain(request);
        const action = parts[4];
        if (action === 'wake') send(response, 202, await fleet.wake(target));
        else if (action === 'sleep') send(response, 202, await fleet.sleep(target, { force: true }));
        else if (action === 'disconnect') {
          // Drops the runner's socket; it dials straight back. For a runner that seems wedged.
          links.get(target)?.close(1012, 'disconnected by the operator');
          send(response, 202, { ok: true });
        } else throw new HttpError(404, 'No such route.');
        return;
      }
      case 'DELETE /admin/v1/runners/:':
        send(response, 202, await fleet.remove(target));
        return;
      case 'POST /admin/v1/tokens': {
        // A token for a runner the operator starts by hand: someone's own server, or a development VM.
        const sent = await readJson(request);
        // `null`, a list or nothing at all is still something an operator may send by mistake.
        const body = (sent !== null && typeof sent === 'object' ? sent : {}) as { userId?: unknown; runner?: unknown; ttlDays?: unknown };
        if (typeof body.userId !== 'string' || typeof body.runner !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(body.runner)) {
          throw new HttpError(400, 'Send {"userId": "user_…", "runner": "a-name"}, and "ttlDays" from 1 to 365 if thirty is not right.');
        }
        if (body.ttlDays !== undefined && (typeof body.ttlDays !== 'number' || !Number.isFinite(body.ttlDays) || body.ttlDays < 1 || body.ttlDays > 365)) {
          throw new HttpError(400, '"ttlDays" is a number from 1 to 365.');
        }
        const minted = mintRunnerToken(options.secret, { runner: body.runner, userId: body.userId }, { kind: 'own', ttlMs: body.ttlDays === undefined ? DEFAULT_OWN_TOKEN_TTL_MS : body.ttlDays * 24 * 60 * 60_000 });
        // The fleet would refuse it at the door; better said here, where the operator is looking.
        const admission = fleet.admits(minted);
        if (!admission.ok) throw new HttpError(400, admission.reason);
        send(response, 200, { token: minted.token, expiresAt: new Date(minted.expiresAt).toISOString() });
        return;
      }
      default:
        throw new HttpError(404, 'No such route.');
    }
  }

  /**
   * The package runners install, named by its version and a hash of its
   * bytes: a rebuilt hub with the same version number is still a different
   * Relay, and runners compare this name to decide whether to update.
   */
  let tarballTag: { key: string; tag: string; sha256: string } | null = null;
  async function serveTarball(response: ServerResponse, method: string): Promise<void> {
    const path = options.tarballPath;
    if (path === null || path === undefined) throw new HttpError(404, 'This hub serves no runner package.');
    const info = await stat(path).catch(() => null);
    if (info === null) throw new HttpError(404, 'The runner package is missing.');
    const key = `${info.size}:${info.mtimeMs}`;
    if (tarballTag?.key !== key) {
      const sha256 = createHash('sha256').update(await readFile(path)).digest('hex');
      tarballTag = { key, tag: `${options.version}+${sha256.slice(0, 12)}`, sha256 };
    }
    response.writeHead(200, {
      'content-type': 'application/gzip',
      'content-length': info.size,
      'cache-control': 'no-store',
      'x-relay-version': tarballTag.tag,
      // The whole hash: a runner installs the file only if what it downloaded matches.
      'x-relay-sha256': tarballTag.sha256,
      ...(options.cliVersions === undefined ? {} : { 'x-relay-claude-code': options.cliVersions.claudeCode, 'x-relay-codex': options.cliVersions.codex }),
    });
    if (method === 'HEAD') {
      response.end();
      return;
    }
    // Unhandled, a read error on a stream is an uncaught exception, and the
    // file can be replaced or removed between the `stat` above and this read.
    const file = createReadStream(path);
    file.on('error', (error) => {
      log({ level: 'error', msg: 'reading the runner package failed', error: errorMessage(error) });
      response.destroy();
    });
    file.pipe(response);
  }

  return {
    server,
    links: () => links.size,
    listen: (port, host = '0.0.0.0') =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const address = server.address();
          resolve(typeof address === 'object' && address !== null ? address.port : port);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        // 1012: the service is restarting. Runners reconnect to whoever answers next.
        for (const link of links.values()) link.close(1012, 'hub restarting');
        for (const response of openResponses) response.end();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** The request's path, or null when its request line holds something that is not one (`//`, another host). Never throws. */
function pathOf(request: IncomingMessage): string | null {
  return parseRequestTarget(request.url)?.pathname ?? null;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body ?? {});
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(status === 503 ? { 'retry-after': '5' } : {}),
  });
  response.end(text);
}

async function drain(request: IncomingMessage): Promise<void> {
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'That request is too large.');
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const type = request.headers['content-type'] ?? '';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'That request is larger than anything the studio sends.');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) return undefined;
  if (!type.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'That body is not valid JSON.');
  }
}
