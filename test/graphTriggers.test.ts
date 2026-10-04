import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { signBody } from '../src/graph/events.ts';
import type { GraphOutcome } from '../src/graph/executor.ts';
import { serveWorkflow, webhookPath, type ServeLog } from '../src/graph/serve.ts';
import { nodeSupport } from '../src/graph/support.ts';
import { APP_WEBHOOK_TRIGGERS, matchDelivery, type DeliveryContext, type DeliveryMatch } from '../src/graph/triggers.ts';
import { parseGraph, type GraphNode, type WorkflowEvent } from '../src/graph/types.ts';

/**
 * Each app's webhook, as the app documents it, read as the trigger a workflow
 * names. The bodies here are cut down to the fields the reading uses, plus a
 * few it must ignore.
 */

const NOW = new Date('2026-10-05T10:00:00.000Z');

function trigger(type: string, config: Record<string, unknown> = {}): GraphNode {
  return { id: 't', type, kind: 'trigger', name: type, config, outputs: ['issue'] };
}

function read(node: GraphNode, body: unknown, headers: Record<string, string> = {}, options: Partial<DeliveryContext> = {}): DeliveryMatch {
  return matchDelivery(node, body, { headers, now: NOW, linear: false, memory: new Map(), ...options });
}

function matched(result: DeliveryMatch): WorkflowEvent {
  assert.equal(result.match, true, result.match ? '' : result.why);
  return (result as { event: WorkflowEvent }).event;
}

const why = (result: DeliveryMatch): string => (result.match ? 'matched' : result.why);

