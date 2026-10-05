import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CODEX_PLAN_ENV, CodexHarness, buildCodexArgs, codexPlanArgs, explainPlanFailure, CODEX_EXEC_ONLY_FLAGS } from '../src/agents/codex.ts';
import type { AgentSession } from '../src/agents/types.ts';
import {
  beginChatgptSignIn,
  chatgptPath,
  chatgptPlanAccess,
  chatgptSignOut,
  chatgptStatus,
  ChatgptSessionError,
  ChatgptSignInError,
  ChatgptUnavailableError,
  CHATGPT_USAGE_URL,
  PLAN_SCOPE,
  type ChatgptDeps,
  type PendingSignIn,
  type SignInResult,
} from '../src/auth/chatgpt.ts';
import { chatgptLoginCommand, chatgptLogoutCommand, chatgptStatusCommand } from '../src/cli/commands/chatgpt.ts';
import { EXIT } from '../src/cli/exit.ts';
import { logout, LoginSessions } from '../src/studio/agents.ts';
import { createRouter } from '../src/studio/router.ts';
import { classifyFailure } from '../src/workflow/retry.ts';

/**
 * Sign in with ChatGPT, end to end against a stand-in for OpenAI.
 *
 * The stand-in serves what the real issuer does — the discovery document, its
 * signing keys, the token endpoint and the revocation endpoint — and the tests
 * play the browser: they follow Relay's link to the authorization address,
 * read what Relay asked for, and come back to the loopback callback the way
 * OpenAI's page would. Nothing here reaches the network or the real `~/.relay`.
 */

const FULL_SCOPE = `${PLAN_SCOPE} email offline_access openid profile resource.invoke`;
const IDENTITY_SCOPE = 'email offline_access openid profile';

interface TokenRequest {
  path: string;
  form: Record<string, string>;
}

interface FakeOpenAI {
  deps: Partial<ChatgptDeps>;
  home: string;
  requests: TokenRequest[];
  /** What the token endpoint answers next. Replaced per test. */
  token: (form: Record<string, string>) => { status: number; body: unknown };
  revoke: (form: Record<string, string>) => { status: number };
  /** What the discovery document and the keys answer with. OpenAI's own return a 502 now and then. */
  discoveryStatus: number;
  keysStatus: () => number;
  clock: { now: number };
  slept: number[];
  idToken(claims: Record<string, unknown>, key?: KeyObject): string;
  tokens(options: { nonce?: string; clientId?: string; subject?: string; email?: string; scope?: string; extra?: Record<string, unknown> }): unknown;
  close(): Promise<void>;
}

async function fakeOpenAI(): Promise<FakeOpenAI> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const home = await realpath(await mkdtemp(join(tmpdir(), 'relay-chatgpt-test-')));
  const requests: TokenRequest[] = [];
  const clock = { now: Date.parse('2026-10-01T12:00:00.000Z') };
  const slept: number[] = [];
  let issued = 0;

  const server: Server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const json = (status: number, body: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(body === undefined ? '' : JSON.stringify(body));
      };
      const form = Object.fromEntries(new URLSearchParams(raw));
      if (request.url === '/.well-known/openid-configuration') {
        return fake.discoveryStatus === 200 ? json(200, { issuer: base, jwks_uri: `${base}/jwks`, revocation_endpoint: `${base}/revoke` }) : json(fake.discoveryStatus, { error: { type: 'cf_bad_gateway' } });
      }
      if (request.url === '/jwks') {
        const status = fake.keysStatus();
        return status === 200 ? json(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'key-1', alg: 'RS256', use: 'sig' }] }) : json(status, {});
      }
      if (request.url === '/token' || request.url === '/revoke') {
        requests.push({ path: request.url, form });
        if (request.url === '/revoke') return json(fake.revoke(form).status, undefined);
        const answer = fake.token(form);
        return json(answer.status, answer.body);
      }
      json(404, { error: 'not_found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const base = `http://127.0.0.1:${address !== null && typeof address === 'object' ? address.port : 0}`;

  const fake: FakeOpenAI = {
    home,
    requests,
    clock,
    slept,
    deps: {
      home,
      endpoints: { issuer: base, authorize: `${base}/authorize`, token: `${base}/token`, jwks: `${base}/jwks`, revocation: `${base}/revoke`, discovery: `${base}/.well-known/openid-configuration`, resource: 'https://api.openai.test/v1' },
      now: () => clock.now,
      sleep: async (ms) => void slept.push(ms),
    },
    token: () => ({ status: 500, body: {} }),
    revoke: () => ({ status: 200 }),
    discoveryStatus: 200,
    keysStatus: () => 200,
    idToken(claims, key = privateKey) {
      const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'key-1', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      return `${head}.${payload}.${sign('sha256', Buffer.from(`${head}.${payload}`), key).toString('base64url')}`;
    },
    tokens({ nonce = 'unused', clientId = 'oaiapp_relay1', subject = 'user-1', email = 'ada@example.com', scope = FULL_SCOPE, extra = {} }) {
      issued += 1;
      return {
        access_token: `access-${issued}`,
        refresh_token: `refresh-${issued}`,
        id_token: fake.idToken({ iss: base, aud: clientId, sub: subject, email, nonce, exp: Math.floor(clock.now / 1000) + 600 }),
        token_type: 'Bearer',
        expires_in: 3600,
        scope,
        ...extra,
      };
    },
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await rm(home, { recursive: true, force: true });
    },
  };
  return fake;
}

/** The browser's first hop: Relay's loopback link, which redirects to OpenAI's authorization address. */
async function authorizeRequest(pending: PendingSignIn): Promise<URL> {
  const response = await fetch(pending.url, { redirect: 'manual' });
  assert.equal(response.status, 302);
  return new URL(response.headers.get('location') ?? '');
}

