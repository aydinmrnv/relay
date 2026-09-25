import { createHmac, createPublicKey, createVerify, timingSafeEqual, type JsonWebKey, type KeyObject } from 'node:crypto';

/**
 * Who is calling the hub.
 *
 * Two kinds of caller, two kinds of proof:
 *
 *   - **A runner** presents a token the hub made for it: which machine it is
 *     and whose, signed with the hub's secret. The hub keeps no list of
 *     tokens — it checks the signature, and the identity is in the token — so
 *     a hub that restarts with an empty memory still knows every runner.
 *     Managed runners get theirs through the VM's user data, never on disk.
 *   - **A person in the studio** presents their Clerk session token, a
 *     short-lived JWT the browser already has. The hub checks it against the
 *     Clerk instance's published keys; there is no secret shared with the
 *     studio's server and no token-minting route to guard.
 */

const RUNNER_TOKEN_VERSION = 'rr1';

export interface RunnerIdentity {
  /** The machine's name: the VM's, for a managed runner. */
  runner: string;
  /** The Clerk user id the runner belongs to. */
  userId: string;
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(`relay-runner:${payload}`).digest('base64url');
}

export function mintRunnerToken(secret: string, identity: RunnerIdentity): string {
  const payload = Buffer.from(JSON.stringify({ r: identity.runner, u: identity.userId })).toString('base64url');
  return `${RUNNER_TOKEN_VERSION}.${payload}.${sign(secret, payload)}`;
}

export function verifyRunnerToken(secret: string, token: string | null | undefined): RunnerIdentity | null {
  if (typeof token !== 'string') return null;
  const [version, payload, signature, extra] = token.split('.');
  if (version !== RUNNER_TOKEN_VERSION || payload === undefined || signature === undefined || extra !== undefined) return null;
  const expected = Buffer.from(sign(secret, payload));
  const presented = Buffer.from(signature);
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { r?: unknown; u?: unknown };
    if (typeof parsed.r !== 'string' || typeof parsed.u !== 'string' || parsed.r.length === 0 || parsed.u.length === 0) return null;
    return { runner: parsed.r, userId: parsed.u };
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
