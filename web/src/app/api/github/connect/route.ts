import { NextResponse, type NextRequest } from 'next/server';
import { safeNext } from '@/lib/safe-next';
import { getUserId } from '@/server/auth';
import { GITHUB_APP, GITHUB_ENABLED } from '@/server/env';
import { backTo, callbackUrl, requestOrigin, SIGN_IN_COOKIE, writeCookie, type SignInCookie } from '@/server/github/flow';
import { authorizeUrl, challengeOf, randomToken } from '@/server/github/oauth';
import { rateLimit, LIMITS } from '@/server/rate-limit';

/**
 * Starts signing in to the GitHub App: a navigation, not a fetch, so every
 * answer is a redirect. `next` is where to come back to, on this site.
 */
export async function GET(request: NextRequest) {
  const next = safeNext(request.nextUrl.searchParams.get('next'), '/onboarding');
  if (!GITHUB_ENABLED || GITHUB_APP === null) return backTo(request, next, 'unavailable');
  const user = await getUserId();
  if (user === null) {
    const signIn = new URL('/sign-in', requestOrigin(request));
    signIn.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(signIn, { status: 303 });
  }
  try {
    await rateLimit(LIMITS.github, user);
  } catch {
    return backTo(request, next, 'slow-down');
  }
  const cookie: SignInCookie = { state: randomToken(), verifier: randomToken(), next, user };
  const response = NextResponse.redirect(authorizeUrl(GITHUB_APP, { state: cookie.state, redirectUri: callbackUrl(request), challenge: challengeOf(cookie.verifier) }), { status: 303 });
  // Ten minutes to sign in on github.com, then the attempt is void.
  writeCookie(response, request, SIGN_IN_COOKIE, cookie, 600);
  return response;
}
