import { createHmac, createPublicKey, createVerify, randomBytes, timingSafeEqual, type JsonWebKey, type KeyObject } from 'node:crypto';

/**
 * Who is calling the hub.
 *
 * Two kinds of caller, two kinds of proof:
 *
 *   - **A runner** presents a token the hub made for it: which machine it is
 *     and whose, signed with the hub's secret. The signature says the hub made
 *     it; it does not say the token is still good. That is the fleet's to
 *     decide (`Fleet.admits`): a machine the hub manages has exactly one
 *     current token, named by its `id`, re-issued every time the machine is
 *     made or started and recorded on the machine itself, so a hub that
 *     restarts with an empty memory reads it back from the cloud. A runner
 *     someone starts themselves gets a token with an expiry instead.
 *   - **A person in the studio** presents their Clerk session token, a
 *     short-lived JWT the browser already has. The hub checks it against the
 *     Clerk instance's published keys; there is no secret shared with the
 *     studio's server and no token-minting route to guard.
 */

const RUNNER_TOKEN_VERSION = 'rr2';
/** A token says when it was made; a hub and a runner may disagree about now by this much. */
const CLOCK_LEEWAY_MS = 5 * 60_000;
/**
 * A managed machine's token is replaced at its next start, long before this.
 * The expiry is the backstop for a token that somehow is not.
 */
const MANAGED_TTL_MS = 30 * 24 * 60 * 60_000;
export const DEFAULT_OWN_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;

export interface RunnerIdentity {
  /** The machine's name: the VM's, for a managed runner. */
  runner: string;
  /** The Clerk user id the runner belongs to. */
  userId: string;
}

/**
 * `managed`: for a machine the hub made. Good only while it is that machine's
 * current token. `own`: minted by the operator for a runner someone starts
 * themselves. Good until it expires.
 */
export type RunnerTokenKind = 'managed' | 'own';

export interface RunnerToken extends RunnerIdentity {
  kind: RunnerTokenKind;
  /** Random, per token. What makes two tokens for the same machine different, and what the fleet compares. */
  id: string;
  /** Milliseconds since the epoch, to the second. */
  issuedAt: number;
  expiresAt: number;
}

export interface MintedRunnerToken extends RunnerToken {
  token: string;
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(`relay-runner:${RUNNER_TOKEN_VERSION}:${payload}`).digest('base64url');
}

/**
 * Makes a runner token. No two are the same, even for the same machine a
 * moment apart: each carries a fresh random id and the time it was made, so
 * a token cannot be worked out from knowing whose machine it is for, and an
 * old one can be told from the current one.
 */
export function mintRunnerToken(secret: string, identity: RunnerIdentity, options: { kind?: RunnerTokenKind; ttlMs?: number; now?: number } = {}): MintedRunnerToken {
  const kind = options.kind ?? 'own';
  const iat = Math.floor((options.now ?? Date.now()) / 1000);
  const exp = iat + Math.max(1, Math.floor((options.ttlMs ?? (kind === 'managed' ? MANAGED_TTL_MS : DEFAULT_OWN_TOKEN_TTL_MS)) / 1000));
  const id = randomBytes(16).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ r: identity.runner, u: identity.userId, k: kind === 'managed' ? 'm' : 'o', n: id, iat, exp })).toString('base64url');
  return { runner: identity.runner, userId: identity.userId, kind, id, issuedAt: iat * 1000, expiresAt: exp * 1000, token: `${RUNNER_TOKEN_VERSION}.${payload}.${sign(secret, payload)}` };
}

/**
 * Reads a runner token: null unless one of the hub's secrets signed it, it
 * is well formed, and it has not expired. The first secret is the current
 * one; the rest are earlier secrets still honoured while the tokens they
 * signed are replaced (`RELAY_HUB_SECRET_PREVIOUS`). Whether the token is
 * still its machine's current one is not decided here.
 */
export function verifyRunnerToken(secrets: string | readonly string[], token: string | null | undefined, now: number = Date.now()): RunnerToken | null {
  if (typeof token !== 'string') return null;
  const [version, payload, signature, extra] = token.split('.');
  if (version !== RUNNER_TOKEN_VERSION || payload === undefined || signature === undefined || extra !== undefined) return null;
  const presented = Buffer.from(signature);
  let signed = false;
  // Every secret is tried whichever matches, so how long this takes says nothing about which did.
  for (const secret of typeof secrets === 'string' ? [secrets] : secrets) {
    const expected = Buffer.from(sign(secret, payload));
    if (expected.length === presented.length && timingSafeEqual(expected, presented)) signed = true;
  }
  if (!signed) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown> | null;
    if (parsed === null || typeof parsed !== 'object') return null;
    const { r, u, k, n, iat, exp } = parsed;
    if (typeof r !== 'string' || typeof u !== 'string' || r.length === 0 || u.length === 0) return null;
    if ((k !== 'm' && k !== 'o') || typeof n !== 'string' || n.length < 16) return null;
    if (typeof iat !== 'number' || typeof exp !== 'number' || !Number.isFinite(iat) || !Number.isFinite(exp)) return null;
    if (iat * 1000 > now + CLOCK_LEEWAY_MS || exp * 1000 <= now) return null;
    return { runner: r, userId: u, kind: k === 'm' ? 'managed' : 'own', id: n, issuedAt: iat * 1000, expiresAt: exp * 1000 };
  } catch {
    return null;
  }
}

