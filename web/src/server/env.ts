/**
 * What this deployment can do, read once from the environment.
 *
 * Accounts need two things: Clerk, for who someone is, and a database, for
 * their workflows. Locally the database need not be configured — it is an
 * embedded Postgres (PGlite) in `web/.data/` — but Clerk cannot: its
 * middleware throws without keys. Without them a development copy runs as
 * the browser-only studio, and a production one keeps its site up but its
 * studio closed (see `GUEST_STUDIO`), with a line in the log saying why,
 * rather than failing every request. `npx clerk env pull` writes the keys to
 * `.env.local`; after that accounts work in development too.
 */
import type { AuthCapabilities } from '@/lib/cloud/types';

const PRODUCTION = process.env.NODE_ENV === 'production';

/** A connection string for any Postgres (Neon, Supabase, RDS, local). */
const DATABASE_URL = (process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? '').trim();

/**
 * Where the embedded database lives when there is no DATABASE_URL. Used in
 * development, or in production only when PGLITE_DIR is set explicitly — a
 * single long-lived server with a disk, never a serverless platform.
 */
const PGLITE_DIR_ENV = (process.env.PGLITE_DIR ?? '').trim();
export const PGLITE_DIR = PGLITE_DIR_ENV.length > 0 ? PGLITE_DIR_ENV : '.data/pglite';

export type DatabaseKind = 'postgres' | 'pglite' | 'none';

export const DATABASE: { kind: DatabaseKind; url: string } =
  DATABASE_URL.length > 0 ? { kind: 'postgres', url: DATABASE_URL } : !PRODUCTION || PGLITE_DIR_ENV.length > 0 ? { kind: 'pglite', url: '' } : { kind: 'none', url: '' };

const CLERK_KEYS = (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '').trim().length > 0 && (process.env.CLERK_SECRET_KEY ?? '').trim().length > 0;

/**
 * Whether Clerk can run. The keys are required in every environment: the
 * middleware throws without them, so "accounts off" is the honest answer.
 * `npx clerk env pull` writes them to `.env.local` for development.
 */
export const CLERK_CONFIGURED = CLERK_KEYS;

/** Why accounts are off, for the log and the settings page. `null` when they are on. */
export const ACCOUNTS_UNAVAILABLE_REASON: string | null =
  DATABASE.kind === 'none'
    ? 'No database: set DATABASE_URL to a Postgres connection string.'
    : !CLERK_CONFIGURED
      ? 'No Clerk keys: set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY (clerk env pull).'
      : null;

export const ACCOUNTS_ENABLED = ACCOUNTS_UNAVAILABLE_REASON === null;

/**
 * Whether the studio opens without an account. Only in development, so
 * `npm run dev` works before `clerk env pull`: everywhere else the studio
 * needs a sign-in, and a deployment missing its keys or its database is
 * closed until they are set rather than open to anyone.
 */
export const GUEST_STUDIO = !ACCOUNTS_ENABLED && !PRODUCTION;

/**
 * The public origin, for absolute links (social cards, the sitemap).
 * Explicit configuration wins; on Vercel the production domain is known.
 */
export const PUBLIC_URL: string | undefined = (() => {
  const explicit = (process.env.NEXT_PUBLIC_SITE_URL ?? '').trim();
  if (explicit.length > 0) return explicit.replace(/\/+$/, '');
  const vercel = (process.env.VERCEL_PROJECT_PRODUCTION_URL ?? '').trim();
  if (vercel.length > 0 && process.env.VERCEL_ENV === 'production') return `https://${vercel}`;
  return undefined;
})();

/**
 * The Relay Cloud hub, when this deployment has one: where a signed-in
 * person's cloud machine is reached. The browser calls it directly with its
 * Clerk session token; nothing here holds a secret for it.
 */
export const CLOUD_HUB_URL: string | null = (() => {
  const raw = (process.env.RELAY_CLOUD_HUB_URL ?? '').trim();
  if (raw.length === 0) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || (!PRODUCTION && url.protocol === 'http:') ? url.toString().replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
})();

/** What the browser is told about accounts: whether they exist here, nothing secret. */
export function authCapabilities(): AuthCapabilities {
  return { enabled: ACCOUNTS_ENABLED, guests: GUEST_STUDIO, reason: PRODUCTION ? null : ACCOUNTS_UNAVAILABLE_REASON, cloudHub: ACCOUNTS_ENABLED ? CLOUD_HUB_URL : null };
}
