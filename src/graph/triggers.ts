import { clip, oneLine } from '../util/text.ts';
import { deliveryIdOf, githubIssueUrl, webhookEvent } from './events.ts';
import { isIssueReference, plainText, type GraphNode, type GraphTask, type WorkflowEvent } from './types.ts';

/**
 * An app's own webhook, read as the trigger a workflow names.
 *
 * GitHub, Linear and Sentry each post what happened to a URL you give them,
 * signed with a secret you share. `relay workflow serve` is that URL. For a
 * workflow that starts when "a Linear issue is assigned to the bot", every
 * delivery Linear sends arrives here, and this file decides whether it is
 * that: the right kind of event, the right action, and the filters the
 * trigger node was given (which assignee, which label, which branch).
 *
 * It fails closed. A delivery that is not recognisably the trigger starts
 * nothing and says why; a field this file does not find is a reason to
 * ignore the delivery, never a reason to guess. The shapes are the ones the
 * apps document, and they are read by name: when an app changes one, the
 * trigger stops firing, which is the safe way to be wrong.
 */

export type DeliveryMatch = { match: true; event: WorkflowEvent } | { match: false; why: string };

export interface DeliveryContext {
  headers: Readonly<Record<string, string | string[] | undefined>>;
  now: Date;
  /** Whether a Linear key is set, so a Linear ticket can be fetched as an issue rather than described. */
  linear: boolean;
  /** What this server remembers between deliveries: the last result of each CI workflow on each branch. */
  memory: Map<string, string>;
  /** Whether the delivery was signed with the workflow's secret. Unset means it was. */
  signed?: boolean;
}

type Body = Record<string, unknown>;

