import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify, constants as cryptoConstants, type JsonWebKey } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';

import { relayHome } from '../studio/pairing.ts';

/**
 * Sign in with ChatGPT: the one sign-in Relay holds itself.
 *
 * Everything else Relay drives owns its own auth (`delegated.ts`). This is the
 * exception, and it exists because OpenAI's ChatGPT plan usage is granted to an
 * app rather than to a CLI: the person authorizes "Relay" on OpenAI's page, sets
 * how much of their plan it may spend in ChatGPT's settings, and OpenAI hands
 * back an OAuth token that Codex then sends on its Responses requests. There is
 * no vendor command to delegate that to, so Relay is the OAuth client.
 *
 * What that costs is kept as small as it can be:
 *
 *   - The token lives in one owner-only file under `~/.relay`, on the machine
 *     that runs the agents. It is never in `.relay/`, a log, an event, a JSON
 *     document, or anything the studio is sent.
 *   - It leaves this module in exactly one direction: into the environment of
 *     the `codex` process that spends it (`chatgptPlanAccess`).
 *   - Only the browser on this machine can finish a sign-in. The callback is a
 *     loopback listener, so a Relay Cloud runner cannot — and that flow is for
 *     open-source apps on the person's own machine, not for hosted ones.
 *
 * The protocol is OpenAI's, followed as documented at
 * https://developers.openai.com/siwc/token-sharing-open-source — OAuth 2.0
 * authorization code with PKCE and OpenID Connect, a public client with no
 * secret, registered per person the first time they sign in.
 */

export interface ChatgptEndpoints {
  issuer: string;
  authorize: string;
  token: string;
  /** The keys ID tokens are signed with. */
  jwks: string;
  /** Used when the discovery document cannot be read; it names the same address. */
  revocation: string;
  discovery: string;
  /** The API the access token is for, and where Codex sends its requests. */
  resource: string;
}

export const CHATGPT_ENDPOINTS: ChatgptEndpoints = {
  issuer: 'https://auth.openai.com',
  authorize: 'https://auth.openai.com/api/accounts/authorize',
  token: 'https://auth.openai.com/api/accounts/oauth/token',
  jwks: 'https://auth.openai.com/.well-known/jwks.json',
  revocation: 'https://auth.openai.com/api/accounts/oauth/revoke',
  discovery: 'https://auth.openai.com/.well-known/openid-configuration',
  resource: 'https://api.openai.com/v1',
};

/** Where a person sees and limits what Relay spends of their plan. */
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';

/** The scope that lets an app spend the person's plan. Identity alone does not. */
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';

const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
/** The entrypoint for a first sign-in. Never the id to save: OpenAI issues that in the callback. */
const REGISTRATION_CLIENT = 'dynamic_agent_client';
/** What the person sees on OpenAI's consent page, and in ChatGPT's settings afterwards. */
const AGENT_NAME = 'Relay';
/** Only the port may differ between sign-ins; the path is part of the registration. */
const CALLBACK_PATH = '/auth/callback';
const START_PATH = '/auth/start';

const SIGN_IN_TTL_MS = 15 * 60_000;
const HTTP_TIMEOUT_MS = 20_000;
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 30_000;
/** A refresh token unused for this long is dead: OpenAI keeps one for 30 days. */
const REFRESH_LIFETIME_MS = 30 * 24 * 60 * 60_000;
const CLOCK_SKEW_MS = 60_000;

/** Refresh answers that mean this session is over, as opposed to "try again". */
const DEAD_SESSION_CODES = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
  'invalid_client',
]);

/* ------------------------------------------------------------------ */
/* The credential file                                                 */
/* ------------------------------------------------------------------ */

interface ChatgptTokens {
  accessToken: string;
  /** Rotates on every refresh. Null when OpenAI granted no renewable session. */
  refreshToken: string | null;
  /** Kept only to send back to OpenAI as `id_token_hint`, which skips its account picker. */
  idToken: string;
  scopes: string[];
  expiresAt: string;
  earliestRefreshAt: string | null;
  savedAt: string;
}

