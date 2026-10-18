import type { NextRequest } from 'next/server';
import { ApiError, describeForLog } from '@/server/api';
import { getUserId } from '@/server/auth';
import { GITHUB_APP, GITHUB_ENABLED } from '@/server/env';
import { saveGitHubAccount } from '@/server/github/account';
import { backTo, callbackUrl, clearCookie, readCookie, SIGN_IN_COOKIE, type SignInCookie } from '@/server/github/flow';
import { exchangeCode, sameSecret } from '@/server/github/oauth';
import { viewer } from '@/server/github/repositories';

/**
 * Where github.com sends the person back after signing in to the app. The
 * `state` must be the one this browser was given, for the account that is
 * signed in now; anything else is somebody else's attempt, and is refused.
 */
export async function GET(request: NextRequest) {
  const saved = readCookie<SignInCookie>(request, SIGN_IN_COOKIE, ['state', 'verifier', 'next', 'user']);
  const next = saved?.next ?? '/onboarding';
  const finish = (outcome: string) => {
    const response = backTo(request, next, outcome);
    clearCookie(response, SIGN_IN_COOKIE);
    return response;
  };
  if (!GITHUB_ENABLED || GITHUB_APP === null) return finish('unavailable');
  if (saved === null) return finish('expired');
  const params = request.nextUrl.searchParams;
  if (params.get('error') !== null) return finish('denied');
  const state = params.get('state') ?? '';
  const code = params.get('code') ?? '';
  if (!sameSecret(state, saved.state) || code.length === 0 || code.length > 200) return finish('expired');
  const user = await getUserId();
  if (user === null || user !== saved.user) return finish('expired');
  try {
    const tokens = await exchangeCode(GITHUB_APP, { code, redirectUri: callbackUrl(request), verifier: saved.verifier });
    const who = await viewer(GITHUB_APP, tokens.accessToken);
    await saveGitHubAccount(user, { githubId: who.id, login: who.login, tokens });
    return finish('connected');
  } catch (error) {
    if (!(error instanceof ApiError)) console.error('[github] connecting failed:', describeForLog(error));
    return finish('error');
  }
}
