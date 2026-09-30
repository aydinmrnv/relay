import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { ACCOUNTS_ENABLED } from '@/server/env';

/**
 * Clerk's middleware, which keeps each request's session readable by
 * `auth()`, and the door to the studio: where this deployment has accounts,
 * the studio's screens need one, and someone signed out is sent to sign in
 * and then back to where they were going. The site, the docs (`/guide`,
 * `/runners`), shared workflows and the sign-in pages stay public, and each
 * API route checks the session itself.
 *
 * It runs only with both keys: the middleware throws without them, and a 500
 * on every route is a worse answer than a studio with no accounts. A checkout
 * without keys serves the browser-only studio to everyone instead, and
 * `/sign-in` says accounts are off here, and why.
 */
const clerkReady = (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '').length > 0 && (process.env.CLERK_SECRET_KEY ?? '').length > 0;

/** The studio itself. A new screen under `(app)` is public until it is listed here. */
const isStudio = createRouteMatcher(['/dashboard(.*)', '/workflows(.*)', '/runs(.*)', '/templates(.*)', '/integrations(.*)', '/settings(.*)', '/connect(.*)']);

const gated = clerkMiddleware(async (auth, request) => {
  if (!isStudio(request)) return;
  if ((await auth()).userId !== null) return;
  // `relay connect`'s pairing link keeps its fragment through this redirect;
  // the sign-in page puts it aside until the studio is reached (see `stashPairing`).
  const signIn = new URL('/sign-in', request.url);
  signIn.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(signIn);
});

export default ACCOUNTS_ENABLED ? gated : clerkReady ? clerkMiddleware() : () => NextResponse.next();

export const config = {
  matcher: [
    // Everything but Next internals and static files.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
    '/__clerk/:path*',
  ],
};