/** One registration: the client OpenAI issued for one ChatGPT account and workspace. */
interface ChatgptAccount {
  clientId: string;
  issuer: string;
  subject: string;
  email: string | null;
  /** Null after a sign-out, or once OpenAI refused the session. The registration outlives both. */
  tokens: ChatgptTokens | null;
  /**
   * True when the session ended on OpenAI's side rather than the person's. A
   * turn then fails and says so, instead of quietly billing whatever Codex is
   * signed in to on its own.
   */
  lapsed: boolean;
  registeredAt: string;
}

interface ChatgptFile {
  version: 1;
  /** `ext_agent_host_id`: this installation, as OpenAI tells hosts of one client apart. Not a secret. */
  hostId: string;
  /** The selected registration's client id. */
  active: string | null;
  accounts: ChatgptAccount[];
}

export interface ChatgptDeps {
  home: string;
  endpoints: ChatgptEndpoints;
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

function resolveDeps(deps: Partial<ChatgptDeps> | undefined): ChatgptDeps {
  return {
    home: deps?.home ?? relayHome(),
    endpoints: deps?.endpoints ?? CHATGPT_ENDPOINTS,
    fetch: deps?.fetch ?? fetch,
    now: deps?.now ?? Date.now,
    sleep: deps?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

export function chatgptPath(home: string = relayHome()): string {
  return join(home, 'chatgpt.json');
}

function isAccount(value: unknown): value is ChatgptAccount {
  if (value === null || typeof value !== 'object') return false;
  const account = value as Partial<ChatgptAccount>;
  if (typeof account.clientId !== 'string' || typeof account.subject !== 'string' || typeof account.issuer !== 'string') return false;
  if (account.tokens === null || account.tokens === undefined) return true;
  const tokens = account.tokens as Partial<ChatgptTokens>;
  return typeof tokens.accessToken === 'string' && typeof tokens.idToken === 'string' && typeof tokens.expiresAt === 'string' && Array.isArray(tokens.scopes);
}

/** The file as it is, or an empty one with a host id not yet written. Malformed is replaced, never trusted. */
async function readStore(home: string): Promise<ChatgptFile> {
  try {
    const parsed = JSON.parse(await readFile(chatgptPath(home), 'utf8')) as Partial<ChatgptFile>;
    if (typeof parsed.hostId === 'string' && parsed.hostId.length > 0 && Array.isArray(parsed.accounts)) {
      const accounts = parsed.accounts.filter(isAccount).map((account) => ({ ...account, tokens: account.tokens ?? null, lapsed: account.lapsed === true, email: account.email ?? null }));
      const active = typeof parsed.active === 'string' && accounts.some((account) => account.clientId === parsed.active) ? parsed.active : null;
      return { version: 1, hostId: parsed.hostId, active, accounts };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  return { version: 1, hostId: `urn:uuid:${randomUUID()}`, active: null, accounts: [] };
}

async function writeStore(home: string, store: ChatgptFile): Promise<void> {
  const path = chatgptPath(home);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
  // `mode` only applies to a file the write created; tighten one that existed.
  await chmod(path, 0o600).catch(() => undefined);
}

/**
 * One writer at a time, across processes. Two runs refreshing the same
 * rotating token would each invalidate the other's, so the second waits and
 * then finds the first one's answer already in the file.
 */
async function withStoreLock<T>(deps: ChatgptDeps, work: () => Promise<T>): Promise<T> {
  const lock = `${chatgptPath(deps.home)}.lock`;
  await mkdir(dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lock, 'wx', 0o600);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const age = await stat(lock).then((info) => Date.now() - info.mtimeMs, () => 0);
      // Left behind by a process that died holding it.
      if (age > LOCK_STALE_MS) await rm(lock, { force: true });
      else if (Date.now() > deadline) throw new ChatgptUnavailableError('another Relay process is holding the sign-in file');
      else await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await work();
  } finally {
    await rm(lock, { force: true });
  }
}

function selected(store: ChatgptFile): ChatgptAccount | undefined {
  return store.active === null ? undefined : store.accounts.find((account) => account.clientId === store.active);
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

/**
 * `active`: Codex turns spend this person's ChatGPT plan through Relay.
 * `no-plan`: signed in, but they did not allow plan use, so nothing changes.
 * `lapsed`: the session ended on OpenAI's side; turns fail until they sign in again.
 * `signed-out`: never signed in, or signed out.
 */
export type ChatgptState = 'active' | 'no-plan' | 'lapsed' | 'signed-out';

export interface ChatgptStatus {
  state: ChatgptState;
  /** The account the saved registration belongs to, signed in or not. Display only. */
  email: string | null;
}

function stateOf(account: ChatgptAccount | undefined, now: number): ChatgptState {
  if (account === undefined) return 'signed-out';
  if (account.tokens === null) return account.lapsed ? 'lapsed' : 'signed-out';
  if (!account.tokens.scopes.includes(PLAN_SCOPE)) return 'no-plan';
  const expired = Date.parse(account.tokens.expiresAt) <= now;
  const renewable = account.tokens.refreshToken !== null && now - Date.parse(account.tokens.savedAt) < REFRESH_LIFETIME_MS;
  return expired && !renewable ? 'lapsed' : 'active';
}

/** Reads the file and nothing else: no request is made, and no token is returned. */
export async function chatgptStatus(deps?: Partial<ChatgptDeps>): Promise<ChatgptStatus> {
  const resolved = resolveDeps(deps);
  const account = selected(await readStore(resolved.home));
  return { state: stateOf(account, resolved.now()), email: account?.email ?? null };
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** A sign-in that did not finish. `code` is why, for a caller that words it differently. */
export class ChatgptSignInError extends Error {
  readonly code: 'declined' | 'timeout' | 'cancelled' | 'failed';
  constructor(code: ChatgptSignInError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The saved session is over. Worded so `workflow/retry.ts` reads it as an auth
 * failure: a second attempt would be refused exactly the same way.
 */
export class ChatgptSessionError extends Error {
  constructor(detail: string, hint = 'Run `relay chatgpt login`.') {
    super(`ChatGPT plan sign-in expired — not logged in (${detail}). ${hint}`);
  }
}

/** Renewal could not be attempted or answered. Worded as transient, because it is. */
export class ChatgptUnavailableError extends Error {
  constructor(detail: string) {
    super(`ChatGPT plan sign-in is temporarily unavailable: ${detail}.`);
  }
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

async function readAnswer(response: Response): Promise<Answer> {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    return { status: response.status, body: parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {} };
  } catch {
    return { status: response.status, body: {} };
  }
}

async function postForm(deps: ChatgptDeps, url: string, fields: Record<string, string>): Promise<Answer> {
  return readAnswer(
    await deps.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    }),
  );
}

async function getJson(deps: ChatgptDeps, url: string): Promise<Answer> {
  return readAnswer(await deps.fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) }));
}

/** The OAuth error code, wherever the server put it. Never the whole body: a body can carry a token. */
function errorCode(body: Record<string, unknown>): string | undefined {
  const error = body['error'];
  if (typeof error === 'string') return error;
  if (error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code;
  return typeof body['code'] === 'string' ? body['code'] : undefined;
}

/**
 * Where a session is revoked: the address OpenAI's discovery document gives,
 * or the documented one when that document cannot be read. It is served
 * unreliably enough (a 502 now and then) that signing out must not depend on it.
 */
async function revocationEndpoint(deps: ChatgptDeps): Promise<string> {
  try {
    const { status, body } = await getJson(deps, deps.endpoints.discovery);
    if (status === 200 && body['issuer'] === deps.endpoints.issuer && typeof body['revocation_endpoint'] === 'string') return body['revocation_endpoint'];
  } catch {
    // Unreachable is the same answer as unreadable.
  }
  return deps.endpoints.revocation;
}

/** OpenAI's signing keys, asked for twice before giving up: one bad gateway should not cost a sign-in. */
async function signingKeys(deps: ChatgptDeps): Promise<unknown[]> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const { status, body } = await getJson(deps, deps.endpoints.jwks);
      if (status === 200 && Array.isArray(body['keys'])) return body['keys'];
      if (attempt > 0) throw new Error(`OpenAI's signing keys answered ${status}`);
    } catch (error) {
      if (attempt > 0) throw error;
    }
    await deps.sleep(500);
  }
}

/* ------------------------------------------------------------------ */
/* The ID token                                                        */
/* ------------------------------------------------------------------ */

const SIGNATURES: Record<string, { digest: string | null; options: { padding?: number; saltLength?: number; dsaEncoding?: 'ieee-p1363' } }> = {
  RS256: { digest: 'sha256', options: {} },
  RS384: { digest: 'sha384', options: {} },
  RS512: { digest: 'sha512', options: {} },
  PS256: { digest: 'sha256', options: { padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST } },
  ES256: { digest: 'sha256', options: { dsaEncoding: 'ieee-p1363' } },
  ES384: { digest: 'sha384', options: { dsaEncoding: 'ieee-p1363' } },
  EdDSA: { digest: null, options: {} },
};

function decodeSegment(segment: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
  return parsed as Record<string, unknown>;
}

/**
 * Who signed in, taken from the ID token only after its signature, issuer,
 * audience, expiry and nonce all check out against OpenAI's published keys.
 * The token endpoint was reached over TLS, but the identity decides which
 * saved account a credential replaces, so it is verified rather than assumed.
 */
async function verifyIdToken(deps: ChatgptDeps, idToken: string, expected: { clientId: string; nonce: string }): Promise<{ subject: string; email: string | null }> {
  const [head, payload, signature, ...rest] = idToken.split('.');
  if (head === undefined || payload === undefined || signature === undefined || rest.length > 0) throw new Error('the ID token is malformed');

  const header = decodeSegment(head);
  const scheme = typeof header['alg'] === 'string' ? SIGNATURES[header['alg']] : undefined;
  if (scheme === undefined) throw new Error('the ID token is signed in a way Relay does not accept');

  const candidates = (await signingKeys(deps)).filter(
    (key): key is Record<string, unknown> => key !== null && typeof key === 'object' && (header['kid'] === undefined || (key as { kid?: unknown }).kid === header['kid']),
  );
  const signed = Buffer.from(`${head}.${payload}`);
  const proof = Buffer.from(signature, 'base64url');
  const genuine = candidates.some((jwk) => {
    try {
      return verify(scheme.digest, signed, { key: createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' }), ...scheme.options }, proof);
    } catch {
      return false;
    }
  });
  if (!genuine) throw new Error('the ID token was not signed by OpenAI');

  const claims = decodeSegment(payload);
  const audience = Array.isArray(claims['aud']) ? claims['aud'] : [claims['aud']];
  if (claims['iss'] !== deps.endpoints.issuer) throw new Error('the ID token names a different issuer');
  if (!audience.includes(expected.clientId)) throw new Error('the ID token was issued to a different app');
  if (typeof claims['exp'] !== 'number' || claims['exp'] * 1000 < deps.now() - CLOCK_SKEW_MS) throw new Error('the ID token has expired');
  if (claims['nonce'] !== expected.nonce) throw new Error('the ID token belongs to a different sign-in attempt');
  if (typeof claims['sub'] !== 'string' || claims['sub'].length === 0) throw new Error('the ID token names no account');

  return { subject: claims['sub'], email: typeof claims['email'] === 'string' ? claims['email'] : null };
}

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

/** `earliest_refresh_at` is documented as a field and not as a format, so every plausible one is read. */
function readInstant(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(Date.parse(value)).toISOString();
  return null;
}

/** A token response as the record that is saved, or undefined when it is not one. */
function readTokens(body: Record<string, unknown>, now: number, previous?: ChatgptTokens): ChatgptTokens | undefined {
  const accessToken = body['access_token'];
  const idToken = typeof body['id_token'] === 'string' ? body['id_token'] : previous?.idToken;
  if (typeof accessToken !== 'string' || accessToken.length === 0 || idToken === undefined) return undefined;
  const lifetime = typeof body['expires_in'] === 'number' && body['expires_in'] > 0 ? body['expires_in'] : 3600;
  return {
    accessToken,
    refreshToken: typeof body['refresh_token'] === 'string' && body['refresh_token'].length > 0 ? body['refresh_token'] : (previous?.refreshToken ?? null),
    idToken,
    scopes: typeof body['scope'] === 'string' ? body['scope'].split(/\s+/).filter(Boolean).sort() : (previous?.scopes ?? []),
    expiresAt: new Date(now + lifetime * 1000).toISOString(),
    earliestRefreshAt: readInstant(body['earliest_refresh_at']),
    savedAt: new Date(now).toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Sign-in                                                             */
/* ------------------------------------------------------------------ */

export interface SignInOptions {
  /**
   * `saved` signs back in to the registration already here, registering one
   * when there is none. `new` registers another ChatGPT account or workspace
   * and selects it; the old registration is kept.
   */
  account?: 'saved' | 'new';
  timeoutMs?: number;
  deps?: Partial<ChatgptDeps>;
}

export interface SignInResult {
  email: string | null;
  /** Whether the person allowed plan use. Without it the sign-in is kept and nothing spends it. */
  planEnabled: boolean;
  /** True the first time this client is authorized: the moment to say what just changed. */
  registered: boolean;
}

export interface PendingSignIn {
  /**
   * A link on this machine that redirects to OpenAI's page. Safe to print and
   * to hand to the studio: unlike the address it leads to, it carries no hint
   * of who is signing in.
   */
  url: string;
  result: Promise<SignInResult>;
  cancel(): void;
}

function secret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function page(title: string, body: string): string {
  const escape = (text: string) => text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} — Relay</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:18vh auto;padding:0 1.5rem;color:#111"><h1 style="font-size:1.25rem">${escape(title)}</h1><p style="color:#555">${escape(body)}</p></body>`;
}

/**
 * Starts a sign-in and returns the link that leads to it.
 *
 * The listener is up before the link exists, and it answers one callback: the
 * one carrying this attempt's `state`. Anything else gets a 400 and the attempt
 * keeps waiting, so a stray request cannot end somebody's sign-in.
 */
export async function beginChatgptSignIn(options: SignInOptions = {}): Promise<PendingSignIn> {
  const deps = resolveDeps(options.deps);

  // The host id is chosen and on disk before the first request that names it.
  const store = await withStoreLock(deps, async () => {
    const current = await readStore(deps.home);
    await writeStore(deps.home, current);
    return current;
  });
  const saved = options.account === 'new' ? undefined : selected(store);

  const state = secret();
  const nonce = secret();
  const verifier = secret(48);
  const kickoff = secret(12);

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : 0;
  // 127.0.0.1 and never `localhost`: the redirect must match the registration exactly.
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

  const authorize = new URL(deps.endpoints.authorize);
  const query: Record<string, string> = {
    client_id: saved?.clientId ?? REGISTRATION_CLIENT,
    ext_agent_host_id: store.hostId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    resource: deps.endpoints.resource,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  };
  if (saved === undefined) query['agent_name_hint'] = AGENT_NAME;
  else {
    if (saved.tokens !== null) query['id_token_hint'] = saved.tokens.idToken;
    if (saved.email !== null) query['login_hint'] = saved.email;
    // Signed in without plan use, and asking again: this time the consent page has to appear.
    if (saved.tokens !== null && !saved.tokens.scopes.includes(PLAN_SCOPE)) query['prompt'] = 'consent';
  }
  for (const [key, value] of Object.entries(query)) authorize.searchParams.set(key, value);

  let settled = false;
  /** Set by the first callback carrying this attempt's state: a code is exchanged once. */
  let claimed = false;
  let resolveResult!: (result: SignInResult) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<SignInResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // A caller that only ever cancels must not turn that into an unhandled rejection.
  result.catch(() => undefined);

  const finish = (outcome: SignInResult | Error): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    server.close();
    server.closeIdleConnections();
    if (outcome instanceof Error) rejectResult(outcome);
    else resolveResult(outcome);
  };
  const timer = setTimeout(() => finish(new ChatgptSignInError('timeout', 'Sign-in timed out after 15 minutes.')), options.timeoutMs ?? SIGN_IN_TTL_MS);
  timer.unref();

  const complete = async (params: URLSearchParams): Promise<SignInResult> => {
    const denied = params.get('error');
    if (denied !== null) {
      throw denied === 'access_denied'
        ? new ChatgptSignInError('declined', 'The sign-in was declined on OpenAI\'s page.')
        : new ChatgptSignInError('failed', `OpenAI refused the sign-in: ${denied}.`);
    }
    const code = params.get('code');
    if (code === null || code.length === 0) throw new ChatgptSignInError('failed', 'OpenAI returned no authorization code.');

    // A first sign-in is issued its client id here. A later one keeps the id it
    // asked with, and a callback naming another is refused rather than adopted.
    const issued = params.get('client_id');
    const clientId = saved?.clientId ?? issued;
    if (clientId === null || clientId === REGISTRATION_CLIENT) throw new ChatgptSignInError('failed', 'OpenAI did not finish registering Relay. Try again.');
    if (saved !== undefined && issued !== null && issued !== saved.clientId) throw new ChatgptSignInError('failed', 'OpenAI answered for a different registration than the one saved here.');

    const exchange = await postForm(deps, deps.endpoints.token, {
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: deps.endpoints.resource,
    });
    const now = deps.now();
    const tokens = exchange.status === 200 ? readTokens(exchange.body, now) : undefined;
    if (tokens === undefined) throw new ChatgptSignInError('failed', `OpenAI did not issue a credential (${errorCode(exchange.body) ?? `HTTP ${exchange.status}`}).`);

    let identity: { subject: string; email: string | null };
    try {
      identity = await verifyIdToken(deps, tokens.idToken, { clientId, nonce });
    } catch (error) {
      throw new ChatgptSignInError('failed', `Relay could not verify who signed in: ${error instanceof Error ? error.message : String(error)}.`);
    }
    if (saved !== undefined && (saved.subject !== identity.subject || saved.issuer !== deps.endpoints.issuer)) {
      throw new ChatgptSignInError('failed', 'That is a different ChatGPT account from the one saved here. Use `relay chatgpt login --new` to add it.');
    }

    // Cancelled or timed out while OpenAI was answering: nothing is saved.
    if (settled) throw new ChatgptSignInError('cancelled', 'Sign-in cancelled.');
    await withStoreLock(deps, async () => {
      const current = await readStore(deps.home);
      const account: ChatgptAccount = {
        clientId,
        issuer: deps.endpoints.issuer,
        subject: identity.subject,
        email: identity.email ?? saved?.email ?? null,
        tokens,
        lapsed: false,
        registeredAt: saved?.registeredAt ?? new Date(now).toISOString(),
      };
      await writeStore(deps.home, {
        ...current,
        active: clientId,
        accounts: [...current.accounts.filter((existing) => existing.clientId !== clientId), account],
      });
    });

    return { email: identity.email ?? saved?.email ?? null, planEnabled: tokens.scopes.includes(PLAN_SCOPE), registered: saved === undefined };
  };

  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', redirectUri);
    const send = (status: number, title: string, body: string, sent?: () => void): void => {
      response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', connection: 'close' });
      response.end(page(title, body), sent);
    };

    if (request.method !== 'GET') return send(405, 'Not here', 'This address only finishes a sign-in Relay started.');

    if (url.pathname === START_PATH) {
      if (!same(url.searchParams.get('k') ?? '', kickoff)) return send(404, 'Not here', 'This is not the sign-in link Relay printed.');
      response.writeHead(302, { location: authorize.toString(), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      response.end();
      return;
    }

    if (url.pathname !== CALLBACK_PATH) return send(404, 'Not here', 'This address only finishes a sign-in Relay started.');
    if (settled || claimed || !same(url.searchParams.get('state') ?? '', state)) return send(400, 'Not this sign-in', 'This is not the sign-in Relay is waiting for. Start it again from Relay.');
    claimed = true;

    void complete(url.searchParams).then(
      (outcome) => {
        send(
          200,
          outcome.planEnabled ? 'You\'re using your ChatGPT plan' : 'Signed in, without your ChatGPT plan',
          outcome.planEnabled
            ? 'Codex turns in Relay now use your ChatGPT plan. Manage usage in ChatGPT settings. You can close this tab.'
            : 'Relay was not allowed to use your ChatGPT plan, so nothing changes. Start the sign-in again to allow it. You can close this tab.',
          // The page is on its way before the listener goes, so the browser is never left with a reset.
          () => finish(outcome),
        );
      },
      (error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error));
        const reported = failure instanceof ChatgptSignInError ? failure : new ChatgptSignInError('failed', `Relay could not finish the sign-in: ${failure.message}.`);
        send(400, 'Sign-in did not finish', failure instanceof ChatgptSignInError ? failure.message : 'Relay could not reach OpenAI to finish the sign-in. Return to Relay and try again.', () => finish(reported));
      },
    );
  });

  return {
    url: `http://127.0.0.1:${port}${START_PATH}?k=${kickoff}`,
    result,
    cancel: () => finish(new ChatgptSignInError('cancelled', 'Sign-in cancelled.')),
  };
}

/* ------------------------------------------------------------------ */
/* Spending it                                                         */
/* ------------------------------------------------------------------ */

export interface PlanAccess {
  /** For the environment of the process that spends it, and nowhere else. */
  accessToken: string;
  /** When the token stops working, in epoch milliseconds. */
  expiresAt: number;
  email: string | null;
}

function accessOf(account: ChatgptAccount, tokens: ChatgptTokens): PlanAccess {
  return { accessToken: tokens.accessToken, expiresAt: Date.parse(tokens.expiresAt), email: account.email };
}

/**
 * The access token for a turn about to start, renewed first when it would not
 * outlast `minValidMs`.
 *
 * Undefined means "Relay holds no plan sign-in": the caller carries on with
 * whatever the CLI is signed in to. A session that ended on OpenAI's side is
 * the other case and throws, because falling back there would move the bill
 * without telling anyone.
 */
export async function chatgptPlanAccess(options: { minValidMs?: number; deps?: Partial<ChatgptDeps> } = {}): Promise<PlanAccess | undefined> {
  const deps = resolveDeps(options.deps);
  const minValidMs = options.minValidMs ?? 5 * 60_000;

  const usable = (store: ChatgptFile): { account: ChatgptAccount; tokens: ChatgptTokens } | undefined => {
    const account = selected(store);
    if (account === undefined) return undefined;
    if (account.tokens === null) {
      if (account.lapsed) throw new ChatgptSessionError('the session ended');
      return undefined;
    }
    return account.tokens.scopes.includes(PLAN_SCOPE) ? { account, tokens: account.tokens } : undefined;
  };
  const fresh = (tokens: ChatgptTokens): boolean => Date.parse(tokens.expiresAt) - deps.now() > minValidMs;
  const alive = (tokens: ChatgptTokens): boolean => Date.parse(tokens.expiresAt) - deps.now() > CLOCK_SKEW_MS;

  const first = usable(await readStore(deps.home));
  if (first === undefined) return undefined;
  if (fresh(first.tokens)) return accessOf(first.account, first.tokens);
  // OpenAI says when a token may first be renewed. Before then, it is the one to use.
  const tooEarly = first.tokens.earliestRefreshAt !== null && Date.parse(first.tokens.earliestRefreshAt) > deps.now();
  if (tooEarly && alive(first.tokens)) return accessOf(first.account, first.tokens);

  return withStoreLock(deps, async () => {
    const store = await readStore(deps.home);
    const current = usable(store);
    if (current === undefined) return undefined;
    // Another process renewed it while this one waited for the lock.
    if (fresh(current.tokens)) return accessOf(current.account, current.tokens);

    const lapse = async (detail: string, hint?: string): Promise<never> => {
      await writeStore(deps.home, {
        ...store,
        accounts: store.accounts.map((account) => (account.clientId === current.account.clientId ? { ...account, tokens: null, lapsed: true } : account)),
      });
      throw new ChatgptSessionError(detail, hint);
    };

    if (current.tokens.refreshToken === null) {
      return alive(current.tokens) ? accessOf(current.account, current.tokens) : lapse('it could not be renewed');
    }

    let answer: Answer;
    try {
      // `scope` is left out on purpose: that keeps the grant exactly as it was.
      answer = await postForm(deps, deps.endpoints.token, {
        grant_type: 'refresh_token',
        client_id: current.account.clientId,
        refresh_token: current.tokens.refreshToken,
        resource: deps.endpoints.resource,
      });
    } catch (error) {
      if (alive(current.tokens)) return accessOf(current.account, current.tokens);
      throw new ChatgptUnavailableError(`network error reaching OpenAI (${error instanceof Error ? error.message : String(error)})`);
    }

    const renewed = answer.status === 200 ? readTokens(answer.body, deps.now(), current.tokens) : undefined;
    if (renewed !== undefined) {
      await writeStore(deps.home, {
        ...store,
        accounts: store.accounts.map((account) => (account.clientId === current.account.clientId ? { ...account, tokens: renewed } : account)),
      });
      return accessOf(current.account, renewed);
    }

    const code = errorCode(answer.body);
    if (code !== undefined && DEAD_SESSION_CODES.has(code)) {
      return lapse(code, code === 'invalid_client' ? 'Relay\'s registration is gone: run `relay chatgpt login --new`.' : undefined);
    }
    // Not an answer about the session: keep the credential, and the token while it lasts.
    if (alive(current.tokens)) return accessOf(current.account, current.tokens);
    throw new ChatgptUnavailableError(`OpenAI answered ${answer.status}${code === undefined ? '' : ` (${code})`} to a renewal`);
  });
}

/* ------------------------------------------------------------------ */
/* Sign-out                                                            */
/* ------------------------------------------------------------------ */

export interface SignOutResult {
  /** False when there was nothing to sign out of. */
  signedOut: boolean;
  /**
   * Whether OpenAI confirmed the renewable session is over. When it did not,
   * the local tokens are gone all the same, and the person can disconnect
   * Relay in ChatGPT's settings to be sure.
   */
  revoked: boolean;
  email: string | null;
}

/**
 * Ends the renewable session at OpenAI, then forgets the tokens. The
 * registration and the host id stay: signing in again reuses both, which is
 * what keeps the person's usage settings for Relay where they left them.
 */
export async function chatgptSignOut(deps?: Partial<ChatgptDeps>): Promise<SignOutResult> {
  const resolved = resolveDeps(deps);
  const account = selected(await readStore(resolved.home));
  if (account === undefined || (account.tokens === null && !account.lapsed)) return { signedOut: false, revoked: false, email: account?.email ?? null };

  let revoked = account.tokens?.refreshToken == null;
  const refreshToken = account.tokens?.refreshToken;
  if (typeof refreshToken === 'string') {
    for (let attempt = 0; attempt < 3 && !revoked; attempt += 1) {
      if (attempt > 0) await resolved.sleep(500 * 3 ** (attempt - 1));
      try {
        const answer = await postForm(resolved, await revocationEndpoint(resolved), { token: refreshToken, token_type_hint: 'refresh_token', client_id: account.clientId });
        if (answer.status === 200) revoked = true;
        // Anything but a server fault is an answer, and asking again will not change it.
        else if (answer.status < 500) break;
      } catch {
        // A network failure: worth the next attempt.
      }
    }
  }

  await withStoreLock(resolved, async () => {
    const store = await readStore(resolved.home);
    await writeStore(resolved.home, {
      ...store,
      accounts: store.accounts.map((existing) => (existing.clientId === account.clientId ? { ...existing, tokens: null, lapsed: false } : existing)),
    });
  });
  return { signedOut: true, revoked, email: account.email };
}