describe('GitHub’s webhook', () => {
  const issue = { number: 7, title: 'Export crashes', body: 'On the second click.', html_url: 'https://github.com/acme/api/issues/7', user: { login: 'reporter' }, labels: [{ name: 'bug' }] };
  const gh = (event: string, id = 'd-1') => ({ 'x-github-event': event, 'x-github-delivery': id });

  it('starts on an issue assigned to the one the trigger names, and on nobody else', () => {
    const node = trigger('github-issues.trigger.issue-assigned', { assignee: '@relay-bot' });
    const body = { action: 'assigned', assignee: { login: 'Relay-Bot' }, issue, sender: { login: 'maintainer' } };
    const event = matched(read(node, body, gh('issues')));
    assert.deepEqual([event.source, event.attended, event.actor], ['webhook', false, 'maintainer']);
    // Named after what it said, not after a header: the signature covers the body, and a replay could change the header.
    assert.match(event.id, /^delivery-[0-9a-f]{16}$/);
    assert.equal(matched(read(node, body, gh('issues', 'd-2'))).id, event.id);
    assert.deepEqual(event.task, { kind: 'issue', ref: 'https://github.com/acme/api/issues/7' });
    assert.deepEqual([event.payload['key'], event.payload['title'], event.payload['assignee'], event.payload['labels']], ['#7', 'Export crashes', 'Relay-Bot', ['bug']]);

    assert.match(why(read(node, { ...body, assignee: { login: 'alice' } }, gh('issues'))), /assigned to alice, not relay-bot/);
    assert.match(why(read(node, { ...body, action: 'labeled' }, gh('issues'))), /not an issue being assigned/);
    assert.match(why(read(node, { zen: 'Keep it logically awesome.' }, gh('ping'))), /ping/);
    assert.match(why(read(node, 'text', gh('issues'))), /not a JSON object/);
  });

  it('takes the issue’s address only when it is one, and says why it ignored a delivery in words a terminal can print', () => {
    const node = trigger('github-issues.trigger.issue-opened');
    const elsewhere = matched(read(node, { action: 'opened', issue: { ...issue, html_url: '/etc/passwd' }, sender: { login: 'reporter' } }, gh('issues')));
    assert.deepEqual(elsewhere.task, { kind: 'issue', ref: '7' }, 'the number is still the issue');
    assert.equal(elsewhere.payload['url'], '');
    const nowhere = matched(read(node, { action: 'opened', issue: { title: 'x', html_url: 'https://github.com/acme/api/../../x' }, sender: { login: 'reporter' } }, gh('issues')));
    assert.equal(nowhere.task, null);

    const said = why(read(node, { action: '\u001b[2Jdeleted\u0007' }, gh('issues')));
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(said, /[\u0000-\u001f]/);
    assert.match(said, /deleted/);
  });

  it('starts on a new issue, with the label if one is asked for, and on a comment that mentions it', () => {
    const opened = trigger('github-issues.trigger.issue-opened', { label: 'bug' });
    assert.equal(read(opened, { action: 'opened', issue, sender: { login: 'reporter' } }, gh('issues')).match, true);
    assert.match(why(read(opened, { action: 'opened', issue: { ...issue, labels: [] } }, gh('issues'))), /without the label bug/);

    const comment = trigger('github-issues.trigger.issue-comment', { mention: '@relay' });
    const event = matched(read(comment, { action: 'created', issue, comment: { body: 'Hey @Relay, please fix' }, sender: { login: 'maintainer' } }, gh('issue_comment')));
    assert.equal(event.actor, 'maintainer');
    assert.match(why(read(comment, { action: 'created', issue, comment: { body: 'thanks' } }, gh('issue_comment'))), /does not mention @relay/);
    assert.match(why(read(comment, { action: 'created', issue: { ...issue, pull_request: {} }, comment: { body: '@relay' } }, gh('issue_comment'))), /on a pull request/);
  });

  it('starts on main going red, once, and again only after it has been green', () => {
    const node = trigger('github-actions.trigger.workflow-failed', { workflow: 'ci.yml', branch: 'main', firstFailureOnly: true });
    const memory = new Map<string, string>();
    const run = (conclusion: string, extra: Record<string, unknown> = {}) => ({
      action: 'completed',
      workflow_run: { id: 9913, run_number: 41, name: 'CI', path: '.github/workflows/ci.yml', head_branch: 'main', head_sha: '3f2a1c0deadbeef', conclusion, html_url: 'https://github.com/acme/api/actions/runs/9913', head_commit: { message: 'Tidy retry' }, ...extra },
      sender: { login: 'maintainer' },
    });
    const first = matched(read(node, run('failure'), gh('workflow_run'), { memory }));
    assert.equal(first.payload['title'], 'CI failing on main: CI');
    assert.match(String(first.payload['body']), /gh run view 9913 --log-failed/);
    assert.equal(first.task?.kind, 'prompt');

    assert.match(why(read(node, run('failure'), gh('workflow_run', 'd-2'), { memory })), /failing again: only its first failure starts a run/);
    assert.match(why(read(node, run('success'), gh('workflow_run', 'd-3'), { memory })), /ended success/);
    assert.equal(read(node, run('failure'), gh('workflow_run', 'd-4'), { memory }).match, true, 'red again after green is a new failure');
    assert.match(why(read(node, run('failure', { head_branch: 'feature' }), gh('workflow_run'), { memory })), /a run on feature, not on main/);
    assert.match(why(read(trigger('github-actions.trigger.workflow-failed', { workflow: 'deploy.yml' }), run('failure'), gh('workflow_run'))), /a run of CI, not of deploy.yml/);
  });

  it('starts on a security alert at or above the severity asked for', () => {
    const codeql = trigger('codeql.trigger.alert-created', { severity: 'high' });
    const alert = { number: 12, html_url: 'https://github.com/acme/api/security/code-scanning/12', rule: { description: 'SQL injection', security_severity_level: 'critical' }, most_recent_instance: { location: { path: 'src/db.ts', start_line: 41 }, message: { text: 'This query depends on user input.' } } };
    const event = matched(read(codeql, { action: 'created', alert }, gh('code_scanning_alert')));
    assert.equal(event.payload['title'], 'Code scanning: SQL injection');
    assert.match(String(event.payload['body']), /src\/db\.ts:41/);
    assert.match(why(read(codeql, { action: 'created', alert: { ...alert, rule: { ...alert.rule, security_severity_level: 'medium' } } }, gh('code_scanning_alert'))), /a medium alert, below high/);
    assert.match(why(read(codeql, { action: 'fixed', alert }, gh('code_scanning_alert'))), /not a new code scanning alert/);

    const dependabot = trigger('dependabot.trigger.alert-created', { severity: 'high' });
    const advisory = { action: 'created', alert: { number: 3, html_url: 'https://github.com/acme/api/security/dependabot/3', dependency: { package: { name: 'lodash' } }, security_advisory: { summary: 'Prototype pollution', severity: 'high' }, security_vulnerability: { first_patched_version: { identifier: '4.17.21' } } } };
    const found = matched(read(dependabot, advisory, gh('dependabot_alert')));
    assert.equal(found.payload['title'], 'Vulnerable dependency: lodash (high)');
    assert.match(String(found.payload['body']), /First patched version: 4\.17\.21/);
  });
});

