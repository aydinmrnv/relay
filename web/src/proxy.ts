import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse, type NextRequest } from 'next/server';
import { ACCOUNTS_ENABLED, GUEST_STUDIO } from '@/server/env';
import { STUDIO_ROUTES } from '@/lib/studio-routes';

/**
 * Clerk's middleware, which keeps each request's session readable by
 * `auth()`, and the door to the studio: its screens need an account, and
 * someone signed out is sent to sign in and then back to where they were
 * going. The site, the docs (`/guide`, `/runners`), shared workflows and the
 * sign-in pages stay public, and each API route checks the session itself.
 *
 * Clerk's middleware runs only with both keys: it throws without them, and a
 * 500 on every route is a worse answer than a closed studio. A deployment
 * without accounts keeps the site up and sends the studio to `/sign-in`,
 * which says sign-in is not available; only a development copy opens the
 * browser-only studio to everyone (`GUEST_STUDIO`).
 */
const clerkReady = (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '').length > 0 && (process.env.CLERK_SECRET_KEY ?? '').length > 0;

/** The studio itself. A new screen under `(app)` is public until it is listed in `STUDIO_ROUTES`. */
const isStudio = createRouteMatcher(STUDIO_ROUTES.map((route) => `${route}(.*)`));

function toSignIn(request: NextRequest): NextResponse {
  // `relay connect`'s pairing link keeps its fragment through this redirect;
  // the sign-in page puts it aside until the studio is reached (see `stashPairing`).
  const signIn = new URL('/sign-in', request.url);
  signIn.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(signIn);
}

const gated = clerkMiddleware(async (auth, request) => {
  if (!isStudio(request)) return;
  if ((await auth()).userId !== null) return;
  return toSignIn(request);
});

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
  matcher: [
    // Everything but Next internals and static files.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
    '/__clerk/:path*',
  ],
};