/** The browser's last hop: back to the loopback callback, as OpenAI's page would send it. */
async function comeBack(authorize: URL, params: Record<string, string>): Promise<Response> {
  const callback = new URL(authorize.searchParams.get('redirect_uri') ?? '');
  for (const [key, value] of Object.entries(params)) callback.searchParams.set(key, value);
  return fetch(callback);
}

/** A whole successful sign-in, for the tests that are about what comes after one. */
async function signIn(openai: FakeOpenAI, options: { account?: 'saved' | 'new'; clientId?: string; subject?: string; scope?: string; extra?: Record<string, unknown> } = {}): Promise<{ result: SignInResult; authorize: URL }> {
  const pending = await beginChatgptSignIn({ deps: openai.deps, ...(options.account === undefined ? {} : { account: options.account }) });
  const authorize = await authorizeRequest(pending);
  const clientId = options.clientId ?? 'oaiapp_relay1';
  openai.token = () => ({
    status: 200,
    body: openai.tokens({ nonce: authorize.searchParams.get('nonce') ?? '', clientId, ...(options.subject === undefined ? {} : { subject: options.subject }), ...(options.scope === undefined ? {} : { scope: options.scope }), ...(options.extra === undefined ? {} : { extra: options.extra }) }),
  });
  await comeBack(authorize, { code: 'auth-code', state: authorize.searchParams.get('state') ?? '', client_id: clientId });
  return { result: await pending.result, authorize };
}

async function saved(openai: FakeOpenAI): Promise<{ hostId: string; active: string | null; accounts: Array<Record<string, any>> }> {
  return JSON.parse(await readFile(chatgptPath(openai.home), 'utf8'));
}

function failedTurn(error: string): AgentSession {
  return { provider: 'codex', role: 'implementer', ok: false, text: '', events: [], error, exitCode: 1, durationMs: 1, timedOut: false, aborted: false, invocation: { command: 'codex', args: [] } };
}

let openai: FakeOpenAI;
beforeEach(async () => {
  openai = await fakeOpenAI();
});
afterEach(async () => {
  await openai.close();
});

