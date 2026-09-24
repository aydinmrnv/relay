/**
 * The public demo build. It is the same studio served from someone else's
 * computer, so there is no CLI on the visitor's machine it could ask: the
 * local bridge is switched off on the server and never called from the
 * browser, rather than left to fail, and the studio says it is a demo.
 * Everything else — the builder, validation, export, simulated runs — already
 * runs entirely in the browser.
 *
 * On by default for any build Vercel runs (it exposes NEXT_PUBLIC_VERCEL_ENV
 * to every one, and no Vercel URL has a visitor's CLI behind it); anywhere
 * else, build with NEXT_PUBLIC_HOSTED_DEMO=1.
 */
export const HOSTED_DEMO = process.env.NEXT_PUBLIC_HOSTED_DEMO === '1' || process.env.NEXT_PUBLIC_VERCEL_ENV !== undefined;
