import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseIssueRef, normalizeGhIssue, GitHubIssueProvider } from '../src/github/provider.ts';
import { renderIssueMarkdown } from '../src/github/types.ts';
import { parseRemoteUrl } from '../src/git/repository.ts';
import { RelayError } from '../src/util/errors.ts';

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