describe('Sign in with ChatGPT: a first sign-in', () => {
  it('registers Relay, proves the code is its own, and saves an owner-only credential', async () => {
    const pending = await beginChatgptSignIn({ deps: openai.deps });
    const link = new URL(pending.url);
    assert.equal(link.hostname, '127.0.0.1');
    assert.ok(!pending.url.includes('id_token_hint'), 'the link Relay shows names nobody');

    const authorize = await authorizeRequest(pending);
    const asked = Object.fromEntries(authorize.searchParams);
    assert.equal(`${authorize.origin}${authorize.pathname}`, openai.deps.endpoints?.authorize);
    assert.equal(asked['client_id'], 'dynamic_agent_client');
    assert.equal(asked['agent_name_hint'], 'Relay');
    assert.equal(asked['response_type'], 'code');
    assert.equal(asked['scope'], 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
    assert.equal(asked['resource'], 'https://api.openai.test/v1');
    assert.equal(asked['code_challenge_method'], 'S256');
    assert.match(asked['redirect_uri'] ?? '', /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    assert.match(asked['ext_agent_host_id'] ?? '', /^urn:uuid:[0-9a-f-]{36}$/);
    // The host id was on disk before the request that names it.
    assert.equal((await saved(openai)).hostId, asked['ext_agent_host_id']);

    openai.token = () => ({ status: 200, body: openai.tokens({ nonce: asked['nonce'] ?? '' }) });
    const page = await comeBack(authorize, { code: 'auth-code', state: asked['state'] ?? '', client_id: 'oaiapp_relay1', scope: FULL_SCOPE });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /You&#39;re using your ChatGPT plan|You're using your ChatGPT plan/);

    assert.deepEqual(await pending.result, { email: 'ada@example.com', planEnabled: true, registered: true });

    const [exchange] = openai.requests;
    assert.equal(exchange?.form['grant_type'], 'authorization_code');
    assert.equal(exchange?.form['client_id'], 'oaiapp_relay1', 'the issued id, never the registration entrypoint');
    assert.equal(exchange?.form['code'], 'auth-code');
    assert.equal(exchange?.form['redirect_uri'], asked['redirect_uri']);
    assert.equal(exchange?.form['resource'], 'https://api.openai.test/v1');
    assert.equal(exchange?.form['client_secret'], undefined, 'a public client has no secret');
    assert.equal(createHash('sha256').update(exchange?.form['code_verifier'] ?? '').digest('base64url'), asked['code_challenge']);

    const file = await saved(openai);
    assert.equal(file.active, 'oaiapp_relay1');
    assert.equal(file.accounts[0]?.['subject'], 'user-1');
    assert.equal(file.accounts[0]?.['tokens'].accessToken, 'access-1');
    assert.equal(file.accounts[0]?.['tokens'].refreshToken, 'refresh-1');
    if (process.platform !== 'win32') assert.equal((await stat(chatgptPath(openai.home))).mode & 0o777, 0o600);
    assert.deepEqual(await chatgptStatus(openai.deps), { state: 'active', email: 'ada@example.com' });

    // The listener is gone once the sign-in is.
    await assert.rejects(fetch(pending.url));
  });

  it('refuses a callback that is not this attempt, and keeps waiting for the one that is', async () => {
    const pending = await beginChatgptSignIn({ deps: openai.deps });
    const authorize = await authorizeRequest(pending);
    openai.token = () => ({ status: 200, body: openai.tokens({ nonce: authorize.searchParams.get('nonce') ?? '' }) });

    assert.equal((await comeBack(authorize, { code: 'stolen', state: 'someone-elses', client_id: 'oaiapp_evil' })).status, 400);
    assert.equal(openai.requests.length, 0, 'no code is exchanged for a callback that is not ours');
    assert.equal((await fetch(pending.url.replace(/k=.*/, 'k=guess'), { redirect: 'manual' })).status, 404);

    await comeBack(authorize, { code: 'auth-code', state: authorize.searchParams.get('state') ?? '', client_id: 'oaiapp_relay1' });
    assert.equal((await pending.result).planEnabled, true);
  });

  it('stops without exchanging anything when the person declines', async () => {
    const pending = await beginChatgptSignIn({ deps: openai.deps });
    const authorize = await authorizeRequest(pending);
    await comeBack(authorize, { error: 'access_denied', state: authorize.searchParams.get('state') ?? '' });

    await assert.rejects(pending.result, (error: unknown) => error instanceof ChatgptSignInError && error.code === 'declined');
    assert.equal(openai.requests.length, 0);
    assert.equal((await chatgptStatus(openai.deps)).state, 'signed-out');
  });

  it('saves nothing when OpenAI never issued a client id', async () => {
    const pending = await beginChatgptSignIn({ deps: openai.deps });
    const authorize = await authorizeRequest(pending);
    await comeBack(authorize, { code: 'auth-code', state: authorize.searchParams.get('state') ?? '' });

    await assert.rejects(pending.result, /did not finish registering/);
    assert.equal(openai.requests.length, 0);
  });

  const forged = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const BAD_ID_TOKENS: Array<[string, (nonce: string, base: string) => Record<string, unknown>, KeyObject | undefined, RegExp]> = [
    ['signed by someone else', (nonce, base) => ({ iss: base, aud: 'oaiapp_relay1', sub: 'user-1', nonce, exp: 4102444800 }), forged, /not signed by OpenAI/],
    ['from another sign-in attempt', (_nonce, base) => ({ iss: base, aud: 'oaiapp_relay1', sub: 'user-1', nonce: 'replayed', exp: 4102444800 }), undefined, /different sign-in attempt/],
    ['issued to another app', (nonce, base) => ({ iss: base, aud: 'oaiapp_other', sub: 'user-1', nonce, exp: 4102444800 }), undefined, /different app/],
    ['from another issuer', (nonce) => ({ iss: 'https://evil.example', aud: 'oaiapp_relay1', sub: 'user-1', nonce, exp: 4102444800 }), undefined, /different issuer/],
    ['already expired', (nonce, base) => ({ iss: base, aud: 'oaiapp_relay1', sub: 'user-1', nonce, exp: 1 }), undefined, /expired/],
  ];
  for (const [name, claims, key, expected] of BAD_ID_TOKENS) {
    it(`rejects an ID token ${name}, and saves no credential`, async () => {
      const pending = await beginChatgptSignIn({ deps: openai.deps });
      const authorize = await authorizeRequest(pending);
      const base = openai.deps.endpoints?.issuer ?? '';
      openai.token = () => ({
        status: 200,
        body: { ...(openai.tokens({}) as object), id_token: openai.idToken(claims(authorize.searchParams.get('nonce') ?? '', base), key) },
      });
      const page = await comeBack(authorize, { code: 'auth-code', state: authorize.searchParams.get('state') ?? '', client_id: 'oaiapp_relay1' });
      assert.equal(page.status, 400);

      await assert.rejects(pending.result, expected);
      assert.equal((await saved(openai)).accounts.length, 0);
      assert.equal(await chatgptPlanAccess({ deps: openai.deps }), undefined);
    });
  }

  it('reports the token endpoint\'s error code, and never its body', async () => {
    const pending = await beginChatgptSignIn({ deps: openai.deps });
    const authorize = await authorizeRequest(pending);
    openai.token = () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'secret-detail' } });
    await comeBack(authorize, { code: 'auth-code', state: authorize.searchParams.get('state') ?? '', client_id: 'oaiapp_relay1' });

    await assert.rejects(pending.result, (error: unknown) => error instanceof ChatgptSignInError && /invalid_grant/.test(error.message) && !/secret-detail/.test(error.message));
  });

  it('rides out a bad gateway from OpenAI\'s key and discovery endpoints', async () => {
    openai.discoveryStatus = 502;
    let asked = 0;
    openai.keysStatus = () => ((asked += 1) === 1 ? 502 : 200);

    assert.equal((await signIn(openai)).result.planEnabled, true);
    assert.equal(asked, 2, 'the keys are asked for once more');

    // Signing out does not hinge on the discovery document either.
    assert.equal((await chatgptSignOut(openai.deps)).revoked, true);
    assert.equal(openai.requests.at(-1)?.path, '/revoke');
  });

  it('refuses the sign-in when the keys cannot be had at all', async () => {
    openai.keysStatus = () => 502;
    await assert.rejects(signIn(openai), /could not verify who signed in/);
    assert.equal((await saved(openai)).accounts.length, 0);
  });

  it('closes its listener when cancelled', async () => {
    const pending = await beginChatgptSignIn({ deps: openai.deps });
    pending.cancel();
    await assert.rejects(pending.result, (error: unknown) => error instanceof ChatgptSignInError && error.code === 'cancelled');
    await assert.rejects(fetch(pending.url));
  });

  it('gives up after its time limit', async () => {
    const pending = await beginChatgptSignIn({ deps: openai.deps, timeoutMs: 20 });
    await assert.rejects(pending.result, (error: unknown) => error instanceof ChatgptSignInError && error.code === 'timeout');
  });
});

