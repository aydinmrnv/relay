import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { IssueProvider } from '../github/types.ts';
import { errorMessage } from '../util/errors.ts';
import { issueEvent, scheduleEvent, signatureValid } from './events.ts';
import type { GraphOutcome } from './executor.ts';
import { isTimeZone, nextCronTime, parseCron } from './schedule.ts';
import { APP_WEBHOOK_TRIGGERS, matchDelivery } from './triggers.ts';
import { triggerOf, type GraphNode, type WorkflowEvent, type WorkflowGraph } from './types.ts';

/**
 * Keeps a workflow's trigger: the thing that starts a run when nobody does.
 *
 * `relay workflow serve` is the always-on half of a workflow, on a machine of
 * the person's own. It listens for what the trigger node names — an incoming
 * webhook, a schedule, a label on a GitHub issue — and hands each event to the
 * same walk a person starts by hand, where the guardrails on the canvas decide
 * what happens next. This file only turns the world into events and events
 * into a queue; it decides nothing about whether a run may start.
 *
 * One event at a time. A second webhook while a run is going waits its turn,
 * which is the Concurrency limit most workflows ask for, and the queue is
 * bounded so a flood is refused at the door rather than remembered.
 */

export type ServeLog =
  | { type: 'listening'; trigger: string; detail: string }
  | { type: 'event'; id: string; source: WorkflowEvent['source']; title: string }
  | { type: 'ignored'; reason: string }
  | { type: 'finished'; id: string; status: GraphOutcome['status']; exitCode: number; summary: string }
  | { type: 'error'; detail: string }
  | { type: 'stopping'; reason: string; waiting: number };

export interface ServeWorkflowOptions {
  graph: WorkflowGraph;
  /** Runs one event through the workflow, to the end. */
  run: (event: WorkflowEvent, signal: AbortSignal) => Promise<GraphOutcome>;
  log: (entry: ServeLog) => void;
  /** Aborted to stop taking events. The run in flight finishes. */
  signal: AbortSignal;
  /** Aborted to stop the run in flight as well. */
  runSignal: AbortSignal;
  env: Readonly<Record<string, string | undefined>>;
  /** The tracker, for a workflow that starts from a label. */
  provider?: IssueProvider;
  host?: string;
  port?: number;
  /** Seconds between looks at the tracker, for a label trigger. */
  pollSeconds?: number;
  /** Stop after this many events have been run. `--once` passes 1. */
  maxEvents?: number;
  now?: () => Date;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Told the address the webhook listener bound, once it has. A seam for the tests, which ask for port 0. */
  onListening?: (address: { host: string; port: number; path: string }) => void;
}

export interface ServeWorkflowOutcome {
  events: number;
  results: Array<{ id: string; status: GraphOutcome['status']; exitCode: number }>;
  stoppedBy: 'signal' | 'limit' | 'error';
  reason: string;
}

export const WEBHOOK_SECRET_VARIABLE = 'RELAY_WEBHOOK_SECRET';
export const DEFAULT_WEBHOOK_PORT = 4480;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_QUEUED = 50;
/** Deliveries remembered, so one sent twice starts one run. */
const REMEMBERED = 1_000;

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    // Node's timers hold at most about 24 days.
    const timer = setTimeout(done, Math.min(ms, 2_000_000_000));
    signal.addEventListener('abort', done, { once: true });
  });
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** The path a workflow's webhook is delivered to: `/hooks/<path suffix>`, or `/hooks/<app>` for an app's own trigger. */
export function webhookPath(trigger: GraphNode): string {
  const suffix = String(trigger.config['path'] ?? '').trim().replace(/^\/+|\/+$/g, '');
  const fallback = trigger.type === 'http.trigger.webhook' ? 'relay' : (trigger.type.split('.')[0] ?? 'relay');
  return `/hooks/${suffix.length === 0 ? fallback : suffix.replace(/[^A-Za-z0-9._~-]+/g, '-')}`;
}

