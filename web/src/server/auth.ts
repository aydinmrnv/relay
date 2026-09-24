/**
 * Accounts: email and password, and GitHub when it is configured, on Better
 * Auth. Sessions are a database row plus an HttpOnly cookie; passwords are
 * scrypt-hashed by Better Auth; sign-in, sign-up and password-reset requests
 * are rate limited in the database so the limit holds across serverless
 * instances.
 *
 * The instance is built on first use, after the database has migrated, and
 * only when this deployment can have accounts at all (see `env.ts`).
 */
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { createAuthMiddleware } from 'better-auth/api';
import { SESSION_MARKER_COOKIE } from '@/lib/cloud/types';
import { DEFAULT_BRAND } from '@/lib/brand';
import { getDb, type Db } from './db';
import { schema } from './db/schema';
import { sendMail } from './email';
import { ACCOUNTS_ENABLED, ACCOUNTS_UNAVAILABLE_REASON, AUTH_ALLOWED_HOSTS, AUTH_PROTOCOL, AUTH_SECRET, EMAIL_ENABLED, GITHUB_OAUTH, PUBLIC_URL } from './env';

function createAuth(db: Db) {
  return betterAuth({
    appName: DEFAULT_BRAND.name,
    baseURL: AUTH_ALLOWED_HOSTS.length > 0 ? { allowedHosts: AUTH_ALLOWED_HOSTS, protocol: AUTH_PROTOCOL, ...(PUBLIC_URL === undefined ? {} : { fallback: PUBLIC_URL }) } : PUBLIC_URL,
    secret: AUTH_SECRET ?? undefined,
    trustedOrigins: (process.env.TRUSTED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      autoSignIn: true,
      // Verification is offered, not required: a person trying the studio
      // should not be locked out because a mail provider is slow.
      requireEmailVerification: false,
      revokeSessionsOnPasswordReset: true,
      ...(EMAIL_ENABLED
        ? {
            sendResetPassword: async ({ user, url }) => {
              await sendMail({
                to: user.email,
                subject: `Reset your ${DEFAULT_BRAND.name} password`,
                text: `Hi ${user.name},\n\nSomeone asked to reset the password for this account. The link works once, for the next hour.`,
                action: { label: 'Choose a new password', url },
              });
            },
          }
        : {}),
    },
    ...(EMAIL_ENABLED
      ? {
          emailVerification: {
            sendOnSignUp: true,
            autoSignInAfterVerification: true,
            sendVerificationEmail: async ({ user, url }) => {
              await sendMail({
                to: user.email,
                subject: `Confirm your email for ${DEFAULT_BRAND.name}`,
                text: `Hi ${user.name},\n\nConfirm this address so you can reset your password if you ever need to.`,
                action: { label: 'Confirm my email', url },
              });
            },
          },
        }
      : {}),
    socialProviders: GITHUB_OAUTH === null ? {} : { github: { clientId: GITHUB_OAUTH.clientId, clientSecret: GITHUB_OAUTH.clientSecret } },
    account: {
      encryptOAuthTokens: true,
      accountLinking: { enabled: true },
    },
    user: {
      deleteUser: { enabled: true },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      // Saves a database round trip on most requests; a revoked session
      // stops working within five minutes.
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    rateLimit: {
      enabled: process.env.NODE_ENV === 'production' || process.env.RATE_LIMIT === '1',
      storage: 'database',
      window: 60,
      max: 120,
      customRules: {
        '/sign-in/email': { window: 60, max: 8 },
        '/sign-up/email': { window: 60 * 10, max: 6 },
        '/request-password-reset': { window: 60 * 10, max: 4 },
        '/send-verification-email': { window: 60 * 10, max: 4 },
        '/change-password': { window: 60, max: 6 },
        '/delete-user': { window: 60, max: 4 },
      },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip'] },
    },
    telemetry: { enabled: false },
    hooks: {
      // A readable "someone is signed in here" marker next to the HttpOnly
      // session cookie, set on every path that creates a session — email,
      // GitHub, the auto sign-in after confirming an email — so the studio
      // knows to ask who it is without asking on every guest visit.
      after: createAuthMiddleware(async (ctx) => {
        const secure = ctx.context.baseURL.startsWith('https://');
        if (ctx.context.newSession !== null) {
          ctx.setCookie(SESSION_MARKER_COOKIE, '1', { path: '/', maxAge: 60 * 60 * 24 * 30, sameSite: 'lax', httpOnly: false, secure });
        } else if (ctx.path === '/sign-out' || ctx.path === '/delete-user') {
          ctx.setCookie(SESSION_MARKER_COOKIE, '', { path: '/', maxAge: 0, sameSite: 'lax', httpOnly: false, secure });
        }
      }),
    },
    plugins: [nextCookies()],
  });
}

export type Auth = ReturnType<typeof createAuth>;

const GLOBAL_KEY = Symbol.for('relay.studio.auth');
type GlobalWithAuth = typeof globalThis & { [GLOBAL_KEY]?: Promise<Auth> };

let warned = false;

/** The auth instance, or `null` when this deployment has no accounts. */
export async function getAuth(): Promise<Auth | null> {
  if (!ACCOUNTS_ENABLED) {
    if (!warned) {
      warned = true;
      console.warn(`[auth] Accounts are off: ${ACCOUNTS_UNAVAILABLE_REASON} The studio still works in the browser.`);
    }
    return null;
  }
  const store = globalThis as GlobalWithAuth;
  if (store[GLOBAL_KEY] === undefined) {
    store[GLOBAL_KEY] = getDb()
      .then(createAuth)
      .catch((error: unknown) => {
        store[GLOBAL_KEY] = undefined;
        throw error;
      });
  }
  return store[GLOBAL_KEY];
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: Date;
}

/**
 * Who is asking, from the request's cookies, or `null` when nobody is signed
 * in. A database that cannot be reached throws instead: answering "signed
 * out" would make the studio discard the account's unsent work.
 */
export async function getSessionUser(headers: Headers): Promise<SessionUser | null> {
  const auth = await getAuth();
  if (auth === null) return null;
  const session = await auth.api.getSession({ headers });
  if (session === null) return null;
  const { id, name, email, emailVerified, image, createdAt } = session.user;
  return { id, name, email, emailVerified, image: image ?? null, createdAt };
}
