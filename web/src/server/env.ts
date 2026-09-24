/**
 * What this deployment can do, read once from the environment.
 *
 * Accounts need two things: a database and a secret to sign sessions with.
 * Locally neither has to be configured — the database is an embedded
 * Postgres (PGlite) in `web/.data/`, and the secret falls back to a fixed
 * development value. In production both must be set, and a deployment that
 * lacks either keeps working as the browser-only studio, with sign-up turned
 * off and a line in the log saying why, rather than failing every request.
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

const SECRET = (process.env.BETTER_AUTH_SECRET ?? process.env.AUTH_SECRET ?? '').trim();
const DEV_SECRET = 'relay-development-secret-do-not-use-in-production-0123456789';

export type DatabaseKind = 'postgres' | 'pglite' | 'none';

export const DATABASE: { kind: DatabaseKind; url: string } =
  DATABASE_URL.length > 0 ? { kind: 'postgres', url: DATABASE_URL } : !PRODUCTION || PGLITE_DIR_ENV.length > 0 ? { kind: 'pglite', url: '' } : { kind: 'none', url: '' };

export const AUTH_SECRET: string | null = SECRET.length >= 32 ? SECRET : PRODUCTION ? null : DEV_SECRET;

/** Why accounts are off, for the log and the settings page. `null` when they are on. */
export const ACCOUNTS_UNAVAILABLE_REASON: string | null =
  DATABASE.kind === 'none'
    ? 'No database: set DATABASE_URL to a Postgres connection string.'
    : AUTH_SECRET === null
      ? 'No session secret: set BETTER_AUTH_SECRET to 32 or more random characters (openssl rand -base64 32).'
      : null;

export const ACCOUNTS_ENABLED = ACCOUNTS_UNAVAILABLE_REASON === null;

const GITHUB_ID = (process.env.GITHUB_CLIENT_ID ?? '').trim();
const GITHUB_SECRET = (process.env.GITHUB_CLIENT_SECRET ?? '').trim();
export const GITHUB_OAUTH = GITHUB_ID.length > 0 && GITHUB_SECRET.length > 0 ? { clientId: GITHUB_ID, clientSecret: GITHUB_SECRET } : null;

const RESEND_KEY = (process.env.RESEND_API_KEY ?? '').trim();
/** Outgoing mail. Without a provider, development prints links to the server log and production sends nothing. */
export const EMAIL: { provider: 'resend'; apiKey: string; from: string } | { provider: 'log' } | { provider: 'none' } =
  RESEND_KEY.length > 0
    ? { provider: 'resend', apiKey: RESEND_KEY, from: (process.env.EMAIL_FROM ?? 'Relay <onboarding@resend.dev>').trim() }
    : PRODUCTION
      ? { provider: 'none' }
      : { provider: 'log' };

export const EMAIL_ENABLED = EMAIL.provider !== 'none';

/**
 * The public origin, for links in emails and OAuth callbacks. Explicit
 * configuration wins; on Vercel the production domain is known; otherwise
 * Better Auth works it out from the request.
 */
export const PUBLIC_URL: string | undefined = (() => {
  const explicit = (process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? '').trim();
  if (explicit.length > 0) return explicit.replace(/\/+$/, '');
  const vercel = (process.env.VERCEL_PROJECT_PRODUCTION_URL ?? '').trim();
  if (vercel.length > 0 && process.env.VERCEL_ENV === 'production') return `https://${vercel}`;
  return undefined;
})();

/**
 * Which hosts may serve sign-in, so cookies, callbacks and the origin check
 * work on the production domain, on Vercel previews and — in development —
 * on localhost or a LAN address, without trusting an arbitrary Host header.
 */
export const AUTH_ALLOWED_HOSTS: string[] = (() => {
  const hosts = new Set<string>();
  const add = (value: string | undefined) => {
    const trimmed = (value ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (trimmed.length > 0) hosts.add(trimmed);
  };
  if (PUBLIC_URL !== undefined) add(PUBLIC_URL);
  for (const host of (process.env.AUTH_ALLOWED_HOSTS ?? '').split(',')) add(host);
  add(process.env.VERCEL_PROJECT_PRODUCTION_URL);
  add(process.env.VERCEL_URL);
  add(process.env.VERCEL_BRANCH_URL);
  if (!PRODUCTION) for (const host of ['localhost:*', '127.0.0.1:*', '[::1]:*', '*.local:*', '192.168.*:*', '10.*:*', '172.*:*']) hosts.add(host);
  return [...hosts];
})();

export const AUTH_PROTOCOL: 'auto' | 'https' = PRODUCTION && process.env.AUTH_ALLOW_HTTP !== '1' ? 'https' : 'auto';

/** What the browser is told about accounts: enough to draw the right buttons, nothing secret. */
export function authCapabilities(): AuthCapabilities {
  return {
    enabled: ACCOUNTS_ENABLED,
    github: ACCOUNTS_ENABLED && GITHUB_OAUTH !== null,
    email: ACCOUNTS_ENABLED && EMAIL_ENABLED,
    reason: PRODUCTION ? null : ACCOUNTS_UNAVAILABLE_REASON,
  };
}
