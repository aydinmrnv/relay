import { errorMessage } from '../util/errors.ts';
import type { StudioRuns } from '../studio/runs.ts';
import { RouteError, type Router } from '../studio/router.ts';
import { parseFrame, runnerSocketUrl, type HubFrame, type RunnerActivity, type RunnerFrame } from './frames.ts';

/**
 * `relay connect --hub`: the companion, reached through the hub instead of
 * on 127.0.0.1.
 *
 * A cloud runner has no public address and no open port. It dials out to the
 * hub and keeps one WebSocket open, and the hub sends the studio's requests
 * down it. Everything else is the companion as it is on a laptop: the same
 * router, the same sign-ins, the same `relay run --json` children.
 *
 * The connection is expected to drop — the hub restarts, the network blinks —
 * and nothing is lost when it does. Runs are children of this process, not
 * of the connection, so they keep going; the hub picks their streams back up
 * from the first record it has not seen once the runner is back. Reconnects
 * back off exponentially with jitter, so a hub coming back up is not met by
 * every runner in the same second.
 */

export interface DialOutOptions {
  hub: string;
  /** Asked before every attempt, so a token rotated by the hub is picked up without a restart. */
  token: () => Promise<string>;
  router: Router;
  runs: StudioRuns | null;
  log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
  /** Backoff bounds, in milliseconds. */
  minDelayMs?: number;
  maxDelayMs?: number;
  /** How often activity is re-sent even when nothing changed. */
  activityEveryMs?: number;
  /** A seam for the tests. */
  WebSocketImpl?: typeof WebSocket;
}

export interface DialOut {
  connected(): boolean;
  /** Resolves once the first connection is up, or rejects when `stop` is called first. */
  ready: Promise<void>;
  stop(): Promise<void>;
}

