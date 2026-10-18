import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ApiError } from '@/server/errors';
import type { GitHubAppConfig } from '@/server/env';
import { refusal } from '@/server/github/client';
import { authorizeUrl, challengeOf, exchangeCode, installUrl, needsRefresh, refreshTokens, sameSecret } from '@/server/github/oauth';
import { listReachable, reachableRepository } from '@/server/github/repositories';
import { checkSetupFiles, openSetupPullRequest, pullRequestState, RELAY_IGNORE_ENTRIES, setupBranch, withRelayIgnored } from '@/server/github/setup-pr';
import { FakeGitHub } from './helpers/fake-github';

const fake = new FakeGitHub();
let config: GitHubAppConfig;

before(async () => {
  const url = await fake.start();
  config = { clientId: 'Iv1.fakeclient', clientSecret: 'fake-secret', slug: 'relay-test', api: url, web: url };
});
after(() => fake.stop());

const CONFIG_FILE = { path: '.relay/config.json', content: '{\n  "version": 1\n}\n' };
const GRAPH_FILE = { path: '.relay/workflows/issue-to-pr.json', content: '{"nodes":[]}\n' };
const ACTION_FILE = { path: '.github/workflows/issue-to-pr.yml', content: 'name: Relay\non: issues\n' };
const FILES = [CONFIG_FILE, GRAPH_FILE, ACTION_FILE];

async function refused(promise: Promise<unknown>, code: string): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected an ApiError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`expected ${code}`);
}

describe('the files a setup pull request may carry', () => {
  test('takes Relay’s own paths', () => {
    assert.deepEqual(checkSetupFiles(FILES), FILES);
    assert.doesNotThrow(() => checkSetupFiles([{ path: '.github/workflows/fix.yaml', content: '' }, { path: '.relay/rules.md', content: '' }]));
  });

  test('refuses anything else in the repository', () => {
    for (const path of ['README.md', '.github/CODEOWNERS', '.github/workflows/../../src/index.ts', '.relay/../package.json', '.relay/workflows/sub/dir.json', '.gitignore', '/etc/passwd', '.relay/config.json/', '.github/workflows/.hidden.yml']) {
      assert.throws(() => checkSetupFiles([{ path, content: '' }]), (error: unknown) => error instanceof ApiError && error.code === 'PATH_NOT_ALLOWED', path);
    }
  });

  test('refuses none, too many, twice the same, and too large', () => {
    assert.throws(() => checkSetupFiles([]), /nothing to put/);
    assert.throws(() => checkSetupFiles(Array.from({ length: 9 }, (_, index) => ({ path: `.relay/workflows/w${index}.json`, content: '' }))), /at most 8/);
    assert.throws(() => checkSetupFiles([CONFIG_FILE, CONFIG_FILE]), /twice/);
    assert.throws(() => checkSetupFiles([{ path: '.relay/config.json', content: 'x'.repeat(256_001) }]), /larger than/);
  });
});