describe('Sign in with ChatGPT: signing in again', () => {
  it('reuses the issued client and the host id, and tells OpenAI who is coming back', async () => {
    const first = await signIn(openai);
    const again = await signIn(openai);
    const asked = Object.fromEntries(again.authorize.searchParams);

    assert.equal(asked['client_id'], 'oaiapp_relay1');
    assert.equal(asked['agent_name_hint'], undefined, 'the name is only for a first registration');
    assert.equal(asked['ext_agent_host_id'], first.authorize.searchParams.get('ext_agent_host_id'));
    assert.equal(asked['login_hint'], 'ada@example.com');
    assert.ok((asked['id_token_hint'] ?? '').split('.').length === 3);
    assert.equal(asked['prompt'], undefined, 'an ordinary sign-in does not force the consent page');
    assert.equal(again.result.registered, false);

    const file = await saved(openai);
    assert.equal(file.accounts.length, 1);
    assert.equal(file.accounts[0]?.['tokens'].accessToken, 'access-2');
  });

  it('refuses to put a different account\'s credential on a saved registration', async () => {
    await signIn(openai);
    await assert.rejects(signIn(openai, { subject: 'someone-else' }), /different ChatGPT account/);

    const file = await saved(openai);
    assert.equal(file.accounts[0]?.['subject'], 'user-1');
    assert.equal(file.accounts[0]?.['tokens'].accessToken, 'access-1');
  });

  it('refuses a callback that answers for another registration', async () => {
    await signIn(openai);
    const pending = await beginChatgptSignIn({ deps: openai.deps });
    const authorize = await authorizeRequest(pending);
    await comeBack(authorize, { code: 'auth-code', state: authorize.searchParams.get('state') ?? '', client_id: 'oaiapp_other' });
    await assert.rejects(pending.result, /different registration/);
  });

  it('adds a second account beside the first, and selects it', async () => {
    await signIn(openai);
    const second = await signIn(openai, { account: 'new', clientId: 'oaiapp_relay2', subject: 'user-2' });
    assert.equal(second.authorize.searchParams.get('client_id'), 'dynamic_agent_client');
    assert.equal(second.authorize.searchParams.get('id_token_hint'), null);
    assert.equal(second.result.registered, true);

    const file = await saved(openai);
    assert.equal(file.active, 'oaiapp_relay2');
    assert.deepEqual(file.accounts.map((account) => account['clientId']).sort(), ['oaiapp_relay1', 'oaiapp_relay2']);
  });

  it('keeps a sign-in without plan use, spends nothing with it, and asks for consent the next time', async () => {
    const { result } = await signIn(openai, { scope: IDENTITY_SCOPE });
    assert.equal(result.planEnabled, false);
    assert.deepEqual(await chatgptStatus(openai.deps), { state: 'no-plan', email: 'ada@example.com' });
    assert.equal(await chatgptPlanAccess({ deps: openai.deps }), undefined);

    const again = await signIn(openai);
    assert.equal(again.authorize.searchParams.get('prompt'), 'consent');
    assert.equal(again.result.planEnabled, true);
  });
});

describe('Sign in with ChatGPT: the token a turn spends', () => {
  it('is nothing at all when nobody signed in', async () => {
    assert.equal(await chatgptPlanAccess({ deps: openai.deps }), undefined);
    assert.deepEqual(await chatgptStatus(openai.deps), { state: 'signed-out', email: null });
  });

  it('is the saved one, with no request, while it will outlast the turn', async () => {
    await signIn(openai);
    const before = openai.requests.length;
    const access = await chatgptPlanAccess({ deps: openai.deps, minValidMs: 30 * 60_000 });
    assert.equal(access?.accessToken, 'access-1');
    assert.equal(access?.expiresAt, openai.clock.now + 3600_000);
    assert.equal(openai.requests.length, before);
  });

  it('is renewed first when it would not, and both rotating tokens are replaced together', async () => {
    await signIn(openai);
    openai.clock.now += 45 * 60_000;
    openai.token = () => ({ status: 200, body: { access_token: 'access-renewed', refresh_token: 'refresh-renewed', expires_in: 3600, scope: FULL_SCOPE, token_type: 'Bearer' } });

    const access = await chatgptPlanAccess({ deps: openai.deps, minValidMs: 30 * 60_000 });
    assert.equal(access?.accessToken, 'access-renewed');

    const renewal = openai.requests.at(-1);
    assert.deepEqual(renewal?.form, { grant_type: 'refresh_token', client_id: 'oaiapp_relay1', refresh_token: 'refresh-1', resource: 'https://api.openai.test/v1' });

    const tokens = (await saved(openai)).accounts[0]?.['tokens'];
    assert.equal(tokens.accessToken, 'access-renewed');
    assert.equal(tokens.refreshToken, 'refresh-renewed');
    assert.ok(typeof tokens.idToken === 'string' && tokens.idToken.length > 0, 'the ID token is kept for the next sign-in\'s hint');
    assert.equal((await chatgptStatus(openai.deps)).state, 'active');
  });

  it('waits for the moment OpenAI says a renewal is allowed', async () => {
    await signIn(openai, { extra: { earliest_refresh_at: Math.floor(openai.clock.now / 1000) + 50 * 60 } });
    openai.clock.now += 45 * 60_000;
    const before = openai.requests.length;

    assert.equal((await chatgptPlanAccess({ deps: openai.deps, minValidMs: 30 * 60_000 }))?.accessToken, 'access-1');
    assert.equal(openai.requests.length, before, 'too early: the current token is the one to use');

    openai.clock.now += 6 * 60_000;
    openai.token = () => ({ status: 200, body: { access_token: 'access-renewed', refresh_token: 'refresh-renewed', expires_in: 3600, scope: FULL_SCOPE } });
    assert.equal((await chatgptPlanAccess({ deps: openai.deps, minValidMs: 30 * 60_000 }))?.accessToken, 'access-renewed');
  });

  it('renews once when two turns ask at the same moment', async () => {
    await signIn(openai);
    openai.clock.now += 45 * 60_000;
    const before = openai.requests.length;
    openai.token = () => ({ status: 200, body: { access_token: 'access-renewed', refresh_token: 'refresh-renewed', expires_in: 3600, scope: FULL_SCOPE } });

    const [a, b] = await Promise.all([
      chatgptPlanAccess({ deps: openai.deps, minValidMs: 30 * 60_000 }),
      chatgptPlanAccess({ deps: openai.deps, minValidMs: 30 * 60_000 }),
    ]);
    assert.equal(a?.accessToken, 'access-renewed');
    assert.equal(b?.accessToken, 'access-renewed');
    assert.equal(openai.requests.length - before, 1, 'a rotating refresh token is spent exactly once');
  });

  for (const code of ['invalid_grant', 'refresh_token_reused', 'refresh_token_expired', 'invalid_client']) {
    it(`fails the turn, rather than change the bill, once OpenAI answers ${code}`, async () => {
      await signIn(openai);
      openai.clock.now += 61 * 60_000;
      openai.token = () => ({ status: 400, body: { error: code } });

      const refused = await chatgptPlanAccess({ deps: openai.deps }).then(() => undefined, (error: unknown) => error);
      assert.ok(refused instanceof ChatgptSessionError);
      assert.equal(classifyFailure(failedTurn(refused.message)), 'terminal', 'a refused session is not worth a retry');
      assert.match(refused.message, code === 'invalid_client' ? /relay chatgpt login --new/ : /relay chatgpt login/);

      const file = await saved(openai);
      assert.equal(file.accounts[0]?.['tokens'], null);
      assert.equal(file.accounts[0]?.['clientId'], 'oaiapp_relay1', 'the registration outlives the session');
      assert.deepEqual(await chatgptStatus(openai.deps), { state: 'lapsed', email: 'ada@example.com' });

      // And it keeps failing, with no further request, until the person signs in again.
      const before = openai.requests.length;
      await assert.rejects(chatgptPlanAccess({ deps: openai.deps }), ChatgptSessionError);
      assert.equal(openai.requests.length, before);

      await signIn(openai);
      assert.equal((await chatgptStatus(openai.deps)).state, 'active');
    });
  }

  it('keeps the credential through a fault that is not about the session', async () => {
    await signIn(openai);
    openai.clock.now += 45 * 60_000;
    openai.token = () => ({ status: 503, body: {} });

    // Still good for a quarter of an hour: use it.
    assert.equal((await chatgptPlanAccess({ deps: openai.deps, minValidMs: 30 * 60_000 }))?.accessToken, 'access-1');

    // Past its expiry there is nothing to use, and nothing is thrown away either.
    openai.clock.now += 20 * 60_000;
    const unavailable = await chatgptPlanAccess({ deps: openai.deps }).then(() => undefined, (error: unknown) => error);
    assert.ok(unavailable instanceof ChatgptUnavailableError);
    assert.equal(classifyFailure(failedTurn(unavailable.message)), 'retryable');
    assert.equal((await saved(openai)).accounts[0]?.['tokens'].refreshToken, 'refresh-1');
  });

  it('calls a session lapsed once its refresh token is past OpenAI\'s thirty days', async () => {
    await signIn(openai);
    openai.clock.now += 31 * 24 * 60 * 60_000;
    assert.equal((await chatgptStatus(openai.deps)).state, 'lapsed');
  });
});

