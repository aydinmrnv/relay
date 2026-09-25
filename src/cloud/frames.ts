import type { HelloResponse, RunStreamRecord } from '../studio/protocol.ts';

/**
 * What the hub and a runner say to each other over the runner's WebSocket.
 *
 * The runner dials out and keeps one connection open; the studio's requests
 * for that runner's owner travel down it as `req` frames and come back as
 * `res` frames with the same id — companion protocol v1, the same routes and
 * the same bodies a studio sends to `relay connect` on 127.0.0.1, only framed.
 * A run's event stream is a `res` that says `stream`, followed by `record`
 * frames until the run's `exit` record, or until the hub sends `unfollow`.
 *
 * Every frame is one JSON text message. Unknown frame types are ignored on
 * both sides, so either can be newer than the other.
 */

/** What keeps a runner awake: the hub deallocates one only when all of these are zero. */
export interface RunnerActivity {
  /** Runs executing or checking out their repository. */
  runs: number;
  /** Runs waiting for a slot. */
  queued: number;
  /** Sign-ins waiting for the person to finish them. */
  logins: number;
}

export type HubFrame =
  | { t: 'welcome'; runner: string }
  | { t: 'req'; id: string; method: string; url: string; body?: unknown }
  | { t: 'unfollow'; id: string };

export type RunnerFrame =
  | { t: 'hello'; hello: HelloResponse; activity: RunnerActivity }
  | { t: 'res'; id: string; status: number; body?: unknown; stream?: true }
  | { t: 'record'; id: string; record: RunStreamRecord }
  | { t: 'activity'; activity: RunnerActivity };

/** Where a runner connects: `https://hub` becomes `wss://hub/v1/runner/connect`. */
export function runnerSocketUrl(hub: string): string {
  const url = new URL(hub);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') throw new Error(`"${hub}" is not a hub address.`);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/runner/connect`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function parseFrame<T extends { t: string }>(text: string): T | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== 'object' || typeof (value as { t?: unknown }).t !== 'string') return null;
    return value as T;
  } catch {
    return null;
  }
}