describe('.gitignore', () => {
  test('is the CLI’s list, so `relay init` afterwards adds nothing', () => {
    const cli = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli', 'onboarding.ts'), 'utf8');
    const block = /export const RELAY_IGNORE_ENTRIES = \[([\s\S]*?)\] as const;/.exec(cli);
    assert.ok(block !== null, 'RELAY_IGNORE_ENTRIES is no longer in src/cli/onboarding.ts');
    const entries = [...block[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual([...RELAY_IGNORE_ENTRIES], entries);
  });

  test('gets the block added once, after what is there', () => {
    const made = withRelayIgnored(null)!;
    assert.match(made, /^# Relay state/);
    for (const entry of RELAY_IGNORE_ENTRIES) assert.ok(made.split('\n').includes(entry));
    assert.equal(withRelayIgnored(made), null);
    assert.equal(withRelayIgnored('node_modules/'), `node_modules/\n\n${made}`);
    assert.equal(withRelayIgnored('node_modules/\n'), `node_modules/\n\n${made}`);
  });

  test('only gets the lines it is missing', () => {
    const partial = withRelayIgnored('.relay/runs/\n.relay/STOP\n')!;
    assert.equal(partial.split('\n').filter((line) => line === '.relay/runs/').length, 1);
    assert.ok(partial.includes('.relay/approvals/'));
  });
});

describe('signing in to the app', () => {
  test('sends GitHub a state and a PKCE challenge', () => {
    const url = new URL(authorizeUrl(config, { state: 'st4te', redirectUri: 'https://studio.example/api/github/callback', challenge: challengeOf('verifier') }));
    assert.equal(url.pathname, '/login/oauth/authorize');
    assert.equal(url.searchParams.get('client_id'), 'Iv1.fakeclient');
    assert.equal(url.searchParams.get('state'), 'st4te');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    // RFC 7636's example verifier and challenge.
    assert.equal(challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    assert.equal(installUrl(config), `${config.web}/apps/relay-test/installations/new`);
  });

  test('compares states without a shortcut, and an empty one never matches', () => {
    assert.equal(sameSecret('abc', 'abc'), true);
    assert.equal(sameSecret('abc', 'abd'), false);
    assert.equal(sameSecret('abc', 'abcd'), false);
    assert.equal(sameSecret('', ''), false);
  });

  test('exchanges a code with its verifier, and keeps when it expires', async () => {
    fake.codes.set('code-1', 'the-verifier');
    const tokens = await exchangeCode(config, { code: 'code-1', redirectUri: 'https://studio.example/api/github/callback', verifier: 'the-verifier' }, 1_000);
    assert.equal(tokens.accessToken, fake.token);
    assert.equal(tokens.expiresAt, 1_000 + 28_800_000);
    assert.ok(tokens.refreshToken?.startsWith('ghr_'));
    const sent = fake.log.findLast((entry) => entry.path === '/login/oauth/access_token')!.body as Record<string, string>;
    assert.equal(sent['code_verifier'], 'the-verifier');
    assert.equal(sent['client_secret'], 'fake-secret');
  });

  test('says to connect again when GitHub refuses the code', async () => {
    fake.codes.set('code-2', 'right');
    await refused(exchangeCode(config, { code: 'code-2', redirectUri: 'x', verifier: 'wrong' }), 'GITHUB_RECONNECT');
    await refused(exchangeCode(config, { code: 'never-issued', redirectUri: 'x', verifier: 'right' }), 'GITHUB_RECONNECT');
  });

  test('renews a token near its eight hours, with the refresh token, once', async () => {
    assert.equal(needsRefresh({ accessToken: 't', expiresAt: 10 * 60_000, refreshToken: null, refreshExpiresAt: null }, 0), false);
    assert.equal(needsRefresh({ accessToken: 't', expiresAt: 4 * 60_000, refreshToken: null, refreshExpiresAt: null }, 0), true);
    assert.equal(needsRefresh({ accessToken: 't', expiresAt: null, refreshToken: null, refreshExpiresAt: null }, 0), false);
    fake.codes.set('code-3', 'v');
    const first = await exchangeCode(config, { code: 'code-3', redirectUri: 'x', verifier: 'v' });
    const renewed = await refreshTokens(config, first.refreshToken!);
    assert.notEqual(renewed.accessToken, first.accessToken);
    assert.equal(renewed.accessToken, fake.token);
    await refused(refreshTokens(config, first.refreshToken!), 'GITHUB_RECONNECT');
  });
});

describe('what the token reaches', () => {
  beforeEach(() => {
    fake.repos.clear();
    fake.addRepo({ fullName: 'ada/app', pushedAt: '2026-10-10T00:00:00Z' });
    fake.addRepo({ fullName: 'ada/old', pushedAt: '2026-01-01T00:00:00Z', private: false });
    fake.addRepo({ fullName: 'acme/api', ownerType: 'Organization', push: false, pushedAt: '2026-10-12T00:00:00Z' });
    for (let index = 0; index < 120; index += 1) fake.addRepo({ fullName: `acme/svc-${index}`, ownerType: 'Organization', pushedAt: '2025-06-01T00:00:00Z' });
    fake.installations = [
      { id: 1, account: 'ada', type: 'User', repos: ['ada/app', 'ada/old'] },
      { id: 2, account: 'acme', type: 'Organization', repos: ['acme/api', ...Array.from({ length: 120 }, (_, index) => `acme/svc-${index}`), 'ada/app'] },
    ];
  });

  test('lists every installation’s repositories across pages, once each, newest first', async () => {
    const status = await listReachable(config, fake.token, 'ada');
    assert.equal(status.connected, true);
    assert.equal(status.repositories.length, 123);
    assert.deepEqual(
      status.repositories.slice(0, 3).map((repo) => repo.repository),
      ['acme/api', 'ada/app', 'ada/old'],
    );
    assert.deepEqual(status.installations, [
      { account: 'ada', type: 'User' },
      { account: 'acme', type: 'Organization' },
    ]);
    const api = status.repositories.find((repo) => repo.repository === 'acme/api')!;
    assert.equal(api.canPush, false);
    assert.equal(api.ownerIsUser, false);
    assert.equal(status.repositories.find((repo) => repo.repository === 'ada/old')!.private, false);
    assert.equal(status.truncated, false);
  });

  test('is nothing before the app is installed', async () => {
    fake.installations = [];
    const status = await listReachable(config, fake.token, 'ada');
    assert.deepEqual(status.repositories, []);
    assert.deepEqual(status.installations, []);
  });

  test('does not include a repository the app is not installed on, even the person’s own', async () => {
    fake.addRepo({ fullName: 'ada/secret', reachable: false });
    await refused(reachableRepository(config, fake.token, 'ada/secret'), 'GITHUB_NOT_FOUND');
  });

  test('says to connect again when GitHub no longer takes the token', async () => {
    await refused(listReachable(config, 'ghu_revoked', 'ada'), 'GITHUB_RECONNECT');
  });
});

describe('the setup pull request', () => {
  beforeEach(() => {
    fake.repos.clear();
    fake.addRepo({ fullName: 'ada/app', files: { 'README.md': '# app\n', '.gitignore': 'node_modules/\n' }, labels: 'make' });
  });

  const open = (overrides: Partial<Parameters<typeof openSetupPullRequest>[2]> = {}) =>
    openSetupPullRequest(config, fake.token, { repository: 'ada/app', name: 'Issue to PR', files: FILES, label: 'relay:go', secrets: ['CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_AUTH_JSON', 'not a secret name'], ...overrides });

  test('commits the files and the .gitignore lines to Relay’s branch, and opens it against main', async () => {
    const result = await open();
    assert.equal(result.state, 'opened');
    assert.equal(result.branch, 'relay/setup-issue-to-pr');
    assert.equal(result.defaultBranch, 'main');
    assert.equal(result.number, 101);
    assert.equal(result.url, 'https://github.com/ada/app/pull/101');
    assert.equal(result.label, 'created');
    assert.deepEqual(result.files, [
      { path: '.relay/config.json', status: 'added' },
      { path: '.relay/workflows/issue-to-pr.json', status: 'added' },
      { path: '.github/workflows/issue-to-pr.yml', status: 'added' },
      { path: '.gitignore', status: 'changed' },
    ]);

    const onBranch = fake.filesOn('ada/app', 'relay/setup-issue-to-pr')!;
    assert.equal(onBranch['.relay/config.json'], CONFIG_FILE.content);
    assert.equal(onBranch['.github/workflows/issue-to-pr.yml'], ACTION_FILE.content);
    assert.equal(onBranch['README.md'], '# app\n', 'the rest of the repository is kept');
    assert.ok(onBranch['.gitignore']!.startsWith('node_modules/\n\n# Relay state'));
    // Nothing reaches the default branch until somebody merges.
    assert.equal(fake.filesOn('ada/app', 'main')!['.relay/config.json'], undefined);

    const pull = fake.pullsOf('ada/app')[0]!;
    assert.equal(pull.title, 'Set up Relay: Issue to PR');
    assert.equal(pull.base, 'main');
    assert.match(pull.body, /`CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_AUTH_JSON`/);
    assert.doesNotMatch(pull.body, /not a secret name/);
    assert.match(pull.body, /label `relay:go`/);
    assert.match(pull.body, /\| `\.gitignore` \| changed \|/);
  });

  test('opened again with nothing new, leaves the branch alone and keeps the same pull request', async () => {
    await open();
    const tip = fake.refs.get('ada/app')!.get('relay/setup-issue-to-pr');
    const again = await open();
    assert.equal(again.state, 'updated');
    assert.equal(again.number, 101);
    assert.equal(fake.refs.get('ada/app')!.get('relay/setup-issue-to-pr'), tip);
    assert.equal(fake.pullsOf('ada/app').length, 1);
    assert.equal(again.label, 'exists');
  });

  test('opened again after main moved on, rebuilds the branch on the new main', async () => {
    await open();
    const moved = fake.push('ada/app', { 'src/new.ts': 'export {};\n' });
    const changed = { ...ACTION_FILE, content: 'name: Relay\non: [issues, workflow_dispatch]\n' };
    const again = await open({ files: [CONFIG_FILE, GRAPH_FILE, changed] });
    assert.equal(again.state, 'updated');
    const tip = fake.commits.get(fake.refs.get('ada/app')!.get('relay/setup-issue-to-pr')!)!;
    assert.deepEqual(tip.parents, [moved]);
    const onBranch = fake.filesOn('ada/app', 'relay/setup-issue-to-pr')!;
    assert.equal(onBranch['src/new.ts'], 'export {};\n');
    assert.equal(onBranch['.github/workflows/issue-to-pr.yml'], changed.content);
  });

  test('opens nothing when the default branch already has every file', async () => {
    const ignore = withRelayIgnored('node_modules/\n')!;
    fake.push('ada/app', { [CONFIG_FILE.path]: CONFIG_FILE.content, [GRAPH_FILE.path]: GRAPH_FILE.content, [ACTION_FILE.path]: ACTION_FILE.content, '.gitignore': ignore });
    const result = await open();
    assert.equal(result.state, 'up-to-date');
    assert.ok(result.files.every((file) => file.status === 'unchanged'));
    assert.equal(fake.pullsOf('ada/app').length, 0);
    assert.equal(fake.refs.get('ada/app')!.has('relay/setup-issue-to-pr'), false);
  });

  test('says which files it changes, and adds a .gitignore where there is none', async () => {
    fake.repos.clear();
    fake.addRepo({ fullName: 'ada/app', files: { '.relay/config.json': '{}\n' }, labels: 'make' });
    const result = await open();
    assert.notEqual(result.state, 'up-to-date');
    assert.deepEqual(
      result.files.map((file) => `${file.path}:${file.status}`),
      ['.relay/config.json:changed', '.relay/workflows/issue-to-pr.json:added', '.github/workflows/issue-to-pr.yml:added', '.gitignore:added'],
    );
    assert.ok(fake.filesOn('ada/app', 'relay/setup-issue-to-pr')!['.gitignore']!.startsWith('# Relay state'));
  });

  test('still opens the pull request when the app may not make labels', async () => {
    fake.repos.get('ada/app')!.labels = 'forbidden';
    const result = await open();
    assert.equal(result.state, 'opened');
    assert.equal(result.label, 'skipped');
    const none = await open({ label: undefined, name: 'Other' });
    if (none.state !== 'up-to-date') assert.equal(none.label, 'none');
  });

  test('keeps two workflows’ pull requests apart', async () => {
    await open();
    const other = await open({ name: 'Fix CI', files: [{ ...CONFIG_FILE, content: '{"version":2}\n' }] });
    assert.notEqual(other.state, 'up-to-date');
    if (other.state === 'up-to-date') return;
    assert.equal(other.branch, setupBranch('Fix CI'));
    assert.equal(fake.pullsOf('ada/app').length, 2);
  });

  test('refuses a repository the person cannot push to, an archived one, and one the app does not reach', async () => {
    fake.addRepo({ fullName: 'acme/api', push: false });
    fake.addRepo({ fullName: 'ada/archived', archived: true });
    fake.addRepo({ fullName: 'ada/hidden', reachable: false });
    await refused(open({ repository: 'acme/api' }), 'NO_PUSH');
    await refused(open({ repository: 'ada/archived' }), 'ARCHIVED');
    await refused(open({ repository: 'ada/hidden' }), 'GITHUB_NOT_FOUND');
    assert.equal(fake.pullsOf('acme/api').length, 0);
  });

  test('will not write over a directory where a file goes', async () => {
    fake.push('ada/app', { '.relay/config.json/inner': 'x' });
    await refused(open(), 'PATH_TAKEN');
  });

  test('refuses a path outside Relay’s before asking GitHub anything', async () => {
    const before = fake.log.length;
    await refused(open({ files: [{ path: 'src/index.ts', content: 'evil' }] }), 'PATH_NOT_ALLOWED');
    assert.equal(fake.log.length, before);
  });

  test('reads whether it was merged', async () => {
    const result = await open();
    if (result.state === 'up-to-date') return assert.fail();
    assert.equal((await pullRequestState(config, fake.token, 'ada/app', result.number)).state, 'open');
    fake.pullsOf('ada/app')[0]!.merged = true;
    fake.pullsOf('ada/app')[0]!.state = 'closed';
    assert.deepEqual(await pullRequestState(config, fake.token, 'ada/app', result.number), { number: result.number, url: result.url, state: 'merged' });
  });
});

describe('GitHub’s refusals, as the studio says them', () => {
  const answer = (status: number, headers: Record<string, string> = {}, data: unknown = { message: 'Resource not accessible by integration' }) => ({ status, data, headers: new Headers(headers) });

  test('a token GitHub no longer takes means connecting again', () => {
    assert.equal(refusal(answer(401), 'list').code, 'GITHUB_RECONNECT');
  });

  test('a spent hourly limit is a rate limit with a retry time, not a permission problem', () => {
    const limited = refusal(answer(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 120) }), 'list');
    assert.equal(limited.status, 429);
    assert.ok((limited.data?.['retryAfter'] as number) > 60);
    const forbidden = refusal(answer(403), 'open the pull request');
    assert.equal(forbidden.code, 'GITHUB_FORBIDDEN');
    assert.match(forbidden.message, /open the pull request: Resource not accessible by integration/);
  });

  test('anything unexpected says which step and what GitHub answered', () => {
    assert.match(refusal(answer(500, {}, null), 'commit the files').message, /could not commit the files \(it answered 500\)/);
  });
});