describe('Sign in with ChatGPT: signing out', () => {
  it('ends the session at OpenAI, forgets the tokens, and keeps the registration', async () => {
    const first = await signIn(openai);
    const result = await chatgptSignOut(openai.deps);
    assert.deepEqual(result, { signedOut: true, revoked: true, email: 'ada@example.com' });
    assert.deepEqual(openai.requests.at(-1), { path: '/revoke', form: { token: 'refresh-1', token_type_hint: 'refresh_token', client_id: 'oaiapp_relay1' } });

    const file = await saved(openai);
    assert.equal(file.accounts[0]?.['tokens'], null);
    assert.equal(file.accounts[0]?.['lapsed'], false);
    assert.equal(JSON.stringify(file).includes('access-1'), false);
    assert.deepEqual(await chatgptStatus(openai.deps), { state: 'signed-out', email: 'ada@example.com' });
    // Signed out on purpose is not a lapse: Codex simply goes back to its own sign-in.
    assert.equal(await chatgptPlanAccess({ deps: openai.deps }), undefined);

    const again = await signIn(openai);
    assert.equal(again.authorize.searchParams.get('client_id'), 'oaiapp_relay1');
    assert.equal(again.authorize.searchParams.get('ext_agent_host_id'), first.authorize.searchParams.get('ext_agent_host_id'));
    assert.equal(again.authorize.searchParams.get('id_token_hint'), null, 'no hint survives a sign-out');
    assert.equal(again.authorize.searchParams.get('login_hint'), 'ada@example.com');
  });

  it('forgets the tokens even when OpenAI never confirms, and says so', async () => {
    await signIn(openai);
    openai.revoke = () => ({ status: 503 });
    const result = await chatgptSignOut(openai.deps);

    assert.deepEqual(result, { signedOut: true, revoked: false, email: 'ada@example.com' });
    assert.equal(openai.requests.filter((request) => request.path === '/revoke').length, 3, 'a server fault is retried, with a pause between');
    assert.equal(openai.slept.length, 2);
    assert.equal((await saved(openai)).accounts[0]?.['tokens'], null);
  });

  it('has nothing to do when nobody is signed in', async () => {
    assert.deepEqual(await chatgptSignOut(openai.deps), { signedOut: false, revoked: false, email: null });
    assert.equal(openai.requests.length, 0);
  });
});

