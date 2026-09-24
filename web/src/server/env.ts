/**
 * What this deployment can do, read once from the environment.
 *
 * Accounts need two things: Clerk, for who someone is, and a database, for
 * their workflows. Locally neither has to be configured — the database is an
 * embedded Postgres (PGlite) in `web/.data/`, and without Clerk keys the
 * Clerk SDK runs in keyless mode with a temporary development app. In
 * production both must be set, and a deployment that lacks either keeps
 * working as the browser-only studio, with sign-up turned off and a line in
 * the log saying why, rather than failing every request.
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
 * Whether Clerk can run: with its keys, or in development without them,
 * where the SDK provisions a temporary keyless app. CI builds are
 * production builds without keys, so they build the browser-only studio.
 */
export const CLERK_CONFIGURED = CLERK_KEYS || (!PRODUCTION && process.env.CI === undefined);

/** Why accounts are off, for the log and the settings page. `null` when they are on. */
export const ACCOUNTS_UNAVAILABLE_REASON: string | null =
  DATABASE.kind === 'none'
    ? 'No database: set DATABASE_URL to a Postgres connection string.'
    : !CLERK_CONFIGURED
      ? 'No Clerk keys: set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY (clerk env pull).'
      : null;

export const ACCOUNTS_ENABLED = ACCOUNTS_UNAVAILABLE_REASON === null;

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

/** What the browser is told about accounts: whether they exist here, nothing secret. */
export function authCapabilities(): AuthCapabilities {
  return { enabled: ACCOUNTS_ENABLED, reason: PRODUCTION ? null : ACCOUNTS_UNAVAILABLE_REASON };
}