export function bearer(header: string | undefined): string | null {
  if (header === undefined || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/* ------------------------------------------------------------------ */
/* Clerk session tokens                                                */
/* ------------------------------------------------------------------ */

/** Clerk's frontend API host is in the publishable key: `pk_test_<base64("host$")>`. */
export function clerkIssuerFromPublishableKey(key: string): string {
  const match = key.trim().match(/^pk_(?:test|live)_(.+)$/);
  if (match === null) throw new Error('That is not a Clerk publishable key.');
  const host = Buffer.from(match[1]!, 'base64').toString('utf8').replace(/\$$/, '');
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error('That Clerk publishable key does not name a host.');
  return `https://${host}`;
}

export interface SessionClaims {
  userId: string;
  sessionId: string | null;
  expiresAt: number;
}

export class AuthError extends Error {}

interface Jwk extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

export interface ClerkVerifierOptions {
  issuer: string;
  /** Origins the token may have been issued to (its `azp`). Empty accepts any. */
  authorizedParties: readonly string[];
  /** Where the keys are; defaults to the issuer's `/.well-known/jwks.json`. */
  jwksUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Clock skew allowed on `exp` and `nbf`, in seconds. */
  leewaySeconds?: number;
}

/**
 * Verifies Clerk session JWTs (RS256) against the instance's JWKS, which is
 * fetched once and again only when a token names a key the hub has not seen —
 * at most once a minute, so a stream of forged `kid`s cannot make the hub
 * hammer Clerk.
 */
export class ClerkVerifier {
  private readonly options: ClerkVerifierOptions;
  private readonly fetchImpl: typeof fetch;
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(options: ClerkVerifierOptions) {
    this.options = { ...options, issuer: options.issuer.replace(/\/+$/, '') };
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  async refresh(): Promise<void> {
    if (this.inflight !== null) return this.inflight;
    this.inflight = (async () => {
      try {
        const url = this.options.jwksUrl ?? `${this.options.issuer}/.well-known/jwks.json`;
        const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(8_000) });
        if (!response.ok) throw new Error(`JWKS answered ${response.status}`);
        const body = (await response.json()) as { keys?: Jwk[] };
        const next = new Map<string, KeyObject>();
        for (const jwk of body.keys ?? []) {
          if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
          next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
        }
        if (next.size > 0) this.keys = next;
      } finally {
        this.fetchedAt = this.now();
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  private async key(kid: string): Promise<KeyObject | undefined> {
    const known = this.keys.get(kid);
    if (known !== undefined) return known;
    if (this.now() - this.fetchedAt > 60_000) await this.refresh().catch(() => undefined);
    return this.keys.get(kid);
  }

  async verify(token: string | null): Promise<SessionClaims> {
    if (token === null) throw new AuthError('Sign in to use Relay Cloud.');
    const parts = token.split('.');
    if (parts.length !== 3) throw new AuthError('That is not a session token.');
    const [head, body, signature] = parts as [string, string, string];
    let header: { alg?: unknown; kid?: unknown };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as { alg?: unknown; kid?: unknown };
      claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new AuthError('That is not a session token.');
    }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new AuthError('That session token is not signed the way Clerk signs.');
    const key = await this.key(header.kid);
    if (key === undefined) throw new AuthError('That session token was not signed by this studio.');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${head}.${body}`);
    if (!verifier.verify(key, Buffer.from(signature, 'base64url'))) throw new AuthError('That session token was not signed by this studio.');

    const now = Math.floor(this.now() / 1000);
    const leeway = this.options.leewaySeconds ?? 10;
    if (typeof claims['exp'] !== 'number' || claims['exp'] + leeway < now) throw new AuthError('Your session expired. Reload the studio.');
    if (typeof claims['nbf'] === 'number' && claims['nbf'] - leeway > now) throw new AuthError('That session token is not valid yet.');
    if (claims['iss'] !== this.options.issuer) throw new AuthError('That session token is from another Clerk instance.');
    const azp = claims['azp'];
    if (this.options.authorizedParties.length > 0 && typeof azp === 'string' && !this.options.authorizedParties.includes(azp)) {
      throw new AuthError('That session token was issued to another site.');
    }
    const sub = claims['sub'];
    if (typeof sub !== 'string' || sub.length === 0) throw new AuthError('That session token names no user.');
    return { userId: sub, sessionId: typeof claims['sid'] === 'string' ? claims['sid'] : null, expiresAt: claims['exp'] * 1000 };
  }
}
