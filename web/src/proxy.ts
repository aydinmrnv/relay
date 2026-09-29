import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

/**
 * Clerk's middleware, which keeps each request's session readable by
 * `auth()`. Pages and routes stay public here — the studio works for guests —
 * and each API route checks the session itself.
 *
 * It runs only with both keys: the middleware throws without them, and a 500
 * on every route is a worse answer than a studio with no accounts. A checkout
 * without keys serves the browser-only studio instead, and `/sign-in` says
 * accounts are off here, and why.
 */
const clerkReady = (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '').length > 0 && (process.env.CLERK_SECRET_KEY ?? '').length > 0;

export default clerkReady ? clerkMiddleware() : () => NextResponse.next();

export const config = {
  matcher: [
    // Everything but Next internals and static files.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
    '/__clerk/:path*',
  ],
};
