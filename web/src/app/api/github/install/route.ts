import { NextResponse, type NextRequest } from 'next/server';
import { safeNext } from '@/lib/safe-next';
import { getUserId } from '@/server/auth';
import { GITHUB_APP, GITHUB_ENABLED } from '@/server/env';
import { backTo, requestOrigin, RETURN_COOKIE, writeCookie, type ReturnCookie } from '@/server/github/flow';
import { installUrl } from '@/server/github/oauth';

/**
 * Sends the person to install the app on an account, or to change which of
 * its repositories it may use, remembering where to bring them back to.
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
  const response = NextResponse.redirect(installUrl(GITHUB_APP), { status: 303 });
  // Choosing repositories can take a while, and an organisation's owner may have to approve it.
  writeCookie(response, request, RETURN_COOKIE, { next, user } satisfies ReturnCookie, 3600);
  return response;
}