describe('Codex on a ChatGPT plan', () => {
  it('points Codex at the Responses API with a token it reads from one variable', () => {
    const args = codexPlanArgs();
    const overrides = args.filter((arg) => arg !== '-c');
    assert.equal(args.length, overrides.length * 2, 'every override travels behind its own -c');
    assert.deepEqual(overrides, [
      'model_provider="relay_chatgpt_plan"',
      'model_providers.relay_chatgpt_plan.name="ChatGPT plan"',
      'model_providers.relay_chatgpt_plan.base_url="https://api.openai.com/v1"',
      `model_providers.relay_chatgpt_plan.env_key="${CODEX_PLAN_ENV}"`,
      'model_providers.relay_chatgpt_plan.wire_api="responses"',
      'model_providers.relay_chatgpt_plan.requires_openai_auth=false',
      'model_providers.relay_chatgpt_plan.supports_websockets=false',
    ]);
  });

  it('adds the provider to a fresh turn and to a resumed one, and never the token', () => {
    for (const resumeSessionId of [undefined, '00000000-0000-0000-0000-000000000000']) {
      const args = buildCodexArgs({ capability: 'read_only', chatgptPlan: true, ...(resumeSessionId === undefined ? {} : { resumeSessionId }) });
      assert.ok(args.includes('model_provider="relay_chatgpt_plan"'));
      assert.equal(args.at(-1), '-', 'the prompt still arrives on stdin');
      if (resumeSessionId !== undefined) for (const flag of CODEX_EXEC_ONLY_FLAGS) assert.ok(!args.includes(flag));
      assert.ok(args.includes(resumeSessionId === undefined ? 'read-only' : 'sandbox_mode="read-only"'), 'the sandbox is untouched');
    }
    assert.ok(!buildCodexArgs({ capability: 'write' }).some((arg) => arg.includes('relay_chatgpt_plan')));
  });

  it('says where to look when the plan is the reason a turn failed', () => {
    const limited = explainPlanFailure('exceeded retry limit, last status: 429 Too Many Requests', false);
    assert.ok(limited.includes(CHATGPT_USAGE_URL));
    assert.equal(classifyFailure(failedTurn(limited)), 'retryable');

    const refused = explainPlanFailure('unexpected status 401 Unauthorized: nope', false);
    assert.match(refused, /relay chatgpt login/);
    assert.equal(classifyFailure(failedTurn(refused)), 'terminal');

    // The token simply ran out while the turn was running: retry, and resume.
    const expired = explainPlanFailure('unexpected status 401 Unauthorized: nope', true);
    assert.equal(classifyFailure(failedTurn(expired)), 'retryable');

    assert.equal(explainPlanFailure('codex exited with code 2', false), 'codex exited with code 2');
  });

  /** Stands in for `codex exec`: records its argv and the one variable, then ends the way it is told. */
  async function fakeCodex(dir: string, mode: 'ok' | '401'): Promise<{ binary: string; capture: string }> {
    const capture = join(dir, 'capture.json');
    const binary = join(dir, 'fake-codex.mjs');
    await writeFile(
      binary,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv.slice(2), token: process.env.${CODEX_PLAN_ENV} ?? null }));
const line = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
line({ type: 'thread.started', thread_id: 'thread-1' });
if (${JSON.stringify(mode)} === '401') {
  line({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized: nope' } });
  process.exit(1);
}
line({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } });
line({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 1 } });
`,
    );
    await chmod(binary, 0o755);
    return { binary, capture };
  }

  const turn = { prompt: 'noop', cwd: process.cwd(), role: 'implementer', capability: 'write' as const, timeoutMs: 30_000 };
  const onPosix = { skip: process.platform === 'win32' ? 'runs a shebang script' : false };

  it('hands the token to that one process, through its environment and not its argv', onPosix, async () => {
    const { binary, capture } = await fakeCodex(openai.home, 'ok');
    const asked: number[] = [];
    const harness = new CodexHarness({
      binary,
      planAccess: async (minValidMs) => {
        asked.push(minValidMs);
        return { accessToken: 'access-for-this-turn', expiresAt: Date.now() + 3600_000 };
      },
    });

    const session = await harness.start(turn);
    assert.equal(session.ok, true);
    assert.deepEqual(asked, [30_000 + 60_000], 'the token has to outlast the turn');

    const seen = JSON.parse(await readFile(capture, 'utf8')) as { argv: string[]; token: string | null };
    assert.equal(seen.token, 'access-for-this-turn');
    assert.ok(seen.argv.includes('model_provider="relay_chatgpt_plan"'));
    assert.ok(!JSON.stringify(session.invocation).includes('access-for-this-turn'), 'the recorded invocation carries no token');
    assert.equal(process.env[CODEX_PLAN_ENV], undefined, 'and Relay\'s own environment never did');
  });

  it('leaves Codex on its own sign-in when Relay holds none', onPosix, async () => {
    const { binary, capture } = await fakeCodex(openai.home, 'ok');
    const session = await new CodexHarness({ binary, planAccess: async () => undefined }).start(turn);
    assert.equal(session.ok, true);

    const seen = JSON.parse(await readFile(capture, 'utf8')) as { argv: string[]; token: string | null };
    assert.equal(seen.token, null);
    assert.ok(!seen.argv.some((arg) => arg.includes('relay_chatgpt_plan')));
  });

  it('fails the turn without starting Codex when the plan sign-in has lapsed', onPosix, async () => {
    const { binary, capture } = await fakeCodex(openai.home, 'ok');
    const harness = new CodexHarness({
      binary,
      planAccess: async () => {
        throw new ChatgptSessionError('invalid_grant');
      },
    });

    const session = await harness.start(turn);
    assert.equal(session.ok, false);
    assert.match(session.error ?? '', /relay chatgpt login/);
    assert.equal(session.events.at(-1)?.type, 'failed');
    assert.equal(classifyFailure(session), 'terminal');
    await assert.rejects(readFile(capture, 'utf8'), 'Codex never ran, so nothing was billed anywhere else');
  });

  it('turns a token that ran out mid-turn into a retry, and a refusal into advice', onPosix, async () => {
    const { binary } = await fakeCodex(openai.home, '401');

    const expired = await new CodexHarness({ binary, planAccess: async () => ({ accessToken: 't', expiresAt: Date.now() - 1 }) }).start(turn);
    assert.equal(classifyFailure(expired), 'retryable');
    assert.equal(expired.sessionId, 'thread-1', 'so the retry can resume the thread');

    const refused = await new CodexHarness({ binary, planAccess: async () => ({ accessToken: 't', expiresAt: Date.now() + 3600_000 }) }).start(turn);
    assert.equal(classifyFailure(refused), 'terminal');
    assert.match(refused.error ?? '', /relay chatgpt login/);
  });

  it('spends the token Relay saved, renewed for the length of the turn', onPosix, async () => {
    await signIn(openai);
    openai.clock.now += 45 * 60_000;
    openai.token = () => ({ status: 200, body: { access_token: 'access-renewed', refresh_token: 'refresh-renewed', expires_in: 3600, scope: FULL_SCOPE } });
    const { binary, capture } = await fakeCodex(openai.home, 'ok');

    const harness = new CodexHarness({ binary, defaultTimeoutMs: 30 * 60_000, planAccess: (minValidMs) => chatgptPlanAccess({ minValidMs, deps: openai.deps }) });
    await harness.start({ ...turn, timeoutMs: undefined as never });

    assert.equal((JSON.parse(await readFile(capture, 'utf8')) as { token: string }).token, 'access-renewed');
  });
});

describe('Sign in with ChatGPT from the studio', () => {
  function pendingSignIn(): { pending: PendingSignIn; finish: (outcome: SignInResult | Error) => void; cancelled: () => boolean } {
    let resolve: (result: SignInResult) => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    let cancelled = false;
    const result = new Promise<SignInResult>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    result.catch(() => undefined);
    return {
      pending: {
        url: 'http://127.0.0.1:5555/auth/start?k=abc',
        result,
        cancel: () => {
          cancelled = true;
          reject(new ChatgptSignInError('cancelled', 'Sign-in cancelled.'));
        },
      },
      finish: (outcome) => (outcome instanceof Error ? reject(outcome) : resolve(outcome)),
      cancelled: () => cancelled,
    };
  }
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it('shows the studio a loopback link and a yes or no, and opens the browser here', async () => {
    const flow = pendingSignIn();
    const opened: string[] = [];
    const logins = new LoginSessions({ chatgpt: async () => flow.pending, open: async (url) => (opened.push(url), true), openDelayMs: 0, codexInstalled: async () => true });

    const started = await logins.start('codex', 'chatgpt');
    assert.ok(started.ok);
    assert.equal(started.session.mode, 'chatgpt');
    assert.equal(started.session.status, 'pending');
    assert.equal(started.session.url, flow.pending.url);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(opened, [flow.pending.url]);
    assert.equal(logins.pending(), 1);
    assert.deepEqual(logins.submitCode(started.session.id, 'abc'), { ok: false, error: 'The CLI is not accepting input.' });

    flow.finish({ email: 'ada@example.com', planEnabled: true, registered: true });
    await settle();
    const done = logins.get(started.session.id);
    assert.equal(done?.status, 'succeeded');
    assert.deepEqual(Object.keys(done ?? {}).sort(), ['agent', 'code', 'error', 'id', 'mode', 'needsCode', 'startedAt', 'status', 'url'], 'nothing account-shaped is sent to the studio');
  });

  it('does not call it signed in when plan use was not allowed', async () => {
    const flow = pendingSignIn();
    const logins = new LoginSessions({ chatgpt: async () => flow.pending, open: async () => true, codexInstalled: async () => true });
    const started = await logins.start('codex', 'chatgpt');
    assert.ok(started.ok);

    flow.finish({ email: 'ada@example.com', planEnabled: false, registered: true });
    await settle();
    assert.equal(logins.get(started.session.id)?.status, 'failed');
    assert.match(logins.get(started.session.id)?.error ?? '', /not allowed to use your ChatGPT plan/);
  });

  it('closes the listener when the studio cancels, or starts over', async () => {
    const first = pendingSignIn();
    const second = pendingSignIn();
    const flows = [first, second];
    const opened: string[] = [];
    const logins = new LoginSessions({ chatgpt: async () => flows.shift()!.pending, open: async (url) => (opened.push(url), true), openDelayMs: 10, codexInstalled: async () => true });

    const one = await logins.start('codex', 'chatgpt');
    const two = await logins.start('codex', 'chatgpt');
    assert.ok(one.ok && two.ok);
    assert.equal(first.cancelled(), true, 'a second sign-in ends the first');
    assert.equal(logins.get(one.session.id)?.status, 'cancelled');

    assert.equal(logins.cancel(two.session.id), true);
    assert.equal(second.cancelled(), true);
    assert.equal(logins.get(two.session.id)?.status, 'cancelled');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(opened, [], 'no tab opens on a sign-in that was already replaced or cancelled');
  });

  it('is Codex\'s alone, and needs Codex installed', async () => {
    const logins = new LoginSessions({ chatgpt: async () => pendingSignIn().pending, open: async () => true, codexInstalled: async () => false });
    const missing = await logins.start('codex', 'chatgpt');
    assert.ok(!missing.ok && /npm install -g @openai\/codex/.test(missing.error));

    const claude = await new LoginSessions({ codexInstalled: async () => true }).start('claude', 'chatgpt');
    assert.ok(!claude.ok && /has no "chatgpt" sign-in/.test(claude.error));
  });

  it('is offered by a companion on this machine, and refused by a cloud runner', async () => {
    const flow = pendingSignIn();
    const logins = new LoginSessions({ chatgpt: async () => flow.pending, open: async () => true, codexInstalled: async () => true });
    const request = { method: 'POST', url: '/v1/agents/codex/login', json: async () => ({ mode: 'chatgpt' }) };

    const local = createRouter({ version: 'test', repository: null, runs: null, logins });
    assert.ok(local.capabilities.includes('chatgpt'));
    const answer = await local.handle(request);
    assert.ok(answer.kind === 'json' && answer.status === 200);
    assert.equal((answer.body as { url: string }).url, flow.pending.url);
    flow.pending.cancel();

    const cloud = createRouter({ version: 'test', repository: null, runs: null, logins, capabilities: ['agents', 'runs', 'repositories', 'github'] });
    await assert.rejects(cloud.handle(request), (error: unknown) => (error as { status?: number }).status === 409);
  });

  it('signs out of Relay\'s own sign-in before it would touch the CLI\'s', async () => {
    const previous = process.env['RELAY_HOME'];
    process.env['RELAY_HOME'] = openai.home;
    try {
      // A session with nothing to revoke, so the sign-out is entirely local.
      await writeFile(
        chatgptPath(openai.home),
        JSON.stringify({
          version: 1,
          hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000',
          active: 'oaiapp_relay1',
          accounts: [{ clientId: 'oaiapp_relay1', issuer: 'https://auth.openai.com', subject: 'user-1', email: 'ada@example.com', lapsed: false, registeredAt: 'x', tokens: { accessToken: 'a', refreshToken: null, idToken: 'i', scopes: [PLAN_SCOPE], expiresAt: new Date(Date.now() + 3600_000).toISOString(), earliestRefreshAt: null, savedAt: new Date().toISOString() } }],
        }),
      );
      assert.deepEqual(await logout('codex'), { ok: true, detail: 'Signed out of ChatGPT.' });
      assert.equal((await saved(openai)).accounts[0]?.['tokens'], null);
    } finally {
      if (previous === undefined) delete process.env['RELAY_HOME'];
      else process.env['RELAY_HOME'] = previous;
    }
  });
});

describe('relay chatgpt', () => {
  /** The commands print for a person; the tests only care how they end. */
  async function quietly<T>(run: () => Promise<T>): Promise<{ value: T; printed: string }> {
    const original = process.stdout.write;
    let printed = '';
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      printed += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      return { value: await run(), printed };
    } finally {
      process.stdout.write = original;
    }
  }

  const begin = (outcome: SignInResult | Error) => async (): Promise<PendingSignIn> => ({
    url: 'http://127.0.0.1:5555/auth/start?k=abc',
    result: outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome),
    cancel: () => undefined,
  });

  it('login says whose plan is in use, once, and where to manage it', async () => {
    const first = await quietly(() => chatgptLoginCommand({}, { begin: begin({ email: 'ada@example.com', planEnabled: true, registered: true }), codexInstalled: async () => true }));
    assert.equal(first.value, EXIT.success);
    assert.match(first.printed, /Continue with ChatGPT/);
    assert.match(first.printed, /http:\/\/127\.0\.0\.1:5555\/auth\/start/);
    assert.match(first.printed, /Signed in as ada@example\.com/);
    assert.match(first.printed, /You're using your ChatGPT plan/);
    assert.ok(first.printed.includes(CHATGPT_USAGE_URL));

    const again = await quietly(() => chatgptLoginCommand({}, { begin: begin({ email: 'ada@example.com', planEnabled: true, registered: false }), codexInstalled: async () => true }));
    assert.doesNotMatch(again.printed, /You're using your ChatGPT plan/, 'the notice is for the first sign-in only');
  });

  it('login asks for another account only when told to', async () => {
    const asked: Array<string | undefined> = [];
    const recording = (options: { account?: 'saved' | 'new' }): Promise<PendingSignIn> => {
      asked.push(options.account);
      return begin({ email: null, planEnabled: true, registered: false })();
    };
    await quietly(() => chatgptLoginCommand({}, { begin: recording, codexInstalled: async () => true }));
    await quietly(() => chatgptLoginCommand({ new: true }, { begin: recording, codexInstalled: async () => true }));
    assert.deepEqual(asked, ['saved', 'new']);
  });

  it('login exits by what happened: not allowed, declined, cancelled', async () => {
    const run = (outcome: SignInResult | Error) => quietly(() => chatgptLoginCommand({}, { begin: begin(outcome), codexInstalled: async () => true }));
    assert.equal((await run({ email: null, planEnabled: false, registered: true })).value, EXIT.preconditions);
    assert.equal((await run(new ChatgptSignInError('declined', 'The sign-in was declined on OpenAI\'s page.'))).value, EXIT.error);
    assert.equal((await run(new ChatgptSignInError('cancelled', 'Sign-in cancelled.'))).value, EXIT.cancelled);
  });

  it('login warns when there is no Codex to spend the plan', async () => {
    const { printed } = await quietly(() => chatgptLoginCommand({}, { begin: begin({ email: null, planEnabled: true, registered: false }), codexInstalled: async () => false }));
    assert.match(printed, /npm install -g @openai\/codex/);
  });

  it('status and logout report the saved sign-in, and print no token', async () => {
    const none = await quietly(() => chatgptStatusCommand({}, { store: openai.deps }));
    assert.equal(none.value, EXIT.success);
    assert.match(none.printed, /Not signed in/);

    await signIn(openai);
    const active = await quietly(() => chatgptStatusCommand({}, { store: openai.deps }));
    assert.match(active.printed, /ada@example\.com/);
    assert.doesNotMatch(active.printed, /access-1|refresh-1/);

    const out = await quietly(() => chatgptLogoutCommand({}, { store: openai.deps }));
    assert.equal(out.value, EXIT.success);
    assert.match(out.printed, /Signed out of ada@example\.com/);
    assert.match((await quietly(() => chatgptLogoutCommand({}, { store: openai.deps }))).printed, /nothing to sign out of/);
  });

  it('status fails as a precondition when the sign-in has lapsed', async () => {
    await signIn(openai);
    openai.clock.now += 61 * 60_000;
    openai.token = () => ({ status: 400, body: { error: 'invalid_grant' } });
    await assert.rejects(chatgptPlanAccess({ deps: openai.deps }));

    const { value, printed } = await quietly(() => chatgptStatusCommand({}, { store: openai.deps }));
    assert.equal(value, EXIT.preconditions);
    assert.match(printed, /expired/);
  });
});
