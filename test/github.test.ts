import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseIssueRef, normalizeGhIssue, GitHubIssueProvider } from '../src/github/provider.ts';
import { renderIssueMarkdown } from '../src/github/types.ts';
import { parseRemoteUrl } from '../src/git/repository.ts';
import { RelayError } from '../src/util/errors.ts';
import { pullRequestNumber } from '../src/github/pullRequest.ts';
import { pullRequestDraft } from '../src/workflow/publishRun.ts';
import { DEFAULT_CONFIG } from '../src/storage/config.ts';
import { createRunState, type RunState } from '../src/workflow/state.ts';
import { recordTurnUsage } from '../src/workflow/usage.ts';

describe('issue reference parsing', () => {
  it('accepts a bare number, a hash number, and owner/repo#number', () => {
    assert.deepEqual(parseIssueRef('142'), { number: 142 });
    assert.deepEqual(parseIssueRef('#142'), { number: 142 });
    assert.deepEqual(parseIssueRef('acme/widgets#142'), { number: 142, owner: 'acme', repo: 'widgets' });
  });

  it('accepts a full issue URL', () => {
    assert.deepEqual(parseIssueRef('https://github.com/acme/widgets/issues/142'), {
      number: 142,
      owner: 'acme',
      repo: 'widgets',
    });
  });

  it('rejects a pull request URL explicitly', () => {
    assert.throws(
      () => parseIssueRef('https://github.com/acme/widgets/pull/9'),
      (error: unknown) => error instanceof RelayError && /pull request/.test(error.message),
    );
  });

  it('rejects nonsense instead of guessing', () => {
    assert.throws(() => parseIssueRef('not-an-issue'), RelayError);
    assert.throws(() => parseIssueRef(''), RelayError);
  });
});

describe('gh command construction', () => {
  const provider = new GitHubIssueProvider({ cwd: '/tmp', defaultRepo: { owner: 'acme', name: 'widgets' } });

  it('requests exactly the fields Relay uses', () => {
    const args = provider.buildArgs({ number: 142 });
    assert.deepEqual(args.slice(0, 3), ['issue', 'view', '142']);
    const fields = args[args.indexOf('--json') + 1] ?? '';
    for (const field of ['number', 'title', 'body', 'url', 'state', 'author', 'labels', 'comments']) {
      assert.ok(fields.includes(field), `missing field ${field}`);
    }
  });

  it('scopes to the repository derived from the git remote', () => {
    assert.equal(provider.buildArgs({ number: 1 })[provider.buildArgs({ number: 1 }).indexOf('--repo') + 1], 'acme/widgets');
  });

  it('prefers an explicit owner/repo from the reference', () => {
    const args = provider.buildArgs({ number: 1, owner: 'other', repo: 'thing' });
    assert.equal(args[args.indexOf('--repo') + 1], 'other/thing');
  });

  it('omits --repo entirely when nothing identifies a repository', () => {
    const bare = new GitHubIssueProvider({ cwd: '/tmp' });
    assert.ok(!bare.buildArgs({ number: 1 }).includes('--repo'));
  });

  it('constructs filtered open issue list arguments', () => {
    const args = provider.buildListArgs({ labels: ['ready', 'ui'], mine: true, limit: 17 });
    assert.deepEqual(args.slice(0, 2), ['issue', 'list']);
    assert.equal(args[args.indexOf('--state') + 1], 'open');
    assert.equal(args[args.indexOf('--limit') + 1], '17');
    assert.equal(args[args.indexOf('--assignee') + 1], '@me');
    assert.deepEqual(args.filter((arg) => arg === '--label'), ['--label', '--label']);
    assert.equal(args[args.indexOf('--repo') + 1], 'acme/widgets');
  });
});