describe('Linear’s webhook', () => {
  const data = { id: 'uuid', identifier: 'ENG-142', title: 'Fix the flaky timeout', description: 'It fails on CI.', team: { key: 'ENG' }, assigneeId: 'u1', assignee: { id: 'u1', name: 'Relay Bot', email: 'relay-bot@acme.dev' }, labelIds: ['l-bug'], labels: [{ id: 'l-bug', name: 'Bug' }], state: { name: 'Todo' }, priorityLabel: 'High' };
  const body = (action: string, updatedFrom: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, actor: Record<string, unknown> = { name: 'Ada' }) => ({ type: 'Issue', action, data: { ...data, ...extra }, updatedFrom, url: 'https://linear.app/acme/issue/ENG-142', actor });
  const headers = { 'linear-delivery': 'lin-1' };

  it('starts when an issue is assigned to the bot, by name or by address', () => {
    const node = trigger('linear.trigger.issue-assigned', { assignee: '@relay-bot', team: 'eng' });
    const event = matched(read(node, body('update', { assigneeId: null }), headers));
    assert.deepEqual([event.actor, event.payload['key'], event.payload['assignee'], event.payload['url']], ['Ada', 'ENG-142', 'Relay Bot', 'https://linear.app/acme/issue/ENG-142']);
    assert.match(event.id, /^delivery-[0-9a-f]{16}$/);
    assert.deepEqual(event.task, { kind: 'prompt', text: 'ENG-142: Fix the flaky timeout\n\nIt fails on CI.' });
    assert.deepEqual(matched(read(node, body('update', { assigneeId: null }), headers, { linear: true })).task, { kind: 'issue', ref: 'ENG-142' }, 'with a key, the engine fetches the ticket itself');
    assert.equal(read(trigger('linear.trigger.issue-assigned', { assignee: 'Relay Bot' }), body('create'), headers).match, true, 'created already assigned');

    assert.match(why(read(node, body('update', { title: 'old' }), headers)), /without a new assignee/);
    // Taking somebody off an issue changes its assignee as well, to nobody. That is not an assignment, with a name asked for or without.
    const anyone = trigger('linear.trigger.issue-assigned');
    assert.equal(read(anyone, body('update', { assigneeId: null }), headers).match, true);
    assert.match(why(read(anyone, body('update', { assigneeId: 'u1' }, { assignee: null, assigneeId: null }), headers)), /without a new assignee/);
    assert.match(why(read(anyone, body('create', {}, { assignee: undefined, assigneeId: undefined }), headers)), /without a new assignee/);
    assert.match(why(read(node, body('update', { assigneeId: 'x' }, { assignee: { name: 'Grace' } }), headers)), /assigned to Grace, not relay-bot/);
    assert.match(why(read(node, body('update', { assigneeId: null }, { team: { key: 'OPS' } }), headers)), /in team OPS, not eng/);
    assert.match(why(read(node, { type: 'Comment', action: 'create', data: {} }, headers)), /a Linear Comment, not an issue/);
  });

  it('starts on a new issue, a label, and a move to a state', () => {
    assert.equal(read(trigger('linear.trigger.issue-created', { team: 'ENG' }), body('create'), headers).match, true);
    assert.match(why(read(trigger('linear.trigger.issue-created'), body('update', { title: 'x' }), headers)), /not a new one/);

    const labelled = trigger('linear.trigger.issue-labelled', { label: 'bug' });
    assert.equal(read(labelled, body('update', { labelIds: [] }), headers).match, true);
    assert.equal(read(labelled, body('create'), headers).match, true, 'created with the label already on it');
    assert.match(why(read(labelled, body('update', { labelIds: [] }, { labels: [] }), headers)), /without the label bug/);
    assert.match(why(read(labelled, body('update', { title: 'x' }), headers)), /without its labels changing/);
    // Another label was added, or one was taken off, and this one was there all along.
    assert.match(why(read(labelled, body('update', { labelIds: ['l-bug'] }, { labelIds: ['l-bug', 'l-ui'], labels: [{ id: 'l-bug', name: 'Bug' }, { id: 'l-ui', name: 'UI' }] }), headers)), /already had the label bug/);
    assert.match(why(read(labelled, body('update', { labelIds: ['l-bug', 'l-ui'] }), headers)), /already had the label bug/);
    // A delivery that does not say which labels it had is not read as "none".
    assert.match(why(read(labelled, body('update', { labelIds: 'changed' }), headers)), /does not say which labels it had/);
    assert.match(why(read(labelled, body('update', { labelIds: [] }, { labels: [{ name: 'Bug' }] }), headers)), /does not say which labels it had/);

    const moved = trigger('linear.trigger.issue-state-changed', { state: 'Ready for agent' });
    assert.equal(read(moved, body('update', { stateId: 's0' }, { state: { name: 'ready for agent' } }), headers).match, true);
    assert.match(why(read(moved, body('update', { stateId: 's0' }), headers)), /moved to Todo, not Ready for agent/);
  });

  it('names who did it by their address, which they cannot retype, when Linear sends one', () => {
    const node = trigger('linear.trigger.issue-created');
    assert.equal(matched(read(node, body('create', {}, {}, { name: 'repo-owner', email: 'mallory@acme.dev' }), headers)).actor, 'mallory@acme.dev');
    assert.equal(matched(read(node, body('create', {}, {}, { name: 'Ada' }), headers)).actor, 'Ada');
    assert.equal(matched(read(node, body('create', {}, {}, {}), headers)).actor, null);
  });

  it('will not take a ticket key that is not one as the issue to fetch', () => {
    const node = trigger('linear.trigger.issue-created');
    assert.match(why(read(node, body('create', {}, { identifier: '../../etc/passwd' }), headers, { linear: true })), /no identifier/);
    assert.match(why(read(node, body('create', {}, { identifier: 'AAAAAAAAAAAAAAAAAAAA-1' }), headers, { linear: true })), /no identifier/);
  });
});

