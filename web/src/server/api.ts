/**
 * The shape every studio API route shares: who is asking, whether the
 * request came from this site, a bounded JSON body, and errors that say
 * what went wrong in a sentence the studio can show.
 */
import { eq } from 'drizzle-orm';
import { getUserId } from './auth';
import { getDb } from './db';
import { deletedUser } from './db/schema';
import { ACCOUNTS_ENABLED } from './env';
import { LIMITS, rateLimit, type Limit } from './rate-limit';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Extra fields for the client, e.g. the server's copy on a conflict. */
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  return Response.json(data, { ...init, headers: { 'cache-control': 'no-store', ...init.headers } });
}

export interface UserRouteOptions {
  /** A tighter limit than the default for this route. `null` for none (a read that costs nothing). */
  limit?: Limit | null;
}

/** The person a request is for. Only the id: anything else about them is Clerk's to tell. */
export interface RequestUser {
  id: string;
}

/**
 * Runs `handler` for a signed-in person. Mutations must come from a page on
 * this site: session cookies are SameSite=Lax already, and checking Origin
 * as well means a form on another site cannot write here even if a browser
 * gets that wrong.
 */
export async function withUser(request: Request, handler: (user: RequestUser) => Promise<Response>, options: UserRouteOptions = {}): Promise<Response> {
  try {
    if (!ACCOUNTS_ENABLED) throw new ApiError(503, 'ACCOUNTS_DISABLED', 'Accounts are not enabled on this server.');
    const write = request.method !== 'GET' && request.method !== 'HEAD';
    if (write) assertSameOrigin(request);
    const id = await getUserId();
    if (id === null) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to do that.');
    const user: RequestUser = { id };
    // The sync engine says whose workspace it is sending. If another tab has
    // since signed in as someone else, the cookie belongs to them: refuse,
    // rather than save one person's work into another's account.
    const expected = request.headers.get('x-relay-user');
    if (expected !== null && expected !== user.id) throw new ApiError(409, 'USER_MISMATCH', 'This browser is now signed in as someone else.');
    const limit = options.limit === undefined ? (write ? LIMITS.write : null) : options.limit;
    // A session token is good for up to a minute after its account is
    // deleted, and a tab that has one would sync its copy straight back.
    await Promise.all([limit === null ? undefined : rateLimit(limit, user.id), write ? assertNotDeleted(user.id) : undefined]);
    return await handler(user);
  } catch (error) {
    return errorResponse(error);
  }
}

async function assertNotDeleted(userId: string): Promise<void> {
  const db = await getDb();
  const [gone] = await db.select({ userId: deletedUser.userId }).from(deletedUser).where(eq(deletedUser.userId, userId));
  if (gone !== undefined) throw new ApiError(401, 'ACCOUNT_DELETED', 'This account was deleted.');
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    const retryAfter = error.data?.['retryAfter'];
    return json({ ...error.data, code: error.code, message: error.message }, { status: error.status, ...(typeof retryAfter === 'number' ? { headers: { 'retry-after': String(retryAfter) } } : {}) });
  }
  console.error('[api]', describeForLog(error));
  return json({ code: 'INTERNAL', message: 'Something went wrong on our side.' }, { status: 500 });
}

/**
 * What goes in the log for an error nobody expected: what kind it is and what
 * it says, cut short. A failed query's message carries the statement and its
 * parameters, which here means a person's whole workflow; logs are read by
 * more people, and kept for longer, than that deserves.
 */
export function describeForLog(error: unknown): string {
  if (!(error instanceof Error)) return 'a non-error was thrown';
  const cause = error.cause instanceof Error ? error.cause : null;
  const code = (cause as { code?: unknown } | null)?.code ?? (error as { code?: unknown }).code;
  // The driver's own message ("value too long", "invalid input syntax") says what went wrong without the row.
  const message = (cause?.message ?? error.message).replace(/\s+/g, ' ').slice(0, 300);
  return `${error.name}${typeof code === 'string' ? ` [${code}]` : ''}: ${message}`;
}

function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (origin === null) {
    // Browsers send Origin on every cross-site write; its absence plus a
    // cross-site fetch-metadata header is the one combination to refuse.
    if (request.headers.get('sec-fetch-site') === 'cross-site') throw new ApiError(403, 'CROSS_SITE', 'Cross-site requests are not allowed.');
    return;
  }
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ApiError(403, 'CROSS_SITE', 'Cross-site requests are not allowed.');
  }
  if (host === null || originHost !== host) throw new ApiError(403, 'CROSS_SITE', 'Cross-site requests are not allowed.');
}

/** Reads a JSON body no larger than `maxBytes`, so one request cannot fill the database. */
export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const type = request.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JSON.');
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new ApiError(413, 'TOO_LARGE', `That is too large to save (${Math.round(declared / 1024)} KB; the limit is ${Math.round(maxBytes / 1024)} KB).`);
  const text = await request.text();
  // Bytes, as the limit says and as the database will store: a string's length counts UTF-16 units, which undercounts anything not ASCII.
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > maxBytes) throw new ApiError(413, 'TOO_LARGE', `That is too large to save (${Math.round(bytes / 1024)} KB; the limit is ${Math.round(maxBytes / 1024)} KB).`);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, 'BAD_JSON', 'The request body is not valid JSON.');
  }
  // Postgres will not store a NUL in text or jsonb, and a run's log is where
  // one turns up (a binary a tool printed). Left in, that one character makes
  // the whole save fail, every time it is retried.
  return text.includes('\\u0000') ? withoutNul(value) : value;
}

function withoutNul(value: unknown): unknown {
  if (typeof value === 'string') return value.includes('\u0000') ? value.replaceAll('\u0000', '\uFFFD') : value;
  if (Array.isArray(value)) return value.map(withoutNul);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [withoutNul(key) as string, withoutNul(item)]));
  return value;
}
