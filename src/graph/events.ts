import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { Issue } from '../github/types.ts';
import { oneLine } from '../util/text.ts';
import { isIssueReference, type GraphTask, type WorkflowEvent } from './types.ts';

/**
 * What starts a workflow, turned into the one shape the walk reads.
 *
 * A person naming an issue, a tracker handing one over, and a stranger's
 * webhook body all become a `WorkflowEvent`: a ticket-shaped payload for the
 * templates, a task for the agents, and who the event says is behind it.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

/** A login out of whatever shape an app uses for "who": a string, or an object with a login or a name. */
function who(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim().replace(/^@/, '');
  if (isRecord(value)) {
    for (const key of ['login', 'username', 'name', 'displayName', 'email']) {
      const found = value[key];
      if (typeof found === 'string' && found.trim().length > 0) return found.trim().replace(/^@/, '');
    }
  }
  return null;
}

/** A person starting the workflow by hand, with an issue or a description. */
export function manualEvent(task: GraphTask, now: Date): WorkflowEvent {
  const payload: Record<string, unknown> =
    task.kind === 'issue'
      ? { id: /^\d+$/.test(task.ref) ? `#${task.ref}` : task.ref, ...(/^\d+$/.test(task.ref) ? { number: Number(task.ref) } : {}) }
      : { id: 'manual', title: oneLine(task.text.split('\n')[0] ?? '', 120), body: task.text };
  return { id: `manual-${now.getTime().toString(36)}`, source: 'manual', attended: true, actor: null, payload, task, at: now.toISOString() };
}

/** The payload a tracker issue gives the templates: `{{issue.key}}`, `{{issue.title}}`, `{{issue.url}}`… */
export function issuePayload(issue: Issue): Record<string, unknown> {
  const key = issue.key ?? (issue.number !== null ? `#${issue.number}` : issue.id);
  return {
    id: key,
    key,
    ...(issue.number === null ? {} : { number: issue.number }),
    title: issue.title,
    body: issue.body,
    url: issue.url,
    author: issue.author ?? '',
    labels: issue.labels,
    state: issue.state,
  };
}

/** A tracker issue starting the workflow: by a person who named it, or by a label somebody put on it. */
export function issueEvent(issue: Issue, ref: string, options: { attended: boolean; actor: string | null; now: Date }): WorkflowEvent {
  return {
    id: `issue-${issue.id}`,
    source: options.attended ? 'manual' : 'issue',
    attended: options.attended,
    actor: options.actor,
    payload: issuePayload(issue),
    task: { kind: 'issue', ref },
    at: options.now.toISOString(),
  };
}

export function scheduleEvent(now: Date, prompt: string): WorkflowEvent {
  const firedAt = now.toISOString();
  const trimmed = prompt.trim();
  return {
    id: `schedule-${firedAt.slice(0, 16)}`,
    source: 'schedule',
    attended: false,
    // The clock has no login. A workflow on a schedule is its owner's doing, and its allowlist has to say so with `*`.
    actor: null,
    payload: { id: `schedule-${firedAt.slice(0, 10)}`, title: trimmed.length === 0 ? '' : oneLine(trimmed.split('\n')[0] ?? '', 120), body: trimmed, firedAt },
    task: trimmed.length === 0 ? null : { kind: 'prompt', text: trimmed },
    at: firedAt,
  };
}

export interface WebhookOptions {
  now: Date;
  /** Whether a Linear key is set, so a Linear ticket can be fetched as an issue rather than retyped as a description. */
  linear?: boolean;
  /**
   * Whether anything stands behind what the body says about who sent it: a
   * signature made with the workflow's secret, or the operator's own hand on
   * `--event`. An unsigned delivery names nobody, whatever it claims — any
   * process on the machine can post one.
   */
  vouched?: boolean;
}

/** The id of a delivery: what it said, hashed. Not a header, which the signature does not cover and a replay could change. */
export function deliveryIdOf(body: unknown): string {
  return `delivery-${createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex').slice(0, 16)}`;
}

/** A GitHub issue's own address, or nothing: the only `html_url` an event is taken at its word for. */
export function githubIssueUrl(value: unknown): string {
  const url = text(value);
  return /^https:\/\/github\.com\//.test(url) && isIssueReference(url) ? url : '';
}

/**
 * A webhook body, read as generously as is safe.
 *
 * The documented shape is flat — `title`, `body`, `url`, `actor`, and `issue`
 * for a tracker issue the agents should fetch themselves. Two apps' own
 * shapes are recognised as well, because their webhooks cannot be reshaped at
 * the source: a GitHub `issues` event, and a Linear issue event. Anything else
 * is kept whole under `{{trigger.*}}`, with whatever title it has.
 */
