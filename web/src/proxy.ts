import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse, type NextRequest } from 'next/server';
import { ACCOUNTS_ENABLED, GUEST_STUDIO, PUBLIC_URL } from '@/server/env';
import { STUDIO_ROUTES } from '@/lib/studio-routes';

/**
 * Clerk's middleware, which keeps each request's session readable by
 * `auth()`, and the door to the studio: its screens need an account, and
 * someone signed out is sent to sign in and then back to where they were
 * going.
 *
 * It runs only where a session matters: the studio's screens, the sign-in
 * pages and the API (see `config.matcher`). The site, the docs, shared
 * workflows, `robots.txt` and the sitemap are public and never pass through
 * it. On a Clerk development instance the middleware answers a first visit
 * with a redirect through Clerk's own domain; on a public page that redirect
 * is what a crawler or a link preview would get instead of the page.
 *
 * Clerk's middleware runs only with both keys: it throws without them, and a
 * 500 on every route is a worse answer than a closed studio. A deployment
 * without accounts keeps the site up and sends the studio to `/sign-in`,
 * which says sign-in is not available; only a development copy opens the
 * browser-only studio to everyone (`GUEST_STUDIO`).
 */
const clerkReady = (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '').length > 0 && (process.env.CLERK_SECRET_KEY ?? '').length > 0;

/** The studio itself. A new screen under `(app)` is public until it is listed in `STUDIO_ROUTES` and in the matcher below. */
const isStudio = createRouteMatcher(STUDIO_ROUTES.map((route) => `${route}(.*)`));

/**
 * The origins a session token may have been issued for. A token minted for
 * another site that shares this Clerk instance is refused. Only set where the
 * public origin is known; a preview deployment has an origin of its own, and
 * is added beside it.
 */
const authorizedParties = (() => {
  if (PUBLIC_URL === undefined) return undefined;
  const origins = [PUBLIC_URL, process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined, process.env.VERCEL_BRANCH_URL ? `https://${process.env.VERCEL_BRANCH_URL}` : undefined];
  return [...new Set(origins.filter((origin): origin is string => origin !== undefined))];
})();

function toSignIn(request: NextRequest): NextResponse {
  // `relay connect`'s pairing link keeps its fragment through this redirect;
  // the sign-in page puts it aside until the studio is reached (see `stashPairing`).
  const signIn = new URL('/sign-in', request.url);
  signIn.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(signIn);
}

const gated = clerkMiddleware(
  async (auth, request) => {
    if (!isStudio(request)) return;
    if ((await auth()).userId !== null) return;
    return toSignIn(request);
  },
  authorizedParties === undefined ? {} : { authorizedParties },
);

/** No accounts here: the studio is open in development and closed anywhere else. */
function withoutAccounts(request: NextRequest): NextResponse | undefined {
  if (GUEST_STUDIO || !isStudio(request)) return undefined;
  return toSignIn(request);
}

export default ACCOUNTS_ENABLED
  ? gated
  : clerkReady
    ? clerkMiddleware((_auth, request) => withoutAccounts(request))
    : (request: NextRequest) => withoutAccounts(request) ?? NextResponse.next();

export const config = {
  // Written out, because this list is read at build time and cannot be computed: keep it in step with `STUDIO_ROUTES`.
  matcher: [
    '/dashboard/:path*',
    '/projects/:path*',
    '/workflows/:path*',
    '/runs/:path*',
    '/templates/:path*',
    '/integrations/:path*',
    '/settings/:path*',
    '/connect/:path*',
    '/onboarding/:path*',
    '/sign-in/:path*',
    '/sign-up/:path*',
    '/(api|trpc)(.*)',
    '/__clerk/:path*',
  ],
};
