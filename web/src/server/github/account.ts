/**
 * The GitHub account a person connected, kept on the server: who it is, and
 * its user token sealed like an app credential (`credentials/crypto.ts`). The
 * token is renewed here when it is near its eight hours, so callers only
 * ever ask for one that works.
 */
import { eq } from 'drizzle-orm';
import { ApiError } from '../errors';
import { seal, unseal } from '../credentials/crypto';
import { getDb } from '../db';
import { githubAccount } from '../db/schema';
import { GITHUB_APP, GITHUB_ENABLED, GITHUB_UNAVAILABLE_REASON, IS_PRODUCTION, type GitHubAppConfig } from '../env';
import { needsRefresh, refreshTokens, revokeToken, type TokenSet } from './oauth';

/** What the seal is bound to besides the person, so this token cannot be opened as an app credential's and the other way round. */
const SEALED_AS = 'github-app';

export interface GitHubAccount {
  githubId: number;
  login: string;
  tokens: TokenSet;
}

/** The app, or a refusal that says connecting GitHub is not offered here. */
export function githubApp(): GitHubAppConfig {
  if (!GITHUB_ENABLED || GITHUB_APP === null) {
    throw new ApiError(503, 'GITHUB_DISABLED', IS_PRODUCTION ? 'Connecting GitHub is not switched on for this server.' : (GITHUB_UNAVAILABLE_REASON ?? 'Connecting GitHub is not switched on for this server.'));
  }
  return GITHUB_APP;
}

export async function saveGitHubAccount(userId: string, account: GitHubAccount): Promise<void> {
  const token = await seal(JSON.stringify(account.tokens), userId, SEALED_AS);
  const db = await getDb();
  await db
    .insert(githubAccount)
    .values({ userId, githubId: account.githubId, login: account.login, token })
    .onConflictDoUpdate({ target: githubAccount.userId, set: { githubId: account.githubId, login: account.login, token, updatedAt: new Date() } });
}

export async function loadGitHubAccount(userId: string): Promise<GitHubAccount | null> {
  const db = await getDb();
  const [row] = await db.select().from(githubAccount).where(eq(githubAccount.userId, userId));
  if (row === undefined) return null;
  let tokens: TokenSet;
  try {
    tokens = JSON.parse((await unseal(row.token, userId, SEALED_AS)).value) as TokenSet;
  } catch {
    // A token this server can no longer open is no connection at all.
    return null;
  }
  return typeof tokens.accessToken === 'string' ? { githubId: row.githubId, login: row.login, tokens } : null;
}

export async function deleteGitHubAccount(userId: string): Promise<void> {
  const db = await getDb();
  await db.delete(githubAccount).where(eq(githubAccount.userId, userId));
}

/** Forgets the account here and ends its token at GitHub. */
export async function disconnectGitHub(userId: string): Promise<void> {
  const account = await loadGitHubAccount(userId);
  await deleteGitHubAccount(userId);
  if (account !== null && GITHUB_APP !== null) await revokeToken(GITHUB_APP, account.tokens.accessToken);
}

/**
 * The connected account with a token that works for the next few minutes,
 * renewed first if it needs it. A token GitHub will not renew means the
 * person has to connect again, and is told so.
 */
export async function connectedAccount(userId: string, config: GitHubAppConfig = githubApp()): Promise<GitHubAccount> {
  const account = await loadGitHubAccount(userId);
  if (account === null) throw new ApiError(409, 'GITHUB_NOT_CONNECTED', 'Connect GitHub first.');
  if (!needsRefresh(account.tokens)) return account;
  const now = Date.now();
  if (account.tokens.refreshToken === null || (account.tokens.refreshExpiresAt !== null && account.tokens.refreshExpiresAt <= now)) {
    await deleteGitHubAccount(userId);
    throw new ApiError(409, 'GITHUB_RECONNECT', 'Your GitHub sign-in ran out. Connect GitHub again.');
  }
  let tokens: TokenSet;
  try {
    tokens = await refreshTokens(config, account.tokens.refreshToken, now);
  } catch (error) {
    // A refused refresh token will be refused again: forget it, rather than ask GitHub on every request.
    if (error instanceof ApiError && error.code === 'GITHUB_RECONNECT') await deleteGitHubAccount(userId);
    throw error;
  }
  const renewed = { ...account, tokens };
  await saveGitHubAccount(userId, renewed);
  return renewed;
}
