import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderIssueMarkdown } from '../src/github/types.ts';
import { branchNameFor } from '../src/git/worktree.ts';
import { issueHeadline, issueIdentity, issueTitle } from '../src/issues/identity.ts';
import { LinearIssueProvider, normalizeLinearIssue, parseLinearRef } from '../src/issues/linear.ts';
import { RoutingIssueProvider, isTrackerRef } from '../src/issues/registry.ts';
import { DEFAULT_CONFIG, mergeConfig } from '../src/storage/config.ts';
import { RelayError } from '../src/util/errors.ts';
import { redact } from '../src/util/redact.ts';
import { issueLinkFor } from '../src/workflow/delivery.ts';
import { pullRequestDraft } from '../src/workflow/publishRun.ts';
import { createRunState } from '../src/workflow/state.ts';

const KEY = 'lin_api_abcdefghijklmnopqrstuvwxyz0123456789';

interface Call { query: string; variables: Record<string, unknown>; authorization: string | null }

/** A Linear that answers from a script and remembers what it was asked. */
function fakeLinear(responses: Array<{ status?: number; body: unknown } | Error>) {
  const calls: Call[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    calls.push({ ...payload, authorization: new Headers(init.headers).get('authorization') });
    const next = responses.shift();
    if (next === undefined) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

function provider(responses: Parameters<typeof fakeLinear>[0], options: { team?: string; env?: NodeJS.ProcessEnv } = {}) {
  const linear = fakeLinear(responses);
  return {
    ...linear,
    provider: new LinearIssueProvider({
      fetch: linear.fetch,
      env: options.env ?? { LINEAR_API_KEY: KEY },
      sleep: async () => {},
      team: options.team ?? null,
    }),
  };
}

const ISSUE = {
  id: 'uuid-1',
  identifier: 'ENG-142',
  number: 142,
  title: 'Retry the flaky upload',
  description: 'Uploads time out under load.',
  url: 'https://linear.app/acme/issue/ENG-142/retry-the-flaky-upload',
  state: { name: 'In Progress', type: 'started' },
  creator: { displayName: 'ada' },
  labels: { nodes: [{ name: 'bug' }, { name: 'backend' }] },
  parent: null,
  comments: {
    nodes: [
      { body: 'Second: use exponential backoff.', createdAt: '2026-09-02T00:00:00Z', user: { displayName: 'grace' } },
      { body: 'First: only on 5xx.', createdAt: '2026-09-01T00:00:00Z', user: { name: 'Linus' } },
      { body: '   ', createdAt: '2026-09-03T00:00:00Z', user: null },
    ],
  },
};

describe('Linear references', () => {
  it('reads identifiers and linear.app URLs, and canonicalises them', () => {
    assert.equal(parseLinearRef('ENG-142'), 'ENG-142');
    assert.equal(parseLinearRef('eng-0142'), 'ENG-142');
    assert.equal(parseLinearRef('https://linear.app/acme/issue/ENG-142/retry-the-flaky-upload'), 'ENG-142');
    assert.equal(parseLinearRef('https://linear.app/acme/issue/ENG-142'), 'ENG-142');
  });

  it('claims a bare number only when a default team says whose it is', () => {
    assert.equal(parseLinearRef('142'), null);
    assert.equal(parseLinearRef('142', { team: 'eng' }), 'ENG-142');
    assert.equal(parseLinearRef('#142', { team: 'ENG' }), 'ENG-142');
  });

  it('leaves GitHub references, paths and prose alone', () => {
    for (const ref of ['acme/widgets#142', 'https://github.com/acme/widgets/issues/142', './spec.md', 'fix the bug', '-1', 'TOOLONGTEAMKEY-1']) {
      assert.equal(parseLinearRef(ref), null, ref);
    }
  });

  it('counts as a tracker reference everywhere the command layer asks', () => {
    assert.equal(isTrackerRef('ENG-142'), true);
    assert.equal(isTrackerRef('142'), true);
    assert.equal(isTrackerRef('spec.md'), false);
  });
});

describe('Linear issues', () => {
  it('fetches the whole issue with comments oldest-first, and sends the key bare', async () => {
    const { provider: linear, calls } = provider([{ body: { data: { issue: ISSUE } } }]);
    const issue = await linear.getIssue('eng-142');

    assert.equal(calls[0]!.variables['id'], 'ENG-142');
    assert.equal(calls[0]!.authorization, KEY);
    assert.equal(issue.id, 'linear:ENG-142');
    assert.equal(issue.key, 'ENG-142');
    assert.equal(issue.number, null);
    assert.equal(issue.state, 'In Progress');
    assert.equal(issue.author, 'ada');
    assert.deepEqual(issue.labels, ['bug', 'backend']);
    assert.deepEqual(issue.comments.map((comment) => comment.author), ['Linus', 'grace']);
    assert.match(renderIssueMarkdown(issue), /^# ENG-142: Retry the flaky upload/);
  });

  it('reports a completed or cancelled issue as closed, so the closed-issue guard still fires', () => {
    assert.equal(normalizeLinearIssue({ ...ISSUE, state: { name: 'Done', type: 'completed' } }).state, 'closed');
    assert.equal(normalizeLinearIssue({ ...ISSUE, state: { name: 'Canceled', type: 'canceled' } }).state, 'closed');
  });

  it('says which issue a sub-issue belongs to', () => {
    const issue = normalizeLinearIssue({ ...ISSUE, parent: { identifier: 'ENG-100', title: 'Upload reliability' } });
    assert.match(issue.body, /Sub-issue of ENG-100: Upload reliability/);
  });

  it('refuses without a key, naming the variable and never asking for it', async () => {
    const { provider: linear, calls } = provider([], { env: {} });
    await assert.rejects(linear.getIssue('ENG-142'), (error: RelayError) => {
      assert.equal(error.code, 'LINEAR_AUTH');
      assert.match(error.hint ?? '', /LINEAR_API_KEY/);
      return true;
    });
    assert.equal(calls.length, 0);
    const availability = await linear.checkAvailability();
    assert.equal(availability.available, false);
    assert.match(availability.detail, /LINEAR_API_KEY not set/);
  });

  it('does not retry a rejected key', async () => {
    const { provider: linear, calls } = provider([
      { status: 400, body: { errors: [{ message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } }] } },
    ]);
    await assert.rejects(linear.getIssue('ENG-142'), /rejected the API key/);
    assert.equal(calls.length, 1);
  });

  it('retries a dropped connection and a 5xx, then succeeds', async () => {
    const { provider: linear, calls } = provider([
      new TypeError('fetch failed'),
      { status: 503, body: {} },
      { body: { data: { issue: ISSUE } } },
    ]);
    assert.equal((await linear.getIssue('ENG-142')).title, 'Retry the flaky upload');
    assert.equal(calls.length, 3);
  });

  it('turns an unknown identifier into a not-found error with a hint', async () => {
    const { provider: linear } = provider([{ body: { errors: [{ message: 'Entity not found: Issue' }] } }]);
    await assert.rejects(linear.getIssue('ENG-999'), (error: RelayError) => error.code === 'ISSUE_NOT_FOUND');
  });

  it('lists open issues with their identifiers as the reference to run', async () => {
    const { provider: linear, calls } = provider(
      [{ body: { data: { issues: { nodes: [{ identifier: 'ENG-7', number: 7, title: 'Seven', url: 'u', createdAt: '2026-09-01T00:00:00Z', state: { name: 'Todo' }, labels: { nodes: [] } }] } } } }],
      { team: 'eng' },
    );
    const issues = await linear.listIssues({ labels: ['bug'], mine: true, limit: 5 });
    assert.deepEqual(issues.map((issue) => issue.ref), ['ENG-7']);
    const filter = JSON.stringify(calls[0]!.variables['filter']);
    assert.match(filter, /"nin":\["completed","canceled"\]/);
    assert.match(filter, /"key":\{"eq":"ENG"\}/);
    assert.match(filter, /"isMe":\{"eq":true\}/);
    assert.equal(calls[0]!.variables['first'], 5);
  });

  it('comments once per run, recognising its own earlier comment', async () => {
    const marker = '<!-- relay-run: run-42 -->';
    const first = provider([
      { body: { data: { issue: { id: 'uuid-1', url: 'u', comments: { nodes: [] } } } } },
      { body: { data: { commentCreate: { success: true, comment: { url: 'https://linear.app/c/1' } } } } },
    ]);
    assert.deepEqual(await first.provider.comment('ENG-142', `done\n\n${marker}`, { marker }), { url: 'https://linear.app/c/1', created: true });
    assert.equal(first.calls[1]!.variables['issueId'], 'uuid-1');

    // Linear stripped the HTML comment; the run id is still in the text.
    const again = provider([{ body: { data: { issue: { id: 'uuid-1', url: 'u', comments: { nodes: [{ body: 'done relay-run: run-42', url: 'https://linear.app/c/1' }] } } } } }]);
    assert.deepEqual(await again.provider.comment('ENG-142', 'done', { marker }), { url: 'https://linear.app/c/1', created: false });
    assert.equal(again.calls.length, 1);
  });

  it('never lets the key through the redaction patterns', () => {
    assert.doesNotMatch(redact(`request failed with ${KEY}`), /lin_api_/);
  });
});

describe('routing between trackers', () => {
  function router(issues?: { provider?: 'github' | 'linear'; team?: string | null }) {
    return new RoutingIssueProvider({ cwd: '/repo', defaultRepo: { owner: 'acme', name: 'widgets' }, ...(issues === undefined ? {} : { issues }) });
  }

  it('sends Linear-shaped references to Linear and everything else to GitHub by default', () => {
    const routes = router();
    assert.equal(routes.route('ENG-142'), 'linear');
    assert.equal(routes.route('https://linear.app/acme/issue/ENG-142/x'), 'linear');
    assert.equal(routes.route('142'), 'github');
    assert.equal(routes.route('acme/widgets#142'), 'github');
    assert.equal(routes.name, 'github');
  });

  it('gives bare numbers to Linear when the repository says so', () => {
    const routes = router({ provider: 'linear', team: 'ENG' });
    assert.equal(routes.route('142'), 'linear');
    assert.equal(routes.route('https://github.com/acme/widgets/issues/9'), 'github');
    assert.equal(routes.name, 'linear');
  });
});

describe('naming work after a Linear issue', () => {
  const issue = { number: null, key: 'ENG-142', title: 'Retry the flaky upload' };

  it('puts the identifier in the branch, where Linear looks for it', () => {
    assert.equal(issueIdentity(issue), 'eng-142');
    assert.equal(branchNameFor(issueIdentity(issue), 'x7f2q3'), 'relay/eng-142-x7f2q3');
  });

  it('names the issue the way Linear does', () => {
    assert.equal(issueHeadline(issue), 'ENG-142 Retry the flaky upload');
    assert.equal(issueTitle(issue), 'Retry the flaky upload (ENG-142)');
  });

  it('closes the issue from the pull request with Linear\'s magic word', () => {
    const state = createRunState({
      runId: 'run-1', shortId: 'x7f2q3', issueRef: 'ENG-142',
      repository: { root: '/repo', owner: 'acme', name: 'widgets', defaultBranch: 'main' },
      config: structuredClone(DEFAULT_CONFIG),
    });
    state.issue = { id: 'linear:ENG-142', number: null, key: 'ENG-142', title: issue.title, url: 'u', state: 'In Progress' };
    state.workspace = { path: '/w', branch: 'relay/eng-142-x7f2q3', baseSha: 'b'.repeat(40), baseRef: 'refs/heads/main', baseBranch: 'main' } as never;
    const draft = pullRequestDraft(state);
    assert.equal(draft.title, 'Retry the flaky upload (ENG-142)');
    assert.match(draft.body, /\nFixes ENG-142$/m);
    assert.doesNotMatch(draft.body, /Closes #/);

    state.pullRequest = { url: 'https://github.com/acme/widgets/pull/1', number: 1, base: 'main', head: 'h', createdByRun: true, at: 'now' };
    assert.deepEqual(issueLinkFor(state), { status: 'done', detail: 'fixes ENG-142' });
  });
});

describe('issues config', () => {
  it('defaults to GitHub with no team', () => {
    assert.deepEqual(DEFAULT_CONFIG.issues, { provider: 'github', team: null });
  });

  it('accepts Linear with a team, upper-casing the key', () => {
    assert.deepEqual(mergeConfig(DEFAULT_CONFIG, { issues: { provider: 'linear', team: 'eng' } }).issues, { provider: 'linear', team: 'ENG' });
  });

  it('rejects an unknown tracker and a malformed team', () => {
    assert.throws(() => mergeConfig(DEFAULT_CONFIG, { issues: { provider: 'jira' } }), RelayError);
    assert.throws(() => mergeConfig(DEFAULT_CONFIG, { issues: { team: 'not a team' } }), RelayError);
  });
});