export async function serveWorkflow(options: ServeWorkflowOptions): Promise<ServeWorkflowOutcome> {
  const { graph, log } = options;
  // What the trigger's sources watch: aborted when the caller says stop, and
  // when this function is done for any other reason (`--once`, an error), so
  // a clock or a poll never outlives the loop it was feeding.
  const stopping = new AbortController();
  const signal = stopping.signal;
  if (options.signal.aborted) stopping.abort();
  else options.signal.addEventListener('abort', () => stopping.abort(), { once: true });
  const now = options.now ?? ((): Date => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const trigger = triggerOf(graph);

  const queue: WorkflowEvent[] = [];
  const seen = new Set<string>();
  const results: ServeWorkflowOutcome['results'] = [];
  let wake: (() => void) | undefined;
  let fatal: string | undefined;

  /** Queues an event, unless it is one already seen or the queue is full. Says which. */
  const offer = (event: WorkflowEvent): 'queued' | 'duplicate' | 'full' | 'closed' => {
    if (signal.aborted) return 'closed';
    if (seen.has(event.id)) return 'duplicate';
    if (queue.length >= MAX_QUEUED) return 'full';
    seen.add(event.id);
    if (seen.size > REMEMBERED) seen.delete(seen.values().next().value as string);
    queue.push(event);
    wake?.();
    return 'queued';
  };

  const sources: Array<Promise<void>> = [];
  let server: Server | undefined;

  // An app's own trigger is its webhook, read by name: the same listener, a stricter reading.
  const kind = APP_WEBHOOK_TRIGGERS.has(trigger.type) ? 'http.trigger.webhook' : trigger.type;
  switch (kind) {
    case 'http.trigger.webhook': {
      const host = options.host ?? '127.0.0.1';
      const secret = options.env[WEBHOOK_SECRET_VARIABLE]?.trim() ?? '';
      const fromApp = trigger.type !== 'http.trigger.webhook';
      // An app reaches this through a tunnel or a public address, whatever it is bound to here, and it signs what it sends.
      if (secret.length === 0 && fromApp) {
        throw new Error(`${trigger.name} is delivered by the app, signed. Set ${WEBHOOK_SECRET_VARIABLE} to the secret you gave its webhook: an unsigned delivery could be anyone’s.`);
      }
      if (secret.length === 0 && !isLoopbackHost(host)) {
        throw new Error(`Listening on ${host} lets anyone who can reach it start a run. Set ${WEBHOOK_SECRET_VARIABLE} so deliveries have to be signed, or listen on 127.0.0.1.`);
      }
      const path = webhookPath(trigger);
      const memory = new Map<string, string>();
      server = createServer((request, response) => {
        void handleWebhook(request, response, { trigger, path, secret, offer, log, now, memory, linear: (options.env['LINEAR_API_KEY'] ?? '').trim().length > 0 });
      });
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(options.port ?? DEFAULT_WEBHOOK_PORT, host, () => resolve());
      });
      const bound = server.address() as AddressInfo;
      options.onListening?.({ host, port: bound.port, path });
      log({
        type: 'listening',
        trigger: trigger.name,
        detail: `POST http://${host.includes(':') ? `[${host}]` : host}:${bound.port}${path}${secret.length === 0 ? ' (unsigned: this machine only)' : ` (signed with ${WEBHOOK_SECRET_VARIABLE})`}`,
      });
      break;
    }
    case 'schedule.trigger.cron': {
      const expression = String(trigger.config['cron'] ?? '');
      const zone = String(trigger.config['timezone'] ?? 'UTC').trim() || 'UTC';
      const parsed = parseCron(expression);
      if (!parsed.ok) throw new Error(parsed.error);
      if (!isTimeZone(zone)) throw new Error(`“${zone}” is not a time zone. Use a name like Europe/London.`);
      const first = nextCronTime(parsed.schedule, now(), zone);
      if (first === null) throw new Error(`The cron expression “${expression}” never comes round.`);
      log({ type: 'listening', trigger: trigger.name, detail: `${expression} (${zone}); next at ${first.toISOString()}` });
      sources.push(
        (async () => {
          let next: Date | null = first;
          while (!signal.aborted && next !== null) {
            await sleep(Math.max(0, next.getTime() - now().getTime()), signal);
            if (signal.aborted) return;
            // Woken early is not the hour: a long wait is slept in pieces.
            if (now().getTime() < next.getTime()) continue;
            offer(scheduleEvent(next, ''));
            next = nextCronTime(parsed.schedule, next, zone);
          }
        })(),
      );
      break;
    }
    case 'schedule.trigger.interval': {
      const minutes = Math.min(1440, Math.max(1, Number(trigger.config['minutes'] ?? 15) || 15));
      log({ type: 'listening', trigger: trigger.name, detail: `every ${minutes} minute${minutes === 1 ? '' : 's'}` });
      sources.push(
        (async () => {
          while (!signal.aborted) {
            await sleep(minutes * 60_000, signal);
            if (signal.aborted) return;
            offer(scheduleEvent(now(), ''));
          }
        })(),
      );
      break;
    }
    case 'github-issues.trigger.issue-labelled': {
      const provider = options.provider;
      const label = String(trigger.config['label'] ?? '').trim() || String((graph.config['workflow'] as Record<string, unknown> | undefined)?.['triggerLabel'] ?? 'relay:go');
      if (provider === undefined) throw new Error('This workflow starts from a label, and there is no tracker to watch here.');
      const seconds = Math.min(3600, Math.max(5, options.pollSeconds ?? 60));
      log({ type: 'listening', trigger: trigger.name, detail: `issues labelled ${label}, checked every ${seconds}s` });
      sources.push(
        (async () => {
          while (!signal.aborted) {
            try {
              for (const summary of (await provider.listIssues({ labels: [label], limit: 50 }, { signal })) ?? []) {
                const ref = summary.ref ?? String(summary.number);
                // Considered once per server, so a refusal is said once and the label stays where its author can see it.
                if (seen.has(`issue-label:${ref}`)) continue;
                const issue = await provider.getIssue(ref, { signal });
                const actor = (await provider.labelActor?.(ref, label, { signal })) ?? null;
                const event = issueEvent(issue, ref, { attended: false, actor, now: now() });
                offer({ ...event, id: `issue-label:${ref}`, payload: { ...event.payload, triggerLabel: label } });
              }
            } catch (error) {
              if (!signal.aborted) log({ type: 'error', detail: `Could not read the tracker: ${errorMessage(error)}` });
            }
            await sleep(seconds * 1000, signal);
          }
        })(),
      );
      break;
    }
    default:
      throw new Error(
        trigger.type === 'logic.trigger.manual'
          ? 'This workflow starts by hand, so there is nothing to listen for. Run it with `relay workflow run`.'
          : `Nothing listens for “${trigger.name}” yet. Point the app’s webhook at an Incoming webhook trigger, or run the workflow by hand with \`relay workflow run\`.`,
      );
  }

  // The loop: one event at a time, until told to stop or the limit is reached.
  let stoppedBy: ServeWorkflowOutcome['stoppedBy'] = 'signal';
  let reason = 'asked to stop';
  try {
    for (;;) {
      if (queue.length === 0) {
        if (signal.aborted) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        wake = undefined;
        continue;
      }
      const event = queue.shift()!;
      log({ type: 'event', id: event.id, source: event.source, title: String(event.payload['title'] ?? event.payload['id'] ?? '') });
      try {
        const outcome = await options.run(event, options.runSignal);
        results.push({ id: event.id, status: outcome.status, exitCode: outcome.exitCode });
        log({ type: 'finished', id: event.id, status: outcome.status, exitCode: outcome.exitCode, summary: outcome.summary });
      } catch (error) {
        results.push({ id: event.id, status: 'failed', exitCode: 1 });
        log({ type: 'error', detail: `${event.id}: ${errorMessage(error)}` });
      }
      if (options.maxEvents !== undefined && results.length >= options.maxEvents) {
        stoppedBy = 'limit';
        reason = `ran ${results.length} event${results.length === 1 ? '' : 's'}`;
        break;
      }
      if (options.runSignal.aborted) break;
    }
  } catch (error) {
    fatal = errorMessage(error);
  } finally {
    stopping.abort();
    if (server !== undefined) {
      server.close();
      server.closeAllConnections();
    }
  }
  if (fatal !== undefined) return { events: results.length, results, stoppedBy: 'error', reason: fatal };
  if (queue.length > 0) log({ type: 'stopping', reason, waiting: queue.length });
  return { events: results.length, results, stoppedBy, reason };
}

