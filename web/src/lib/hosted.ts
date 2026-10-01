/**
 * A build served from somewhere other than the visitor's own computer. It
 * changes what the studio says, not what it can do: a line at the top says
 * test runs are played back in the browser and points at the page for
 * choosing a runner. Pairing works the same as on a local build; the browser
 * talks to `relay connect` on 127.0.0.1 directly, never through this server.
 *
 * On by default for any build Vercel runs (it exposes NEXT_PUBLIC_VERCEL_ENV
 * to every one, and no Vercel URL has a visitor's CLI behind it); anywhere
 * else, build with NEXT_PUBLIC_HOSTED_DEMO=1.
 */
export const HOSTED_DEMO = process.env.NEXT_PUBLIC_HOSTED_DEMO === '1' || process.env.NEXT_PUBLIC_VERCEL_ENV !== undefined;
