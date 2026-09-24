/**
 * The shape every studio API route shares: who is asking, whether the
 * request came from this site, a bounded JSON body, and errors that say
 * what went wrong in a sentence the studio can show.
 */
import { getSessionUser, type SessionUser } from './auth';
import { ACCOUNTS_ENABLED } from './env';

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

/**
 * Runs `handler` for a signed-in person. Mutations must come from a page on
 * this site: session cookies are SameSite=Lax already, and checking Origin
 * as well means a form on another site cannot write here even if a browser
 * gets that wrong.
 */
export async function withUser(request: Request, handler: (user: SessionUser) => Promise<Response>): Promise<Response> {
  try {
    if (!ACCOUNTS_ENABLED) throw new ApiError(503, 'ACCOUNTS_DISABLED', 'Accounts are not enabled on this server.');
    if (request.method !== 'GET' && request.method !== 'HEAD') assertSameOrigin(request);
    const user = await getSessionUser(request.headers);
    if (user === null) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to do that.');
    // The sync engine says whose workspace it is sending. If another tab has
    // since signed in as someone else, the cookie belongs to them: refuse,
    // rather than save one person's work into another's account.
    const expected = request.headers.get('x-relay-user');
    if (expected !== null && expected !== user.id) throw new ApiError(409, 'USER_MISMATCH', 'This browser is now signed in as someone else.');
    return await handler(user);
  } catch (error) {
    return errorResponse(error);
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) return json({ ...error.data, code: error.code, message: error.message }, { status: error.status });
  console.error('[api]', error);
  return json({ code: 'INTERNAL', message: 'Something went wrong on our side. Your change is kept in this browser and will be retried.' }, { status: 500 });
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
  if (text.length > maxBytes) throw new ApiError(413, 'TOO_LARGE', `That is too large to save (${Math.round(text.length / 1024)} KB; the limit is ${Math.round(maxBytes / 1024)} KB).`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, 'BAD_JSON', 'The request body is not valid JSON.');
  }
}