/* ------------------------------------------------------------------ */

interface WebhookContext {
  trigger: GraphNode;
  /** What the server remembers between deliveries, for a trigger that asks about the one before. */
  memory: Map<string, string>;
  path: string;
  secret: string;
  offer: (event: WorkflowEvent) => 'queued' | 'duplicate' | 'full' | 'closed';
  log: (entry: ServeLog) => void;
  now: () => Date;
  linear: boolean;
}

function answer(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(text);
}

async function readBody(request: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function handleWebhook(request: IncomingMessage, response: ServerResponse, context: WebhookContext): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/healthz') return answer(response, 200, { ok: true });
    if (url.pathname !== context.path) return answer(response, 404, { error: 'Nothing listens at this path.' });
    if (request.method !== 'POST') return answer(response, 405, { error: 'Send the event as a POST.' });

    const raw = await readBody(request);
    if (raw === null) return answer(response, 413, { error: 'The body is larger than 1 MB.' });
    // Checked against the bytes as they arrived, before anything reads them as JSON.
    if (context.secret.length > 0 && !signatureValid(context.secret, raw, request.headers)) {
      context.log({ type: 'ignored', reason: 'a delivery whose signature did not match' });
      return answer(response, 401, { error: 'The signature does not match. Sign the body with HMAC-SHA256 and send it as X-Relay-Signature: sha256=<hex>.' });
    }

    let body: unknown;
    try {
      body = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'));
    } catch {
      return answer(response, 400, { error: 'The body is not JSON.' });
    }
    // Read as the trigger the workflow names. An app sends every kind of event to one URL; most are not this one.
    const read = matchDelivery(context.trigger, body, { headers: request.headers, now: context.now(), linear: context.linear, memory: context.memory });
    if (!read.match) {
      context.log({ type: 'ignored', reason: read.why });
      // A 200, so the app does not send it again: it arrived, and it is not what starts this workflow.
      return answer(response, 200, { accepted: false, reason: read.why });
    }
    const event = read.event;
    switch (context.offer(event)) {
      case 'queued':
        return answer(response, 202, { accepted: true, id: event.id });
      case 'duplicate':
        return answer(response, 200, { accepted: false, id: event.id, reason: 'This delivery was already received.' });
      case 'full':
        context.log({ type: 'ignored', reason: 'a delivery that arrived while the queue was full' });
        return answer(response, 429, { error: 'Too many events are waiting. Send it again later.' });
      case 'closed':
        return answer(response, 503, { error: 'This workflow is shutting down.' });
    }
  } catch (error) {
    context.log({ type: 'error', detail: `webhook: ${errorMessage(error)}` });
    if (!response.headersSent) answer(response, 500, { error: 'The event could not be read.' });
  }
}
