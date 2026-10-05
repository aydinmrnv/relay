import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { approvalOpen, approvalsDir, createApproval, decideApproval, listApprovals, waitForApproval } from '../src/graph/approvals.ts';
import { issueEvent, manualEvent, scheduleEvent, signatureValid, signBody, webhookEvent } from '../src/graph/events.ts';
import { evaluateCondition, evaluateFilter, isJsonTemplate, renderJsonTemplate, renderTemplate } from '../src/graph/expression.ts';
import { nextCronTime, nextWindowOpening, parseCron } from '../src/graph/schedule.ts';
import { isIssueReference, plainText } from '../src/graph/types.ts';
import { adoptedRunTrigger, adoptRunTrigger, RUN_TRIGGER_VARIABLE, setRunTrigger } from '../src/unattended/trigger.ts';

const context = {
  issue: { id: 'ENG-142', title: 'Fix the flaky timeout', labels: ['bug', 'P1'], estimate: 2.5, priority: 'high', assignee: '', body: 'It fails on CI.' },
  run: { cost: '$2.14', tests: 'passed', prUrl: '' },
};

describe('a Filter expression', () => {
  const yes = (expression: string): void => assert.deepEqual(evaluateFilter(expression, context), { ok: true, value: true }, expression);
  const no = (expression: string): void => assert.deepEqual(evaluateFilter(expression, context), { ok: true, value: false }, expression);

  it('compares numbers as numbers, and a cost by its amount', () => {
    yes('issue.estimate <= 3');
    no('issue.estimate > 3');
    yes('issue.estimate == 2.5');
    yes('run.cost < 5');
    no('run.cost >= 5');
  });

  it('compares text without regard to case, and looks inside lists', () => {
    yes('issue.priority == "HIGH"');
    yes("issue.priority != 'low'");
    yes('issue.labels contains "p1"');
    no('issue.labels contains "feature"');
    yes('issue.title contains "flaky"');
    yes('issue.priority in ["urgent", "high"]');
    yes('issue.title matches "^fix .* timeout$"');
  });

  it('combines with and, or, not and parentheses, in the usual order', () => {
    yes('issue.estimate <= 3 && issue.labels contains "bug"');
    yes('issue.estimate > 3 || issue.labels contains "bug"');
    no('!(issue.labels contains "bug")');
    yes('issue.estimate > 3 || issue.priority == "high" && run.tests == "passed"');
    no('(issue.estimate > 3 || issue.priority == "high") && run.tests == "failed"');
    yes('issue.estimate <= 3 and not issue.assignee');
  });

  it('treats a field with no value as closing the filter, never opening it', () => {
    no('issue.missing <= 3');
    no('issue.missing contains "x"');
    no('issue.missing');
    no('run.prUrl');
    yes('issue.missing == null');
    yes('issue.title');
  });

  it('passes an empty expression, and names what is wrong with a broken one', () => {
    yes('  ');
    for (const [expression, expected] of [
      ['issue.estimate <=', /ends where a value should be/],
      ['issue.estimate <= 3 extra', /“extra” is left over/],
      ['(issue.estimate <= 3', /a “\(” is never closed/],
      ['issue.title == "open', /never closed/],
      ['issue.estimate <= 3; process.exit()', /“;” at character 20/],
      ['issue.title matches "("', /Invalid regular expression/],
    ] as const) {
      const result = evaluateFilter(expression, context);
      assert.equal(result.ok, false, expression);
      assert.match(result.ok ? '' : result.error, expected);
    }
  });

  it('has nothing to call: a path is read, never run', () => {
    const result = evaluateFilter('constructor.constructor("return process")()', context);
    assert.equal(result.ok, false);
    assert.deepEqual(evaluateFilter('issue.constructor', { issue: {} }).ok, true);
  });
});

describe('a Condition, and the templates around it', () => {
  it('reads an empty field as satisfying nothing', () => {
    assert.equal(evaluateCondition('', 'lt', '3'), false);
    assert.equal(evaluateCondition('', 'not-equals', 'bug'), true);
    assert.equal(evaluateCondition('bug, P1', 'contains', 'BUG'), true);
    assert.equal(evaluateCondition('2.5', 'gt', '2'), true);
    assert.equal(evaluateCondition('abc', 'matches', '('), false);
  });

  it('passes each value through where it is going, and leaves the template as its author wrote it', () => {
    const context = { issue: { title: 'a <b> & "c"', labels: ['x', 'y&z'] } };
    const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    assert.equal(renderTemplate('<{{issue.title}}> & {{issue.labels}} {{issue.none}}', context, escape), '<a &lt;b&gt; &amp; "c"> & x, y&amp;z ');
    assert.equal(renderTemplate('/t/{{issue.title}}', context, encodeURIComponent), '/t/a%20%3Cb%3E%20%26%20%22c%22');
  });

  it('writes a JSON body that stays the JSON its author wrote, whatever a value says', () => {
    const context = { issue: { title: 'say "hi"\n", "admin": true, "x": "', number: 7, labels: ['a', 'b'], nested: { ok: true }, open: true } };
    const body = renderJsonTemplate('{"title": "{{issue.title}}", "n": {{issue.number}}, "labels": "{{issue.labels}}", "raw": {{issue.labels}}, "nested": {{issue.nested}}, "open": {{issue.open}}, "bare": {{issue.title}}, "gone": {{issue.gone}}, "empty": "{{issue.gone}}", "quote\\"d {{issue.number}}": 1}', context);
    assert.deepEqual(JSON.parse(body), {
      title: context.issue.title,
      n: 7,
      labels: 'a, b',
      raw: ['a', 'b'],
      nested: { ok: true },
      open: true,
      bare: context.issue.title,
      gone: null,
      empty: '',
      'quote"d 7': 1,
    });
    assert.deepEqual([isJsonTemplate(' {"a": 1}'), isJsonTemplate('[1]'), isJsonTemplate('done: {{run.id}}'), isJsonTemplate('')], [true, true, false, false]);
  });

  it('runs a pattern over the start of a long field, not over all of it', () => {
    const long = `${'a'.repeat(10_000)}needle`;
    assert.equal(evaluateCondition(long, 'matches', 'needle'), false, 'past the first ten thousand characters');
    assert.equal(evaluateCondition(long, 'matches', '^a+$'), true);
    assert.deepEqual(evaluateFilter('issue.body matches "needle"', { issue: { body: long } }), { ok: true, value: false });
    assert.equal(evaluateCondition(long, 'contains', 'needle'), true, 'a plain search still reads all of it');
  });

  it('fills variables, joins lists, and leaves an unknown one empty', () => {
    assert.equal(renderTemplate('{{issue.id}}: {{ issue.title }} [{{issue.labels}}] {{issue.nope}}.', context), 'ENG-142: Fix the flaky timeout [bug, P1] .');
  });
});

describe('the clock', () => {
  const next = (expression: string, after: string, zone = 'UTC'): string | null => {
    const parsed = parseCron(expression);
    assert.ok(parsed.ok, expression);
    return nextCronTime(parsed.schedule, new Date(after), zone)?.toISOString() ?? null;
  };

  it('finds the next minute a cron expression names', () => {
    assert.equal(next('0 9 * * 1-5', '2026-10-02T09:00:00Z'), '2026-10-05T09:00:00.000Z', 'Friday 09:00 is not after itself; Monday is next');
    assert.equal(next('*/15 * * * *', '2026-10-05T10:07:30Z'), '2026-10-05T10:15:00.000Z');
    assert.equal(next('30 6 1 * *', '2026-10-05T00:00:00Z'), '2026-11-01T06:30:00.000Z');
    assert.equal(next('0 0 * * SUN', '2026-10-05T00:00:00Z'), '2026-10-11T00:00:00.000Z');
    assert.equal(next('0 0 * * 7', '2026-10-05T00:00:00Z'), '2026-10-11T00:00:00.000Z');
    assert.equal(next('0 9 * * sat-sun', '2026-10-05T00:00:00Z'), '2026-10-10T09:00:00.000Z', 'a weekend, written the way people write one');
    assert.equal(next('0 9 * * sat-sun', '2026-10-10T09:00:00Z'), '2026-10-11T09:00:00.000Z');
    assert.equal(next('0 12 29 FEB *', '2026-10-05T00:00:00Z'), '2028-02-29T12:00:00.000Z');
    // Both day fields restricted: either is enough, as in cron.
    assert.equal(next('0 0 13 * FRI', '2026-10-05T00:00:00Z'), '2026-10-09T00:00:00.000Z');
  });

  it('keeps the hour in the zone it was written for, across a change of clocks', () => {
    assert.equal(next('0 9 * * *', '2026-10-24T12:00:00Z', 'Europe/London'), '2026-10-25T09:00:00.000Z', 'the clocks went back that morning');
    assert.equal(next('0 9 * * *', '2026-10-23T12:00:00Z', 'Europe/London'), '2026-10-24T08:00:00.000Z');
    assert.equal(next('30 9 * * *', '2026-10-05T00:00:00Z', 'Asia/Kolkata'), '2026-10-05T04:00:00.000Z');
  });

  it('refuses an expression it cannot read, and returns null for one that never comes round', () => {
    for (const expression of ['0 9 * *', '61 * * * *', '* * * * MONDAYISH', '*/0 * * * *', '5-1 * * * *', '1-5-9 * * * *', '1/2/3 * * * *', '0x10 * * * *', '1e1 * * * *', '*/1.5 * * * *', '0 9 * * 1-', ' 0 9 , * *']) {
      assert.equal(parseCron(expression).ok, false, expression);
    }
    assert.equal(next('0 0 31 2 *', '2026-10-05T00:00:00Z'), null);
  });

  it('reads a day field that opens with * as any day, as cron does', () => {
    // Every other day of the month, and only when that is a Monday: not "or any Monday".
    assert.equal(next('0 0 */2 * MON', '2026-10-05T12:00:00Z'), '2026-10-19T00:00:00.000Z', 'the 12th is a Monday and an even day; the 19th is the next Monday on an odd one');
    assert.equal(next('0 0 13 * */2', '2026-10-05T00:00:00Z'), '2026-10-13T00:00:00.000Z', 'the 13th is a Tuesday, an even weekday');
  });

  it('fires once for an hour the clock repeats, and once for one it jumps over', () => {
    // New York, 2026: the clocks go forward at 02:00 on 8 March, and back at 02:00 on 1 November.
    const zone = 'America/New_York';
    assert.equal(next('30 2 * * *', '2026-03-07T12:00:00Z', zone), '2026-03-08T07:00:00.000Z', '02:30 does not exist that night: it fires as the jump lands, at 03:00');
    assert.equal(next('30 2 * * *', '2026-03-08T07:00:00Z', zone), '2026-03-09T06:30:00.000Z', 'and at 02:30 again the next night');
    assert.equal(next('30 1 * * *', '2026-10-31T12:00:00Z', zone), '2026-11-01T05:30:00.000Z', 'the first 01:30');
    assert.equal(next('30 1 * * *', '2026-11-01T05:30:00Z', zone), '2026-11-02T06:30:00.000Z', 'not the second, an hour later');
    // A schedule for every hour is not about one, and runs straight through both.
    assert.equal(next('0 * * * *', '2026-11-01T05:00:00Z', zone), '2026-11-01T06:00:00.000Z');
    assert.equal(next('0 * * * *', '2026-03-08T06:00:00Z', zone), '2026-03-08T07:00:00.000Z');
  });

  it('knows when a working window is open, and when it next opens', () => {
    const at = (iso: string, window: string, zone: string) => nextWindowOpening(new Date(iso), window, zone);
    assert.deepEqual(at('2026-10-05T10:00:00Z', '09:00-18:00 Mon-Fri', 'UTC'), { ok: true, waitMs: 0, opensAt: new Date('2026-10-05T10:00:00Z') });
    const friday = at('2026-10-09T18:30:00Z', '09:00-18:00 Mon-Fri', 'UTC');
    assert.equal(friday.ok && friday.opensAt.toISOString(), '2026-10-12T09:00:00.000Z');
    const night = at('2026-10-05T23:30:00Z', '22:00-06:00', 'UTC');
    assert.equal(night.ok && night.waitMs, 0, 'a window across midnight is open at 23:30');
    assert.equal(at('2026-10-05T10:00:00Z', 'whenever', 'UTC').ok, false);
    assert.equal(at('2026-10-05T10:00:00Z', '09:00-18:00', 'Mars/Olympus').ok, false);
  });
});

describe('events', () => {
  const now = new Date('2026-10-05T10:00:00Z');

  it('reads a flat webhook body, and fetches an issue only when one is named', () => {
    const described = webhookEvent({ title: 'Export crashes', description: 'On the second click.', actor: '@octocat' }, { now });
    assert.equal(described.attended, false);
    assert.equal(described.actor, 'octocat');
    assert.equal(described.task, null, 'the walk makes a prompt of the title and body');
    assert.equal(described.payload['body'], 'On the second click.');

    const named = webhookEvent({ issue: 142, actor: { login: 'octocat' } }, { now });
    assert.deepEqual(named.task, { kind: 'issue', ref: '142' });
    assert.equal(named.payload['number'], 142);
    assert.equal(named.payload['key'], '#142');

    // What becomes an argument to `relay run` is held to what an issue reference looks like.
    assert.equal(webhookEvent({ issue: '--deliver=merge' }, { now }).task, null);
    assert.equal(webhookEvent('just text', { now }).payload['body'], 'just text');
  });

  it('recognises a GitHub issue event and a Linear one', () => {
    const github = webhookEvent(
      { action: 'labeled', label: { name: 'relay:go' }, sender: { login: 'maintainer' }, issue: { number: 7, title: 'Fix it', body: 'Steps…', html_url: 'https://github.com/acme/api/issues/7', user: { login: 'reporter' }, labels: [{ name: 'bug' }] } },
      { now },
    );
    assert.equal(github.actor, 'maintainer', 'who did it, not who wrote the issue');
    assert.deepEqual(github.task, { kind: 'issue', ref: 'https://github.com/acme/api/issues/7' });
    assert.deepEqual([github.payload['key'], github.payload['title'], github.payload['labels']], ['#7', 'Fix it', ['bug']]);

    const body = { type: 'Issue', action: 'create', data: { identifier: 'ENG-9', title: 'Paginate', description: 'The audit log.', url: 'https://linear.app/acme/issue/ENG-9' } };
    assert.equal(webhookEvent(body, { now }).task, null, 'without a Linear key the ticket is described, not fetched');
    assert.deepEqual(webhookEvent(body, { now, linear: true }).task, { kind: 'issue', ref: 'ENG-9' });
    assert.equal(webhookEvent(body, { now }).payload['body'], 'The audit log.');
  });

  it('takes as an issue only what a tracker would call one', () => {
    for (const ref of ['142', '#142', 'acme/widgets#142', 'acme/my.repo_1#7', 'https://github.com/acme/widgets/issues/142', 'ENG-142', 'eng-1', 'https://linear.app/acme/issue/ENG-142', 'https://linear.app/acme/issue/ENG-142/fix-the-timeout']) {
      assert.equal(isIssueReference(ref), true, ref);
    }
    for (const ref of [
      '', '.env', './spec.md', '../x', '/etc/passwd', 'spec.md', 'x/../../../etc/hosts', 'a/b', 'C:\\Users\\x', '142 ', '-142', '#', 'acme/..#1', 'acme/.#1',
      'https://github.com/acme/widgets/issues/142/../../../../etc/passwd', 'https://github.com/acme/../issues/1', 'http://github.com/acme/widgets/issues/142', 'https://github.com.evil.example/acme/widgets/issues/1',
      'https://github.com/acme/widgets/pull/142', 'https://linear.app/acme/issue/../x', 'file:///etc/passwd', 'ENG-142/../../x', 'ENG-', '--deliver=merge', '142\n../x',
    ]) {
      assert.equal(isIssueReference(ref), false, JSON.stringify(ref));
    }
    assert.deepEqual(['a\u001b[2Jb', 'a\u0007b\u202Ec', 'line one\nline two\ttabbed'].map(plainText), ['a [2Jb', 'a b c', 'line one\nline two\ttabbed']);
  });

  it('takes nobody’s word for who sent an unsigned delivery', () => {
    const body = { title: 'x', actor: 'repo-owner' };
    assert.equal(webhookEvent(body, { now, vouched: false }).actor, null);
    assert.equal(webhookEvent(body, { now, vouched: true }).actor, 'repo-owner');
    assert.equal(webhookEvent(body, { now }).actor, 'repo-owner', 'a caller that says nothing has vouched for it itself');
  });

  it('names a delivery after what it said, which is the part a signature covers', () => {
    const body = { title: 'x' };
    assert.equal(webhookEvent(body, { now }).id, webhookEvent({ title: 'x' }, { now: new Date() }).id);
    assert.notEqual(webhookEvent(body, { now }).id, webhookEvent({ title: 'y' }, { now }).id);
  });

  it('checks a signature over the bytes as sent, in any of the headers apps use', () => {
    const raw = Buffer.from('{"title":"x"}');
    const signed = signBody('s3cret', raw);
    assert.equal(signatureValid('s3cret', raw, { 'x-relay-signature': signed }), true);
    assert.equal(signatureValid('s3cret', raw, { 'x-hub-signature-256': signed }), true);
    assert.equal(signatureValid('s3cret', raw, { 'linear-signature': signed.replace('sha256=', '') }), true);
    assert.equal(signatureValid('s3cret', Buffer.from('{"title":"y"}'), { 'x-relay-signature': signed }), false);
    assert.equal(signatureValid('other', raw, { 'x-relay-signature': signed }), false);
    assert.equal(signatureValid('s3cret', raw, {}), false);
    assert.equal(signatureValid('s3cret', raw, { 'x-relay-signature': 'sha256=nothex' }), false);
  });

  it('marks who is at the controls', () => {
    assert.equal(manualEvent({ kind: 'prompt', text: 'Fix it\nplease' }, now).attended, true);
    assert.equal(manualEvent({ kind: 'prompt', text: 'Fix it\nplease' }, now).payload['title'], 'Fix it');
    assert.equal(scheduleEvent(now, '').attended, false);
    assert.equal(scheduleEvent(now, '').task, null);
    const issue = { id: 'github:acme/api#7', number: 7, title: 'T', body: 'B', url: 'u', state: 'open', author: 'a', labels: ['bug'], repository: null, comments: [] };
    assert.equal(issueEvent(issue, '7', { attended: false, actor: 'maintainer', now }).source, 'issue');
    assert.equal(issueEvent(issue, '7', { attended: true, actor: null, now }).payload['key'], '#7');
  });
});

describe('approvals on disk', () => {
  const ask = (approvers: string[] = []) => ({ workflow: 'W', node: 'n1', subject: 'Fix it', via: 'dashboard', approvers, expiresAt: new Date('2026-10-05T12:00:00Z') });
  const now = new Date('2026-10-05T10:00:00Z');

  async function repo(): Promise<{ root: string; done: () => Promise<void> }> {
    const root = await mkdtemp(join(tmpdir(), 'relay-approvals-'));
    return { root, done: () => rm(root, { recursive: true, force: true }) };
  }

  it('records a request, an answer, and who gave it', async () => {
    const { root, done } = await repo();
    try {
      const record = await createApproval(root, ask(), now);
      assert.match(record.id, /^ap-[a-z0-9]{8}$/);
      assert.deepEqual(await readdir(approvalsDir(root)), [`${record.id}.json`]);
      assert.equal(approvalOpen(record, now), true);

      const decided = await decideApproval(root, record.id, { approved: true, by: '@maintainer' }, now);
      assert.deepEqual([decided.status, decided.decidedBy], ['approved', 'maintainer']);
      await assert.rejects(decideApproval(root, record.id, { approved: false, by: 'other' }, now), /already approved by maintainer/);
      assert.equal((await listApprovals(root))[0]?.status, 'approved');
    } finally {
      await done();
    }
  });

  it('refuses an answer from a name not on the list, a late one, and an id that is not one', async () => {
    const { root, done } = await repo();
    try {
      const listed = await createApproval(root, ask(['lead']), now);
      await assert.rejects(decideApproval(root, listed.id, { approved: true, by: 'intern' }, now), /intern is not on the list/);
      assert.equal((await decideApproval(root, listed.id, { approved: true, by: 'Lead' }, now)).status, 'approved');

      const late = await createApproval(root, ask(), now);
      await assert.rejects(decideApproval(root, late.id, { approved: true, by: 'x' }, new Date('2026-10-05T12:00:01Z')), /ran out of time/);
      await assert.rejects(decideApproval(root, '../../etc/passwd', { approved: true, by: 'x' }, now), /is not an approval id/);
      await assert.rejects(decideApproval(root, 'ap-zzzzzzzz', { approved: true, by: 'x' }, now), /There is no approval/);
    } finally {
      await done();
    }
  });

  it('waits until somebody answers, or the time runs out, and a cancelled wait is neither', async () => {
    const { root, done } = await repo();
    try {
      const record = await createApproval(root, ask(), now);
      let polls = 0;
      const answered = await waitForApproval(root, record.id, {
        signal: new AbortController().signal,
        now: () => now,
        sleep: async () => {
          polls += 1;
          if (polls === 2) await decideApproval(root, record.id, { approved: false, by: 'lead' }, now);
        },
      });
      assert.deepEqual([answered.record.status, answered.timedOut, polls], ['rejected', false, 2]);

      const silent = await createApproval(root, ask(), now);
      let clock = now.getTime();
      const expired = await waitForApproval(root, silent.id, { signal: new AbortController().signal, now: () => new Date(clock), sleep: async () => void (clock += 3_600_000) });
      assert.equal(expired.timedOut, true);

      const cancelled = new AbortController();
      cancelled.abort();
      await assert.rejects(waitForApproval(root, silent.id, { signal: cancelled.signal }), /cancelled/);
    } finally {
      await done();
    }
  });
});

describe('telling a run that nobody started it', () => {
  it('takes the trigger out of the environment, and reads a garbled one as the stricter thing', () => {
    try {
      const env: NodeJS.ProcessEnv = { [RUN_TRIGGER_VARIABLE]: JSON.stringify({ label: 'an incoming webhook (workflow “W”)', actor: 'octocat', at: '2026-10-05T10:00:00.000Z', source: 'serve' }) };
      adoptRunTrigger(env);
      assert.equal(env[RUN_TRIGGER_VARIABLE], undefined, 'a child of this run must not inherit it');
      assert.deepEqual(adoptedRunTrigger(), { source: 'workflow', label: 'an incoming webhook (workflow “W”)', actor: 'octocat', at: '2026-10-05T10:00:00.000Z' });

      setRunTrigger(undefined);
      adoptRunTrigger({ [RUN_TRIGGER_VARIABLE]: 'not json' });
      assert.equal(adoptedRunTrigger()?.source, 'workflow', 'still unattended');

      setRunTrigger(undefined);
      adoptRunTrigger({});
      assert.equal(adoptedRunTrigger(), undefined);
    } finally {
      setRunTrigger(undefined);
    }
  });
});
