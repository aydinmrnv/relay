import type { CompanionCapability, CompanionRepository, HelloResponse, RunStreamRecord } from '../studio/protocol.ts';

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
 *
 * Nothing that arrives is trusted to have the shape its type promises. A
 * runner is a machine that runs code an agent wrote, and whatever holds its
 * token can say anything on this socket: a frame is checked field by field
 * here, once, and everything past this file works with values it can rely
 * on. A frame of a known type with the wrong shape is a `FrameError`, which
 * the receiver answers by closing the connection — never by reading a field
 * that is not there.
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

/** A frame of a type this side knows, with a shape it does not have. */
export class FrameError extends Error {}

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

/* ------------------------------------------------------------------ */
/* Reading a frame                                                     */
/* ------------------------------------------------------------------ */

/** Ids are 11 characters when the hub makes them; anything much longer is not one. */
const MAX_ID = 64;
/** Node refuses a request line longer than its header limit, so no URL the hub forwards is longer. */
const MAX_URL = 32_768;
/** No machine has this many runs or sign-ins going; a larger number is a lie or a bug. */
const MAX_COUNT = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function envelope(text: string): Record<string, unknown> & { t: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new FrameError('not JSON');
  }
  if (!isRecord(value) || typeof value['t'] !== 'string') throw new FrameError('not a frame');
  return value as Record<string, unknown> & { t: string };
}

function id(value: unknown, type: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID) throw new FrameError(`${type}: bad id`);
  return value;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined;
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_COUNT) throw new FrameError('activity: bad count');
  return value;
}

function activity(value: unknown): RunnerActivity {
  if (!isRecord(value)) throw new FrameError('activity: missing');
  return { runs: count(value['runs']), queued: count(value['queued']), logins: count(value['logins']) };
}

function repository(value: unknown): CompanionRepository | null {
  if (!isRecord(value)) return null;
  const root = text(value['root'], 4_096);
  const defaultBranch = text(value['defaultBranch'], 255);
  if (root === undefined || defaultBranch === undefined) return null;
  return { root, owner: text(value['owner'], 255) ?? null, name: text(value['name'], 255) ?? null, defaultBranch };
}

/**
 * A runner's greeting, rebuilt field by field: the hub hands it on to the
 * studio as its own answer to `/v1/hello`, so only fields of the type they
 * claim go through, and nothing a runner invented rides along.
 */
function hello(value: unknown): HelloResponse {
  if (!isRecord(value) || value['product'] !== 'relay' || typeof value['protocol'] !== 'number' || !Number.isInteger(value['protocol'])) {
    throw new FrameError('hello: not a Relay greeting');
  }
  const out: HelloResponse = { product: 'relay', protocol: value['protocol'], authorized: true };
  const version = text(value['version'], 64);
  if (version !== undefined) out.version = version;
  const machine = text(value['machine'], 255);
  if (machine !== undefined) out.machine = machine;
  const platform = text(value['platform'], 32);
  if (platform !== undefined) out.platform = platform as NodeJS.Platform;
  if (value['repository'] !== undefined) out.repository = repository(value['repository']);
  if (Array.isArray(value['capabilities'])) {
    out.capabilities = value['capabilities'].filter((item): item is CompanionCapability => typeof item === 'string' && item.length <= 32).slice(0, 32);
  }
  const startedAt = text(value['startedAt'], 64);
  if (startedAt !== undefined) out.startedAt = startedAt;
  return out;
}

function record(value: unknown): RunStreamRecord {
  if (!isRecord(value) || typeof value['seq'] !== 'number' || !Number.isSafeInteger(value['seq'])) throw new FrameError('record: bad seq');
  const seq = value['seq'];
  switch (value['type']) {
    case 'engine':
      if (seq < 0 || !isRecord(value['data'])) throw new FrameError('record: bad engine line');
      return { seq, type: 'engine', data: value['data'] };
    case 'exit': {
      const code = value['code'];
      const error = value['error'];
      if (seq < 0 || !(code === null || (typeof code === 'number' && Number.isInteger(code))) || !(error === null || typeof error === 'string')) {
        throw new FrameError('record: bad exit');
      }
      return { seq, type: 'exit', code, error };
    }
    case 'ping':
      return { seq, type: 'ping' };
    default:
      throw new FrameError('record: unknown type');
  }
}

/**
 * A frame from a runner, checked. Null for a type this hub does not know,
 * which is ignored; `FrameError` for anything else that is not a frame.
 */
export function parseRunnerFrame(message: string): RunnerFrame | null {
  const frame = envelope(message);
  switch (frame.t) {
    case 'hello':
      return { t: 'hello', hello: hello(frame['hello']), activity: activity(frame['activity']) };
    case 'activity':
      return { t: 'activity', activity: activity(frame['activity']) };
    case 'res': {
      const status = frame['status'];
      // What the hub will write as an HTTP status: Node throws on anything outside this range.
      if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599) throw new FrameError('res: bad status');
      const out: RunnerFrame = { t: 'res', id: id(frame['id'], 'res'), status };
      if (frame['body'] !== undefined) out.body = frame['body'];
      if (frame['stream'] === true) out.stream = true;
      return out;
    }
    case 'record':
      return { t: 'record', id: id(frame['id'], 'record'), record: record(frame['record']) };
    default:
      return null;
  }
}

/** A frame from the hub, checked the same way: null for an unknown type, `FrameError` for a malformed one. */
export function parseHubFrame(message: string): HubFrame | null {
  const frame = envelope(message);
  switch (frame.t) {
    case 'welcome':
      return { t: 'welcome', runner: text(frame['runner'], 255) ?? '' };
    case 'req': {
      const method = frame['method'];
      const url = frame['url'];
      // Which methods and paths exist is the router's to say, with a 404; this only checks they are text.
      if (typeof method !== 'string' || method.length === 0 || method.length > 16) throw new FrameError('req: bad method');
      if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL) throw new FrameError('req: bad url');
      const out: HubFrame = { t: 'req', id: id(frame['id'], 'req'), method, url };
      if (frame['body'] !== undefined) out.body = frame['body'];
      return out;
    }
    case 'unfollow':
      return { t: 'unfollow', id: id(frame['id'], 'unfollow') };
    default:
      return null;
  }
}