export function backoffDelay(attempt: number, minMs: number, maxMs: number, random: () => number = Math.random): number {
  const ceiling = Math.min(maxMs, minMs * 2 ** Math.min(attempt, 16));
  // "Equal jitter": at least half the ceiling, so a flapping hub is never hammered.
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

export function activityOf(router: Router, runs: StudioRuns | null): RunnerActivity {
  const list = runs?.list() ?? [];
  return {
    runs: list.filter((run) => run.status === 'running' && run.stage !== 'queued').length,
    queued: list.filter((run) => run.status === 'running' && run.stage === 'queued').length,
    logins: router.pendingLogins(),
  };
}

export function dialOut(options: DialOutOptions): DialOut {
  const log = options.log ?? (() => undefined);
  const minDelay = options.minDelayMs ?? 1_000;
  const maxDelay = options.maxDelayMs ?? 30_000;
  const activityEvery = options.activityEveryMs ?? 30_000;
  const Impl = options.WebSocketImpl ?? WebSocket;
  const url = runnerSocketUrl(options.hub);

  let socket: WebSocket | null = null;
  let open = false;
  let stopped = false;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let lastActivity = '';
  const follows = new Map<string, () => void>();

  let markReady: () => void = () => undefined;
  let failReady: (error: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  ready.catch(() => undefined);

  const send = (frame: RunnerFrame): void => {
    if (socket !== null && open) socket.send(JSON.stringify(frame));
  };

  const reportActivity = (force = false): void => {
    const activity = activityOf(options.router, options.runs);
    const key = JSON.stringify(activity);
    if (!force && key === lastActivity) return;
    lastActivity = key;
    send({ t: 'activity', activity });
  };
  const activityTimer = setInterval(() => reportActivity(true), activityEvery);
  activityTimer.unref();
  // Sign-ins and runs change on their own clocks; a cheap look every few
  // seconds tells the hub within moments that the machine went idle.
  const watchTimer = setInterval(() => reportActivity(false), 3_000);
  watchTimer.unref();

  const dropFollows = (): void => {
    for (const unfollow of follows.values()) unfollow();
    follows.clear();
  };

  async function answer(frame: Extract<HubFrame, { t: 'req' }>): Promise<void> {
    try {
      const result = await options.router.handle({
        method: frame.method,
        url: frame.url,
        json: async (opts) => {
          if (frame.body === undefined && opts?.optional !== true) throw new RouteError(400, 'That body is not valid JSON.');
          return frame.body;
        },
      });
      if (result.kind === 'json') {
        send({ t: 'res', id: frame.id, status: result.status, body: result.body });
        if (frame.method !== 'GET') reportActivity(false);
        return;
      }
      send({ t: 'res', id: frame.id, status: 200, stream: true });
      let unfollow: (() => void) | null = null;
      let ended = false;
      unfollow = result.follow((record) => {
        send({ t: 'record', id: frame.id, record });
        if (record.type === 'exit') {
          ended = true;
          follows.get(frame.id)?.();
          follows.delete(frame.id);
        }
      });
      if (ended) unfollow();
      else follows.set(frame.id, unfollow);
    } catch (error) {
      const status = error instanceof RouteError ? error.status : 500;
      if (status === 500) log(`A request from the studio failed: ${errorMessage(error)}`, 'error');
      send({ t: 'res', id: frame.id, status, body: { error: errorMessage(error) } });
    }
  }

  function onMessage(text: string): void {
    const frame = parseFrame<HubFrame>(text);
    if (frame === null) return;
    switch (frame.t) {
      case 'welcome':
        log(`Connected to the hub as ${frame.runner}.`);
        return;
      case 'req':
        void answer(frame);
        return;
      case 'unfollow':
        follows.get(frame.id)?.();
        follows.delete(frame.id);
        return;
      default:
        return;
    }
  }

  function schedule(): void {
    if (stopped) return;
    const delay = backoffDelay(attempt, minDelay, maxDelay);
    attempt += 1;
    retry = setTimeout(() => void connect(), delay);
  }

  async function connect(): Promise<void> {
    retry = null;
    if (stopped) return;
    let token: string;
    try {
      token = await options.token();
    } catch (error) {
      log(`No runner token yet: ${errorMessage(error)}`, 'warn');
      schedule();
      return;
    }
    let connectedAt = 0;
    const ws = new Impl(url, { headers: { authorization: `Bearer ${token}` } } as unknown as string[]);
    socket = ws;
    ws.addEventListener('open', () => {
      open = true;
      connectedAt = Date.now();
      lastActivity = '';
      const activity = activityOf(options.router, options.runs);
      lastActivity = JSON.stringify(activity);
      send({ t: 'hello', hello: options.router.hello(true), activity });
      markReady();
    });
    ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') onMessage(event.data);
    });
    ws.addEventListener('error', () => {
      // `close` follows and does the work; an error before `open` is the hub
      // being unreachable or refusing the token, which looks the same from here.
    });
    ws.addEventListener('close', (event) => {
      const wasOpen = open;
      open = false;
      if (socket === ws) socket = null;
      dropFollows();
      if (stopped) return;
      // A connection that held for a while resets the backoff; a flapping one does not.
      if (wasOpen && Date.now() - connectedAt > 30_000) attempt = 0;
      if (wasOpen) log(`Lost the hub (${event.code}${event.reason ? `: ${event.reason}` : ''}). Reconnecting.`, 'warn');
      else if (attempt === 0 || attempt % 10 === 0) log(`Could not reach the hub at ${url}. Retrying.`, 'warn');
      schedule();
    });
  }

  void connect();

  return {
    connected: () => open,
    ready,
    stop: async () => {
      stopped = true;
      clearInterval(activityTimer);
      clearInterval(watchTimer);
      if (retry !== null) clearTimeout(retry);
      dropFollows();
      failReady(new Error('stopped'));
      const current = socket;
      if (current !== null && current.readyState <= 1) {
        await new Promise<void>((resolve) => {
          current.addEventListener('close', () => resolve());
          current.close(1000, 'runner stopping');
          setTimeout(resolve, 2_000).unref();
        });
      }
    },
  };
}