describe('Sentry’s webhook', () => {
  const issue = { id: '2417', shortId: 'WEB-2417', title: "TypeError: Cannot read properties of undefined (reading 'currency')", culprit: 'formatTotal(src/checkout/totals.ts)', web_url: 'https://acme.sentry.io/issues/2417/', project: { slug: 'web' }, userCount: 12, level: 'error', metadata: { type: 'TypeError', value: "Cannot read properties of undefined (reading 'currency')", filename: 'src/checkout/totals.ts', function: 'formatTotal' } };
  const headers = (resource: string) => ({ 'sentry-hook-resource': resource });

  it('starts on a new issue in the project, when enough people have met it', () => {
    const node = trigger('sentry.trigger.issue-created', { project: 'web', minUsers: 5 });
    const event = matched(read(node, { action: 'created', data: { issue }, actor: { type: 'application', name: 'Sentry' } }, headers('issue')));
    assert.deepEqual([event.payload['key'], event.payload['url'], event.payload['project']], ['WEB-2417', 'https://acme.sentry.io/issues/2417/', 'web']);
    assert.equal(event.task?.kind, 'prompt');
    assert.match(String(event.payload['body']), /In formatTotal\(src\/checkout\/totals\.ts\)\.[\s\S]*File: src\/checkout\/totals\.ts, in formatTotal/);

    assert.match(why(read(node, { action: 'created', data: { issue: { ...issue, userCount: 1 } } }, headers('issue'))), /affecting 1 user, fewer than 5/);
    assert.match(why(read(node, { action: 'created', data: { issue: { ...issue, project: { slug: 'api' } } } }, headers('issue'))), /in api, not web/);
    // A delivery that names no project is not in the one that was asked for.
    assert.match(why(read(node, { action: 'created', data: { issue: { ...issue, project: undefined } } }, headers('issue'))), /names no project, where web is wanted/);
    assert.match(why(read(node, { action: 'resolved', data: { issue } }, headers('issue'))), /not a new one/);
    // An alert rule's delivery has already done the counting, in Sentry.
    assert.equal(read(node, { action: 'triggered', data: { event: { title: issue.title, web_url: issue.web_url, issue_id: '2417', project: 'web' } } }, headers('event_alert')).match, true);
    assert.match(why(read(node, { action: 'created', data: {} }, headers('installation'))), /not an issue/);
  });

  it('starts on an issue coming back, and on one assigned to the bot', () => {
    const regressed = trigger('sentry.trigger.issue-regressed', {});
    assert.equal(read(regressed, { action: 'unresolved', data: { issue: { ...issue, substatus: 'regressed' } } }, headers('issue')).match, true);
    assert.match(why(read(regressed, { action: 'created', data: { issue } }, headers('issue'))), /not one coming back/);
    // A person reopening it is `unresolved` too; an issue that regressed last week still says so when it is assigned.
    assert.match(why(read(regressed, { action: 'unresolved', data: { issue: { ...issue, substatus: 'ongoing' } } }, headers('issue'))), /not one coming back/);
    assert.match(why(read(regressed, { action: 'unresolved', data: { issue } }, headers('issue'))), /not one coming back/);
    assert.match(why(read(regressed, { action: 'assigned', data: { issue: { ...issue, substatus: 'regressed' } } }, headers('issue'))), /not one coming back/);

    const assigned = trigger('sentry.trigger.issue-assigned', { assignee: 'relay-bot' });
    assert.equal(read(assigned, { action: 'assigned', data: { issue: { ...issue, assignedTo: { name: 'relay-bot', email: 'relay-bot@acme.dev' } } } }, headers('issue')).match, true);
    assert.match(why(read(assigned, { action: 'assigned', data: { issue: { ...issue, assignedTo: { name: 'Grace' } } } }, headers('issue'))), /assigned to Grace, not relay-bot/);
  });
});