export function webhookEvent(body: unknown, options: WebhookOptions): WorkflowEvent {
  const raw = isRecord(body) ? body : { body: typeof body === 'string' ? body : JSON.stringify(body ?? null) };
  const payload: Record<string, unknown> = { ...raw };
  let actor = who(raw['actor']) ?? who(raw['author']) ?? who(raw['sender']) ?? who(raw['user']);
  let task: GraphTask | null = null;

  const github = raw['issue'];
  const linear = raw['data'];
  if (isRecord(github) && (typeof github['number'] === 'number' || typeof github['html_url'] === 'string')) {
    // GitHub's `issues` and `issue_comment` events. The address is the task the agents are given, so it has to be one.
    const url = githubIssueUrl(github['html_url']);
    const number = typeof github['number'] === 'number' && Number.isSafeInteger(github['number']) && github['number'] > 0 ? github['number'] : null;
    Object.assign(payload, {
      id: number === null ? url : `#${number}`,
      key: number === null ? url : `#${number}`,
      ...(number === null ? {} : { number }),
      title: text(github['title']),
      body: text(github['body']),
      url,
      author: who(github['user']) ?? '',
      labels: Array.isArray(github['labels']) ? github['labels'].map((label) => (isRecord(label) ? text(label['name']) : text(label))).filter(Boolean) : [],
    });
    actor = who(raw['sender']) ?? actor;
    const ref = url.length > 0 ? url : number === null ? '' : String(number);
    if (ref.length > 0) task = { kind: 'issue', ref };
  } else if (isRecord(linear) && typeof linear['identifier'] === 'string' && /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(linear['identifier']) && isIssueReference(linear['identifier'])) {
    // Linear's issue events.
    const identifier = linear['identifier'];
    Object.assign(payload, {
      id: identifier,
      key: identifier,
      title: text(linear['title']),
      body: text(linear['description']),
      url: text(linear['url']) || text(raw['url']),
      assignee: who(linear['assignee']) ?? '',
      labels: Array.isArray(linear['labels']) ? linear['labels'].map((label) => (isRecord(label) ? text(label['name']) : text(label))).filter(Boolean) : [],
    });
    if (options.linear === true) task = { kind: 'issue', ref: identifier };
  } else {
    const named = raw['issue'];
    const ref = typeof named === 'number' ? String(named) : typeof named === 'string' ? named.trim() : '';
    // Held to what a tracker's reference looks like. It becomes the argument of `relay run`, which reads anything else as a file.
    if (ref.length <= 300 && isIssueReference(ref)) {
      task = { kind: 'issue', ref };
      if (payload['id'] === undefined) payload['id'] = /^\d+$/.test(ref) ? `#${ref}` : ref;
      if (/^\d+$/.test(ref) && payload['number'] === undefined) payload['number'] = Number(ref);
    }
    if (payload['body'] === undefined) {
      const described = text(raw['description']) || text(raw['text']) || text(raw['message']);
      if (described.length > 0) payload['body'] = described;
    }
  }

  if (payload['key'] === undefined && payload['id'] !== undefined) payload['key'] = payload['id'];
  return { id: deliveryIdOf(body), source: 'webhook', attended: false, actor: options.vouched === false ? null : actor, payload, task, at: options.now.toISOString() };
}

/** The headers a signature may arrive in. Each carries an HMAC-SHA256 of the raw body, in hex, with or without a `sha256=` prefix. */
const SIGNATURE_HEADERS = ['x-relay-signature', 'x-hub-signature-256', 'linear-signature', 'sentry-hook-signature'];

/**
 * Whether a delivery was signed with the workflow's secret.
 *
 * One scheme, because the apps worth receiving from agree on it: HMAC-SHA256
 * of the body exactly as it was sent. GitHub, Linear and Sentry each put it in
 * a header of their own; `X-Relay-Signature` is the one to use from anything
 * else.
 */
export function signatureValid(secret: string, rawBody: Buffer | string, headers: Readonly<Record<string, string | string[] | undefined>>): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  for (const name of SIGNATURE_HEADERS) {
    const value = headers[name];
    const given = (Array.isArray(value) ? value[0] : value)?.trim().replace(/^sha256=/i, '');
    if (given === undefined || !/^[0-9a-f]{64}$/i.test(given)) continue;
    if (timingSafeEqual(Buffer.from(given, 'hex'), expected)) return true;
  }
  return false;
}

/** The signature a sender puts in `X-Relay-Signature`, for the docs and the tests to agree on. */
export function signBody(secret: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}