describe('issue normalization', () => {
  it('maps a full gh payload', () => {
    const issue = normalizeGhIssue(
      {
        number: 142,
        title: 'Add rate limiting',
        body: 'Details here',
        url: 'https://github.com/acme/widgets/issues/142',
        state: 'OPEN',
        author: { login: 'someone' },
        labels: [{ name: 'bug' }, { name: 'security' }],
        comments: [{ author: { login: 'other' }, createdAt: '2026-01-01T00:00:00Z', body: 'a comment' }],
      },
      { number: 142 },
    );

    assert.equal(issue.number, 142);
    assert.equal(issue.state, 'open');
    assert.deepEqual(issue.labels, ['bug', 'security']);
    assert.deepEqual(issue.repository, { owner: 'acme', name: 'widgets' });
    assert.equal(issue.comments.length, 1);
    assert.equal(issue.id, 'github:acme/widgets#142');
  });

  it('tolerates missing optional fields', () => {
    const issue = normalizeGhIssue({ number: 7, title: 'Bare' }, { number: 7, owner: 'acme', name: 'widgets' });
    assert.equal(issue.body, '');
    assert.deepEqual(issue.labels, []);
    assert.deepEqual(issue.comments, []);
    assert.equal(issue.author, null);
  });

  it('rejects a non-object payload', () => {
    assert.throws(() => normalizeGhIssue('nope', { number: 1 }), RelayError);
  });

  it('renders markdown including comments', () => {
    const markdown = renderIssueMarkdown(
      normalizeGhIssue(
        {
          number: 1,
          title: 'T',
          body: 'B',
          url: 'https://github.com/a/b/issues/1',
          comments: [{ author: { login: 'x' }, createdAt: 'now', body: 'C' }],
        },
        { number: 1 },
      ),
    );

    assert.match(markdown, /# Issue #1: T/);
    assert.match(markdown, /## Description/);
    assert.match(markdown, /## Comments \(1\)/);
    assert.match(markdown, /C/);
  });

  it('notes when an issue has no description', () => {
    const markdown = renderIssueMarkdown(normalizeGhIssue({ number: 1, title: 'T', body: '' }, { number: 1 }));
    assert.match(markdown, /_No description provided\._/);
  });
});

describe('git remote parsing', () => {
  it('handles ssh, https and .git suffixes', () => {
    assert.deepEqual(parseRemoteUrl('git@github.com:acme/widgets.git'), {
      host: 'github.com',
      owner: 'acme',
      name: 'widgets',
    });
    assert.deepEqual(parseRemoteUrl('https://github.com/acme/widgets'), {
      host: 'github.com',
      owner: 'acme',
      name: 'widgets',
    });
    assert.deepEqual(parseRemoteUrl('ssh://git@github.com/acme/widgets.git'), {
      host: 'github.com',
      owner: 'acme',
      name: 'widgets',
    });
  });

  it('returns null for something that is not a remote URL', () => {
    assert.equal(parseRemoteUrl('not a url'), null);
  });
});

describe('pull request drafts', () => {
  /** A finished run with everything the body reports. */
  function run(): RunState {
    const state = createRunState({
      runId: '20260812T203625-bg6pcf',
      shortId: 'bg6pcf',
      issueRef: '13',
      repository: { root: '/repo', owner: 'acme', name: 'widgets', defaultBranch: 'main' },
      config: structuredClone(DEFAULT_CONFIG),
      now: new Date('2026-08-12T10:00:00Z'),
    });
    state.issue = { number: 13, title: 'Give the CLI a framed interface', url: 'https://x/13', state: 'open' };
    state.workspace = {
      path: '/worktree',
      branch: 'relay/13-ce2ubs',
      baseSha: 'b'.repeat(40),
      baseRef: 'refs/heads/main',
      baseBranch: 'main',
    };
    state.diff = { fileCount: 3, additions: 40, deletions: 7, files: [], patchFile: 'p', at: '2026-08-12T10:05:00Z' };
    state.rounds = { planReview: 2, codeReview: 1 };
    state.planApproved = true;
    state.tests = {
      discovered: true,
      command: ['npm', 'test'],
      reason: 'package.json',
      exitCode: 0,
      passed: true,
      durationMs: 12_000,
      timedOut: false,
      at: '2026-08-12T10:04:00Z',
    };
    return state;
  }

  it('describes the run from its own evidence, and closes the issue', () => {
    const draft = pullRequestDraft(run());

    assert.equal(draft.title, 'Give the CLI a framed interface (#13)');
    assert.equal(draft.base, 'main');
    assert.equal(draft.head, 'relay/13-ce2ubs');
    assert.equal(draft.repo, 'acme/widgets');
    assert.match(draft.body, /Plan review: 2 round\(s\), plan approved/);
    assert.match(draft.body, /Code review: 1 round\(s\) by claude/);
    assert.match(draft.body, /Changes: 3 file\(s\), \+40 −7/);
    assert.match(draft.body, /Tests: `npm test` passed/);
    assert.match(draft.body, /Closes #13/);
  });

  it('carries what the run consumed, which is the honest footer on machine-made work', () => {
    const state = run();
    state.usage = recordTurnUsage(undefined, 'IMPLEMENTING', {
      inputTokens: 24_000,
      outputTokens: 8000,
      costUsd: 1.24,
    });

    assert.match(pullRequestDraft(state).body, /- Cost: 24\.0k in \/ 8\.0k out · \$1\.24 · 1 turn/);
  });

  it('says when part of that cost was never reported, rather than passing a floor off as the bill', () => {
    const state = run();
    let usage = recordTurnUsage(undefined, 'PLANNING', { inputTokens: 1000, outputTokens: 100, costUsd: 0.5 });
    usage = recordTurnUsage(usage, 'IMPLEMENTING', { inputTokens: 9000, outputTokens: 900 });
    state.usage = usage;

    assert.match(pullRequestDraft(state).body, /1 turn\(s\) reported no price, so this is a floor/);
  });

  it('leaves the cost line out of a run nothing was recorded for', () => {
    assert.doesNotMatch(pullRequestDraft(run()).body, /- Cost:/);
  });

  it('says a test suite failed rather than leaving it out', () => {
    const state = run();
    state.tests = { ...state.tests!, passed: false, exitCode: 1 };

    assert.match(pullRequestDraft(state).body, /Tests: `npm test` FAILED \(exit 1\)/);
  });

  it('includes the approved plan and review resolutions', () => {
    const state = run();
    state.diff!.files = ['src/a.ts | +4 -1'];
    state.reviews.push({
      round: 1, kind: 'code', reviewer: 'claude', decision: 'request_changes', at: 'x',
      findings: [{ id: 'F1', severity: 'high', category: 'correctness', summary: '<script>bad</script>', impact: 'BLOCKING' }],
      responses: [{ findingId: 'F1', response: 'ACCEPT', reasoning: 'fixed safely' }],
    });
    const body = pullRequestDraft(state, '# Approved\nDo the thing.').body;
    assert.match(body, /### Approved plan/);
    assert.match(body, /Review findings & resolutions/);
    assert.match(body, /Resolution: ACCEPT/);
    assert.match(body, /src\/a\.ts \| \+4 -1/);
  });

  it('says plainly when no second model read the diff', () => {
    const state = run();
    state.config.workflow.reviewCode = false;
    state.rounds.codeReview = 0;

    const body = pullRequestDraft(state).body;
    assert.match(body, /Code review: \*\*none\*\*/);
    assert.doesNotMatch(body, /Code review: 0 round/);
  });

  it('writes the pull request with typos under --tuff, without breaking anything parsed', () => {
    const state = run();
    state.config.workflow.typos = true;

    const draft = pullRequestDraft(state, '# Approved\nDo the thing.');
    const plain = pullRequestDraft(run(), '# Approved\nDo the thing.');

    assert.notEqual(draft.body, plain.body);
    // The parts GitHub and git read are the parts that must survive verbatim.
    assert.match(draft.body, /Closes #13/);
    assert.match(draft.body, /`npm test`/);
    assert.equal(draft.base, 'main');
    assert.equal(draft.head, 'relay/13-ce2ubs');

    // Deterministic: `relay deliver` re-runs this for the same run.
    assert.equal(pullRequestDraft(state, '# Approved\nDo the thing.').body, draft.body);
  });

  it('reads the number out of the URL gh reports', () => {
    assert.equal(pullRequestNumber('https://github.com/acme/widgets/pull/21'), 21);
    assert.equal(pullRequestNumber('https://github.com/acme/widgets'), null);
  });
});