describe('relay workflow serve, for an app’s own trigger', () => {
  const graph = (type: string, config: Record<string, unknown> = {}) =>
    parseGraph({ version: 1, id: 'w', name: 'Linear ticket to pull request', nodes: [{ id: 't', type, kind: 'trigger', name: 'Linear: Assigned to the bot', config, outputs: ['issue'] }], edges: [], config: { version: 1 } });

  it('will not listen for an app without the secret its deliveries are signed with', async () => {
    const base = { signal: new AbortController().signal, runSignal: new AbortController().signal, log: () => undefined, port: 0, run: async (): Promise<GraphOutcome> => assert.fail('nothing runs') };
    await assert.rejects(serveWorkflow({ ...base, env: {}, graph: graph('linear.trigger.issue-assigned') }), /delivered by the app, signed\. Set RELAY_WEBHOOK_SECRET/);
    await assert.rejects(serveWorkflow({ ...base, env: { RELAY_WEBHOOK_SECRET: 's' }, graph: graph('zendesk.trigger.ticket-tagged') }), /Nothing listens for/);
  });

  it('takes a signed delivery that is the trigger, and answers the rest without starting anything', async () => {
    const accepting = new AbortController();
    const logs: ServeLog[] = [];
    const events: WorkflowEvent[] = [];
    let url = '';
    const done = serveWorkflow({
      graph: graph('linear.trigger.issue-assigned', { assignee: 'relay-bot' }),
      env: { RELAY_WEBHOOK_SECRET: 's3cret' },
      port: 0,
      signal: accepting.signal,
      runSignal: new AbortController().signal,
      log: (entry) => logs.push(entry),
      onListening: (bound) => (url = `http://127.0.0.1:${bound.port}${bound.path}`),
      run: async (event) => {
        events.push(event);
        return { status: 'succeeded', exitCode: 0, summary: 'ok', nodes: {}, pipeline: null, unwired: [], costUsd: null };
      },
    });
    try {
      for (let tries = 0; url === '' && tries < 200; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.match(url, /\/hooks\/linear$/);
      const post = (body: unknown, sign = true): Promise<Response> => {
        const raw = JSON.stringify(body);
        return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(sign ? { 'linear-signature': signBody('s3cret', raw).replace('sha256=', '') } : {}) }, body: raw });
      };
      const assigned = { type: 'Issue', action: 'update', updatedFrom: { assigneeId: null }, data: { identifier: 'ENG-142', title: 'Fix it', assignee: { name: 'relay-bot' } }, actor: { name: 'Ada' } };

      assert.equal((await post(assigned, false)).status, 401);
      const other = await post({ type: 'Issue', action: 'update', updatedFrom: { title: 'x' }, data: { identifier: 'ENG-142', title: 'Fix it' } });
      assert.deepEqual([other.status, ((await other.json()) as { accepted: boolean }).accepted], [200, false], 'answered, so Linear does not send it again');
      assert.equal((await post(assigned)).status, 202);
      for (let tries = 0; events.length === 0 && tries < 200; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.deepEqual(events.map((event) => [event.payload['key'], event.actor, event.attended]), [['ENG-142', 'Ada', false]]);
      assert.ok(logs.some((entry) => entry.type === 'ignored' && /without a new assignee/.test(entry.reason)));
    } finally {
      accepting.abort();
      await done;
    }
  });

  it('gives each app its own path, and says in the table that the secret is not optional', () => {
    assert.equal(webhookPath(trigger('sentry.trigger.issue-created')), '/hooks/sentry');
    assert.equal(webhookPath(trigger('http.trigger.webhook', { path: '/ticket in/' })), '/hooks/ticket-in');
    for (const type of APP_WEBHOOK_TRIGGERS) {
      const support = nodeSupport(type);
      assert.deepEqual([support.real, support.needs], [true, ['RELAY_WEBHOOK_SECRET']], type);
    }
    assert.equal(nodeSupport('zendesk.trigger.ticket-tagged').real, false);
  });
});
