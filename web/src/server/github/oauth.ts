/**
 * Signing in to the GitHub App: GitHub's web flow with a `state` and PKCE,
 * and the user tokens it hands back, which last eight hours and are renewed
 * with a refresh token that lasts six months.
 *
 * Not the "authorize during installation" shortcut: GitHub sends that one to
 * the callback with no `state`, so a page on another site could finish it
 * with a code of the attacker's. Installing is a separate visit, and what it
 * installed is read back with the person's own token, never taken from the
 * redirect (see `server/github/repositories.ts`).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../errors';
import type { GitHubAppConfig } from '../env';

export interface TokenSet {
  accessToken: string;
  /** Epoch milliseconds, or `null` for a token that does not expire (an app with expiry switched off). */
  expiresAt: number | null;
  refreshToken: string | null;
  refreshExpiresAt: number | null;
}

/** A random value for `state` and for the PKCE verifier: 32 bytes, base64url. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The PKCE challenge for a verifier (S256). */
export function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Whether two strings are the same, in time that does not depend on where they differ. */
export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export function authorizeUrl(config: GitHubAppConfig, input: { state: string; redirectUri: string; challenge: string }): string {
  const url = new URL(`${config.web}/login/oauth/authorize`);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** Where a person installs the app on an account and picks its repositories. */
export function installUrl(config: GitHubAppConfig): string {
  return `${config.web}/apps/${config.slug}/installations/new`;
}

async function tokenRequest(config: GitHubAppConfig, form: Record<string, string>, now: number): Promise<TokenSet> {
  let response: Response;
  try {
    response = await fetch(`${config.web}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'relay-studio' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...form }).toString(),
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ApiError(502, 'GITHUB_UNREACHABLE', 'GitHub could not be reached. Try again in a minute.');
  }
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  // GitHub answers a refused code with 200 and an `error`, not with an error status.
  if (data === null || typeof data['access_token'] !== 'string' || data['access_token'].length === 0) {
    const reason = typeof data?.['error'] === 'string' ? data['error'] : `HTTP ${response.status}`;
    throw new ApiError(409, 'GITHUB_RECONNECT', `GitHub did not hand over a sign-in (${reason}). Connect GitHub again.`);
  }
  const seconds = (key: string): number | null => (typeof data[key] === 'number' && Number.isFinite(data[key]) && data[key] > 0 ? (data[key] as number) : null);
  const expiresIn = seconds('expires_in');
  const refreshIn = seconds('refresh_token_expires_in');
  return {
    accessToken: data['access_token'],
    expiresAt: expiresIn === null ? null : now + expiresIn * 1000,
    refreshToken: typeof data['refresh_token'] === 'string' && data['refresh_token'].length > 0 ? data['refresh_token'] : null,
    refreshExpiresAt: refreshIn === null ? null : now + refreshIn * 1000,
  };
}

export function exchangeCode(config: GitHubAppConfig, input: { code: string; redirectUri: string; verifier: string }, now = Date.now()): Promise<TokenSet> {
  return tokenRequest(config, { code: input.code, redirect_uri: input.redirectUri, code_verifier: input.verifier }, now);
}

export function refreshTokens(config: GitHubAppConfig, refreshToken: string, now = Date.now()): Promise<TokenSet> {
  return tokenRequest(config, { grant_type: 'refresh_token', refresh_token: refreshToken }, now);
}

/** Whether a token should be renewed before it is used: expired, or within five minutes of it. */
export function needsRefresh(tokens: TokenSet, now = Date.now()): boolean {
  return tokens.expiresAt !== null && tokens.expiresAt - now < 5 * 60_000;
}

/**
 * Ends a user token at GitHub. Best effort: the person asked to disconnect,
 * and the row is gone either way. The app's authorization stays listed in
 * their GitHub settings until they revoke it there.
 */
export async function revokeToken(config: GitHubAppConfig, accessToken: string): Promise<void> {
  try {
    await fetch(`${config.api}/applications/${encodeURIComponent(config.clientId)}/token`, {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
        'User-Agent': 'relay-studio',
      },
      body: JSON.stringify({ access_token: accessToken }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Nothing to do about it from here.
  }
}
