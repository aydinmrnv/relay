import { randomBytes } from 'node:crypto';

import type { HelloResponse, RunStreamRecord } from '../../studio/protocol.ts';
import type { HubFrame, RunnerActivity, RunnerFrame } from '../frames.ts';
import type { FleetLink } from './fleet.ts';
import type { RunnerIdentity } from './auth.ts';
import type { WsConnection } from './../ws.ts';

/**
 * The hub's end of one runner's WebSocket: sends the studio's requests down
 * it and matches the answers back up by id.
 */

export class LinkLost extends Error {}

export interface JsonAnswer {
  status: number;
  body: unknown;
}

export interface Follow {
  /** Resolves with the runner's answer to the follow: `stream` true, or a refusal such as a 404. */
  started: Promise<{ status: number; body?: unknown; stream: boolean }>;
  /** Stops following; the runner drops its subscription. */
  cancel(): void;
}

type Pending =
  | { kind: 'json'; resolve: (answer: JsonAnswer) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  | {
      kind: 'stream';
      started: boolean;
      resolve: (answer: { status: number; body?: unknown; stream: boolean }) => void;
      reject: (error: Error) => void;
      onRecord: (record: RunStreamRecord) => void;
      onEnd: (reason: 'exit' | 'lost' | 'cancelled') => void;
      timer: ReturnType<typeof setTimeout> | null;
    };

export class RunnerLink implements FleetLink {
  readonly identity: RunnerIdentity;
  readonly connectedAt = Date.now();
  hello: HelloResponse | null = null;
  activity: RunnerActivity = { runs: 0, queued: 0, logins: 0 };
  private readonly ws: WsConnection;
  private readonly pending = new Map<string, Pending>();
  private lost = false;

  constructor(ws: WsConnection, identity: RunnerIdentity) {
    this.ws = ws;
    this.identity = identity;
  }

  get open(): boolean {
    return !this.lost && this.ws.isOpen;
  }

  get inflight(): number {
    return this.pending.size;
  }

  close(code: number, reason: string): void {
    this.ws.close(code, reason);
  }

  private send(frame: HubFrame): boolean {
    return this.ws.send(JSON.stringify(frame));
  }

  private nextId(): string {
    return randomBytes(8).toString('base64url');
  }

  request(method: string, url: string, body: unknown, timeoutMs: number): Promise<JsonAnswer> {
    if (!this.open) return Promise.reject(new LinkLost('The runner is not connected.'));
    const id = this.nextId();
    return new Promise<JsonAnswer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Your cloud machine took too long to answer.'));
      }, timeoutMs);
      this.pending.set(id, { kind: 'json', resolve, reject, timer });
      const frame: HubFrame = body === undefined ? { t: 'req', id, method, url } : { t: 'req', id, method, url, body };
      if (!this.send(frame)) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new LinkLost('The runner is not connected.'));
      }
    });
  }

  follow(url: string, onRecord: (record: RunStreamRecord) => void, onEnd: (reason: 'exit' | 'lost' | 'cancelled') => void, startTimeoutMs = 30_000): Follow {
    const id = this.nextId();
    let resolveStart: (answer: { status: number; body?: unknown; stream: boolean }) => void = () => undefined;
    let rejectStart: (error: Error) => void = () => undefined;
    const started = new Promise<{ status: number; body?: unknown; stream: boolean }>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    started.catch(() => undefined);
    const timer = setTimeout(() => {
      const entry = this.pending.get(id);
      if (entry?.kind === 'stream' && !entry.started) {
        this.pending.delete(id);
        rejectStart(new Error('Your cloud machine took too long to answer.'));
      }
    }, startTimeoutMs);
    this.pending.set(id, { kind: 'stream', started: false, resolve: resolveStart, reject: rejectStart, onRecord, onEnd, timer });
    if (!this.open || !this.send({ t: 'req', id, method: 'GET', url })) {
      clearTimeout(timer);
      this.pending.delete(id);
      rejectStart(new LinkLost('The runner is not connected.'));
    }
    return {
      started,
      cancel: () => {
        const entry = this.pending.get(id);
        if (entry === undefined) return;
        this.pending.delete(id);
        if (entry.timer !== null) clearTimeout(entry.timer);
        this.send({ t: 'unfollow', id });
      },
    };
  }

  /** A frame from the runner that answers something this link asked. */
  receive(frame: RunnerFrame): void {
    if (frame.t === 'res') {
      const entry = this.pending.get(frame.id);
      if (entry === undefined) return;
      if (entry.kind === 'json') {
        clearTimeout(entry.timer);
        this.pending.delete(frame.id);
        entry.resolve({ status: frame.status, body: frame.body });
        return;
      }
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.timer = null;
      if (frame.stream === true) {
        entry.started = true;
        entry.resolve({ status: 200, stream: true });
      } else {
        this.pending.delete(frame.id);
        entry.resolve({ status: frame.status, body: frame.body, stream: false });
      }
      return;
    }
    if (frame.t === 'record') {
      const entry = this.pending.get(frame.id);
      if (entry?.kind !== 'stream') return;
      entry.onRecord(frame.record);
      if (frame.record.type === 'exit') {
        this.pending.delete(frame.id);
        entry.onEnd('exit');
      }
    }
  }

  /** The socket closed: everything waiting on it hears so. */
  failAll(): void {
    this.lost = true;
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      if (entry.kind === 'json') {
        clearTimeout(entry.timer);
        entry.reject(new LinkLost('Lost the connection to your cloud machine.'));
      } else {
        if (entry.timer !== null) clearTimeout(entry.timer);
        if (entry.started) entry.onEnd('lost');
        else entry.reject(new LinkLost('Lost the connection to your cloud machine.'));
      }
    }
  }
}