function isRecord(value: unknown): value is Body {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown): Body {
  return isRecord(value) ? value : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function header(context: DeliveryContext, name: string): string {
  const value = context.headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

function names(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => (isRecord(entry) ? text(entry['name']) : text(entry))).filter((entry) => entry.length > 0) : [];
}

/** What a trigger's text field was set to, without the `@` people type in front of a login. */
function setting(trigger: GraphNode, key: string): string {
  return text(trigger.config[key]).trim().replace(/^@/, '');
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

// The reason is printed in a terminal, and parts of it are the sender's words.
const no = (why: string): DeliveryMatch => ({ match: false, why: oneLine(plainText(why), 240) });

function event(context: DeliveryContext, id: string, actor: string | null, payload: Body, task: GraphTask | null): DeliveryMatch {
  if (payload['key'] === undefined && payload['id'] !== undefined) payload['key'] = payload['id'];
  return { match: true, event: { id, source: 'webhook', attended: false, actor, payload, task, at: context.now.toISOString() } };
}

/** Which triggers this file reads, so the listener knows to start for them. */
export const APP_WEBHOOK_TRIGGERS: ReadonlySet<string> = new Set([
  'github-issues.trigger.issue-opened',
  'github-issues.trigger.issue-assigned',
  'github-issues.trigger.issue-comment',
  'github-actions.trigger.workflow-failed',
  'codeql.trigger.alert-created',
  'dependabot.trigger.alert-created',
  'linear.trigger.issue-assigned',
  'linear.trigger.issue-created',
  'linear.trigger.issue-labelled',
  'linear.trigger.issue-state-changed',
  'sentry.trigger.issue-created',
  'sentry.trigger.issue-regressed',
  'sentry.trigger.issue-assigned',
]);

/**
 * Reads one delivery as the workflow's trigger. The generic Incoming webhook
 * takes anything; an app's trigger takes that app's event and nothing else.
 */
export function matchDelivery(trigger: GraphNode, body: unknown, context: DeliveryContext): DeliveryMatch {
  if (trigger.type === 'http.trigger.webhook') {
    return { match: true, event: webhookEvent(body, { now: context.now, linear: context.linear, vouched: context.signed !== false }) };
  }
  if (!isRecord(body)) return no('a delivery whose body is not a JSON object');
  const app = trigger.type.split('.')[0];
  if (app === 'github-issues' || app === 'github-actions' || app === 'codeql' || app === 'dependabot') return github(trigger, body, context);
  if (app === 'linear') return linear(trigger, body, context);
  if (app === 'sentry') return sentry(trigger, body, context);
  return no(`a delivery for a trigger this Relay does not read (${trigger.type})`);
}

/* ------------------------------------------------------------------ */
/* GitHub                                                              */
/* ------------------------------------------------------------------ */

const SEVERITY: Readonly<Record<string, number>> = { low: 1, medium: 2, moderate: 2, high: 3, critical: 4 };

function issuePayload(issue: Body): { payload: Body; task: GraphTask | null } {
  const number = typeof issue['number'] === 'number' && Number.isSafeInteger(issue['number']) && issue['number'] > 0 ? issue['number'] : null;
  // The address is what the agents are sent to fetch, so it is taken only when it is a GitHub issue's.
  const url = githubIssueUrl(issue['html_url']);
  const payload: Body = {
    id: number === null ? url : `#${number}`,
    ...(number === null ? {} : { number }),
    title: text(issue['title']),
    body: text(issue['body']),
    url,
    author: text(record(issue['user'])['login']),
    labels: names(issue['labels']),
  };
  const ref = url.length > 0 ? url : number === null ? '' : String(number);
  return { payload, task: ref.length === 0 ? null : { kind: 'issue', ref } };
}

function github(trigger: GraphNode, body: Body, context: DeliveryContext): DeliveryMatch {
  const kind = header(context, 'x-github-event');
  const action = text(body['action']);
  const sender = text(record(body['sender'])['login']) || null;
  const id = deliveryIdOf(body);
  if (kind === 'ping') return no('GitHub’s ping, which says the webhook is set up');

  switch (trigger.type) {
    case 'github-issues.trigger.issue-opened': {
      if (kind !== 'issues' || action !== 'opened') return no(`a GitHub ${kind || 'event'} ${action}, not an issue being opened`);
      const { payload, task } = issuePayload(record(body['issue']));
      const label = setting(trigger, 'label');
      if (label.length > 0 && !(payload['labels'] as string[]).some((name) => same(name, label))) return no(`an issue opened without the label ${label}`);
      return event(context, id, sender, payload, task);
    }
    case 'github-issues.trigger.issue-assigned': {
      if (kind !== 'issues' || action !== 'assigned') return no(`a GitHub ${kind || 'event'} ${action}, not an issue being assigned`);
      const assignee = text(record(body['assignee'])['login']);
      const wanted = setting(trigger, 'assignee');
      if (wanted.length > 0 && !same(assignee, wanted)) return no(`an issue assigned to ${assignee || 'someone else'}, not ${wanted}`);
      const { payload, task } = issuePayload(record(body['issue']));
      return event(context, id, sender, { ...payload, assignee }, task);
    }
    case 'github-issues.trigger.issue-comment': {
      if (kind !== 'issue_comment' || action !== 'created') return no(`a GitHub ${kind || 'event'} ${action}, not a new comment`);
      const issue = record(body['issue']);
      if (issue['pull_request'] !== undefined) return no('a comment on a pull request, not on an issue');
      const comment = text(record(body['comment'])['body']);
      const mention = text(trigger.config['mention']).trim();
      if (mention.length > 0 && !comment.toLowerCase().includes(mention.toLowerCase())) return no(`a comment that does not mention ${mention}`);
      const { payload, task } = issuePayload(issue);
      return event(context, id, sender, { ...payload, comment }, task);
    }
    case 'github-actions.trigger.workflow-failed': {
      if (kind !== 'workflow_run' || action !== 'completed') return no(`a GitHub ${kind || 'event'} ${action}, not a workflow finishing`);
      const run = record(body['workflow_run']);
      const name = text(run['name']) || text(record(body['workflow'])['name']);
      const path = text(run['path']) || text(record(body['workflow'])['path']);
      const branch = text(run['head_branch']);
      const conclusion = text(run['conclusion']);
      const wanted = text(trigger.config['workflow']).trim();
      if (wanted.length > 0 && !same(wanted, name) && !same(wanted, path) && !same(wanted, path.split('/').pop() ?? '')) return no(`a run of ${name || path}, not of ${wanted}`);
      const onBranch = text(trigger.config['branch']).trim();
      if (onBranch.length > 0 && !same(onBranch, branch)) return no(`a run on ${branch}, not on ${onBranch}`);
      // Remembered whatever the result, so "the first failure" can be told from the tenth in a row.
      const remembered = `${name}@${branch}`;
      const before = context.memory.get(remembered);
      context.memory.set(remembered, conclusion);
      if (conclusion !== 'failure') return no(`a run of ${name} that ended ${conclusion || 'without a result'}`);
      if (trigger.config['firstFailureOnly'] !== false && before === 'failure') return no(`${name} on ${branch} failing again: only its first failure starts a run`);
      const url = text(run['html_url']);
      const runId = text(run['id']);
      const sha = text(run['head_sha']).slice(0, 7);
      const title = `CI failing on ${branch || 'a branch'}: ${name || 'a workflow'}`;
      const detail = [
        `The workflow “${name}” failed on ${branch}${sha.length > 0 ? ` at ${sha}` : ''}.`,
        url.length > 0 ? `Run: ${url}` : '',
        runId.length > 0 ? `Read what failed with: gh run view ${runId} --log-failed` : '',
        text(record(run['head_commit'])['message']).length > 0 ? `Last commit: ${oneLine(text(record(run['head_commit'])['message']), 160)}` : '',
      ].filter((line) => line.length > 0).join('\n');
      return event(context, id, sender, { id: `${name}#${text(run['run_number']) || runId}`, title, body: detail, url, branch, workflow: name, labels: ['ci'] }, { kind: 'prompt', text: `${title}\n\n${detail}` });
    }
    case 'codeql.trigger.alert-created': {
      if (kind !== 'code_scanning_alert' || (action !== 'created' && action !== 'appeared_in_branch')) return no(`a GitHub ${kind || 'event'} ${action}, not a new code scanning alert`);
      const alert = record(body['alert']);
      const rule = record(alert['rule']);
      const severity = (text(rule['security_severity_level']) || text(rule['severity'])).toLowerCase();
      const least = text(trigger.config['severity']).toLowerCase() || 'high';
      if ((SEVERITY[severity] ?? 0) < (SEVERITY[least] ?? 3)) return no(`a ${severity || 'unrated'} alert, below ${least}`);
      const location = record(record(alert['most_recent_instance'])['location']);
      const where = text(location['path']).length > 0 ? `${text(location['path'])}:${text(location['start_line'])}` : '';
      const title = `Code scanning: ${text(rule['description']) || text(rule['name']) || text(rule['id']) || 'a new alert'}`;
      const detail = [
        `Severity: ${severity}.`,
        where.length > 0 ? `Where: ${where}` : '',
        text(record(record(alert['most_recent_instance'])['message'])['text']),
        text(rule['help']).length > 0 ? clip(text(rule['help']), 1500) : '',
        text(alert['html_url']),
      ].filter((line) => line.length > 0).join('\n\n');
      return event(context, id, sender, { id: `alert-${text(alert['number'])}`, title, body: detail, url: text(alert['html_url']), severity, labels: ['security'] }, { kind: 'prompt', text: `${title}\n\n${detail}` });
    }
    case 'dependabot.trigger.alert-created': {
      if (kind !== 'dependabot_alert' || action !== 'created') return no(`a GitHub ${kind || 'event'} ${action}, not a new Dependabot alert`);
      const alert = record(body['alert']);
      const advisory = record(alert['security_advisory']);
      const vulnerability = record(alert['security_vulnerability']);
      const severity = (text(advisory['severity']) || text(vulnerability['severity'])).toLowerCase();
      const least = text(trigger.config['severity']).toLowerCase() || 'high';
      if ((SEVERITY[severity] ?? 0) < (SEVERITY[least] ?? 3)) return no(`a ${severity || 'unrated'} alert, below ${least}`);
      const pkg = text(record(record(alert['dependency'])['package'])['name']) || text(record(vulnerability['package'])['name']);
      const patched = text(record(vulnerability['first_patched_version'])['identifier']);
      const title = `Vulnerable dependency: ${pkg || 'a package'} (${severity})`;
      const detail = [text(advisory['summary']), patched.length > 0 ? `First patched version: ${patched}.` : 'No patched version is published yet.', clip(text(advisory['description']), 1500), text(alert['html_url'])].filter((line) => line.length > 0).join('\n\n');
      return event(context, id, sender, { id: `dependabot-${text(alert['number'])}`, title, body: detail, url: text(alert['html_url']), severity, labels: ['security', 'dependencies'] }, { kind: 'prompt', text: `${title}\n\n${detail}` });
    }
    default:
      return no(`a delivery for a trigger this Relay does not read (${trigger.type})`);
  }
}

/* ------------------------------------------------------------------ */
/* Linear                                                              */
/* ------------------------------------------------------------------ */

function person(value: unknown): string {
  const who = record(value);
  return text(who['name']) || text(who['displayName']) || text(who['email']);
}

/**
 * Who Linear says did it, for the allowlist. Their email when the delivery
 * carries one: a name in Linear is whatever its owner typed, and an allowlist
 * that went by it would take anybody's word for who they are.
 */
function linearActor(value: unknown): string | null {
  const who = record(value);
  return text(who['email']).trim() || text(who['name']).trim() || null;
}

/** Whether a person Linear names is the one a trigger was set to: by name, display name, or the part of an email before the @. */
function isPerson(value: unknown, wanted: string): boolean {
  const who = record(value);
  return [text(who['name']), text(who['displayName']), text(who['email']), text(who['email']).split('@')[0] ?? ''].some((candidate) => candidate.length > 0 && same(candidate, wanted));
}

function linear(trigger: GraphNode, body: Body, context: DeliveryContext): DeliveryMatch {
  const type = text(body['type']);
  const action = text(body['action']);
  if (type !== 'Issue') return no(`a Linear ${type || 'event'}, not an issue`);
  const data = record(body['data']);
  const changed = record(body['updatedFrom']);
  const identifier = text(data['identifier']);
  if (!/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(identifier) || !isIssueReference(identifier)) return no('a Linear issue with no identifier');
  const team = text(record(data['team'])['key']);
  const labels = names(data['labels']);
  const state = text(record(data['state'])['name']);

  switch (trigger.type) {
    case 'linear.trigger.issue-assigned': {
      // Taking somebody off an issue changes the assignee too, to nobody.
      const assigned = isRecord(data['assignee']) || text(data['assigneeId']).length > 0;
      const newly = assigned && (action === 'create' || (action === 'update' && 'assigneeId' in changed));
      if (!newly) return no(`a Linear issue ${action}, without a new assignee`);
      const wanted = setting(trigger, 'assignee');
      if (wanted.length > 0 && !isPerson(data['assignee'], wanted)) return no(`${identifier} assigned to ${person(data['assignee']) || 'nobody'}, not ${wanted}`);
      break;
    }
    case 'linear.trigger.issue-created':
      if (action !== 'create') return no(`a Linear issue ${action}, not a new one`);
      break;
    case 'linear.trigger.issue-labelled': {
      const wanted = setting(trigger, 'label');
      if (wanted.length === 0) return no('a label trigger that names no label');
      const found = (Array.isArray(data['labels']) ? data['labels'] : []).find((label) => same(text(record(label)['name']), wanted));
      if (found === undefined) return no(`${identifier} without the label ${wanted}`);
      if (action === 'create') break;
      if (action !== 'update' || !('labelIds' in changed)) return no(`a Linear issue ${action}, without its labels changing`);
      // Any change to the labels arrives here, a removal included. It is this trigger only when the label was not there before.
      const before = Array.isArray(changed['labelIds']) ? changed['labelIds'].map(text) : null;
      const labelId = text(record(found)['id']);
      if (before === null || labelId.length === 0) return no(`${identifier}: a label change that does not say which labels it had`);
      if (before.includes(labelId)) return no(`${identifier} already had the label ${wanted}`);
      break;
    }
    case 'linear.trigger.issue-state-changed': {
      const wanted = setting(trigger, 'state');
      if (action !== 'update' || !('stateId' in changed)) return no(`a Linear issue ${action}, without its state changing`);
      if (wanted.length > 0 && !same(state, wanted)) return no(`${identifier} moved to ${state || 'another state'}, not ${wanted}`);
      break;
    }
    default:
      return no(`a delivery for a trigger this Relay does not read (${trigger.type})`);
  }
  const onTeam = setting(trigger, 'team');
  if (onTeam.length > 0 && !same(team, onTeam)) return no(`${identifier} in team ${team || 'unknown'}, not ${onTeam}`);

  const payload: Body = {
    id: identifier,
    title: text(data['title']),
    body: text(data['description']),
    url: text(body['url']) || text(data['url']),
    assignee: person(data['assignee']),
    labels,
    state,
    team,
    priority: text(data['priorityLabel']) || text(data['priority']),
  };
  // With a key the engine fetches the ticket itself, comments and all; without one it works from what the delivery said.
  const task: GraphTask = context.linear ? { kind: 'issue', ref: identifier } : { kind: 'prompt', text: [`${identifier}: ${text(data['title'])}`, text(data['description'])].filter((part) => part.trim().length > 0).join('\n\n') };
  return event(context, deliveryIdOf(body), linearActor(body['actor']), payload, task);
}

/* ------------------------------------------------------------------ */
/* Sentry                                                              */
/* ------------------------------------------------------------------ */

function sentry(trigger: GraphNode, body: Body, context: DeliveryContext): DeliveryMatch {
  const resource = header(context, 'sentry-hook-resource');
  const action = text(body['action']);
  const data = record(body['data']);
  // An alert rule's delivery carries the event; an issue's own carries the issue.
  const alert = resource === 'event_alert' && action === 'triggered';
  const issue = alert ? record(data['event']) : record(data['issue']);
  if (resource !== 'issue' && !alert) return no(`a Sentry ${resource || 'event'} ${action}, not an issue`);

  const project = text(record(issue['project'])['slug']) || text(record(issue['project'])['name']) || text(issue['project']);
  const wantedProject = setting(trigger, 'project');
  if (wantedProject.length > 0 && !same(project, wantedProject)) return no(project.length === 0 ? `a Sentry issue that names no project, where ${wantedProject} is wanted` : `a Sentry issue in ${project}, not ${wantedProject}`);

  switch (trigger.type) {
    case 'sentry.trigger.issue-created': {
      // An alert rule has already done the counting ("seen by more than N users"), in Sentry, where the numbers are.
      if (alert) break;
      if (action !== 'created') return no(`a Sentry issue ${action}, not a new one`);
      const least = Number(trigger.config['minUsers'] ?? 0);
      const users = Number(issue['userCount'] ?? NaN);
      if (Number.isFinite(least) && least > 1 && Number.isFinite(users) && users < least) return no(`a new Sentry issue affecting ${users} user${users === 1 ? '' : 's'}, fewer than ${least}`);
      break;
    }
    case 'sentry.trigger.issue-regressed':
      // Both, not either: a person reopening an issue is `unresolved` too, and an issue that regressed last week still says so when it is assigned.
      if (alert || action !== 'unresolved' || text(issue['substatus']) !== 'regressed') return no(`a Sentry issue ${action}, not one coming back`);
      break;
    case 'sentry.trigger.issue-assigned': {
      if (alert || action !== 'assigned') return no(`a Sentry issue ${action}, not one being assigned`);
      const wanted = setting(trigger, 'assignee');
      const assignee = record(issue['assignedTo']);
      if (wanted.length > 0 && !isPerson(assignee, wanted)) return no(`a Sentry issue assigned to ${person(assignee) || 'someone else'}, not ${wanted}`);
      break;
    }
    default:
      return no(`a delivery for a trigger this Relay does not read (${trigger.type})`);
  }

  const metadata = record(issue['metadata']);
  const title = text(issue['title']) || [text(metadata['type']), text(metadata['value'])].filter(Boolean).join(': ') || 'A Sentry issue';
  const url = text(issue['web_url']) || text(issue['permalink']) || text(issue['issue_url']) || text(issue['url']);
  const shortId = text(issue['shortId']) || text(issue['issue_id']) || text(issue['id']);
  const detail = [
    text(issue['culprit']).length > 0 ? `In ${text(issue['culprit'])}.` : '',
    text(metadata['value']),
    text(metadata['filename']).length > 0 ? `File: ${text(metadata['filename'])}${text(metadata['function']).length > 0 ? `, in ${text(metadata['function'])}` : ''}` : '',
    url,
  ].filter((line) => line.length > 0).join('\n\n');
  const actor = person(body['actor']) || null;
  return event(context, deliveryIdOf(body), actor, { id: shortId, title, body: detail, url, project, level: text(issue['level']), labels: ['error'] }, { kind: 'prompt', text: `${title}\n\n${detail}` });
}
