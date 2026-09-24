/**
 * The public demo build: the same studio served from someone else's computer.
 * It changes what the studio says, not what it can do — a first visit is
 * seeded with the starter workflows, and a banner says test runs are
 * simulated. A visitor who runs `relay connect` pairs this build with their
 * own machine exactly as they would a local one; the browser talks to the
 * companion on 127.0.0.1 directly, never through this server.
 *
 * On by default for any build Vercel runs (it exposes NEXT_PUBLIC_VERCEL_ENV
 * to every one, and no Vercel URL has a visitor's CLI behind it); anywhere
 * else, build with NEXT_PUBLIC_HOSTED_DEMO=1.
 */
export const HOSTED_DEMO = process.env.NEXT_PUBLIC_HOSTED_DEMO === '1' || process.env.NEXT_PUBLIC_VERCEL_ENV !== undefined;
