/**
 * The two round trips through github.com, and what is kept in a cookie
 * while the person is there: signing in to the app (`state` and the PKCE
 * verifier, which the callback checks) and installing it (only where to send
 * them back). Each cookie is HttpOnly, scoped to `/api/github`, and bound to
 * the studio account that set it.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { safeNext } from '@/lib/safe-next';

export const SIGN_IN_COOKIE = 'relay_github_sign_in';
export const RETURN_COOKIE = 'relay_github_return';

export interface SignInCookie {
  state: string;
  verifier: string;
  next: string;
  user: string;
}

export interface ReturnCookie {
  next: string;
  user: string;
}

/** The origin this request came in on: the callback has to come back to the same host, or its cookie is not sent. */
export function requestOrigin(request: Request): string {
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? new URL(request.url).host;
  const proto = request.headers.get('x-forwarded-proto') ?? (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : new URL(request.url).protocol.replace(':', ''));
  return `${proto}://${host}`;
}

export function callbackUrl(request: Request): string {
  return `${requestOrigin(request)}/api/github/callback`;
}

/** `next` with `?github=<outcome>` added, as an absolute URL on this origin. */
export function backTo(request: Request, next: string, outcome: string): NextResponse {
  const url = new URL(safeNext(next, '/onboarding'), requestOrigin(request));
  url.searchParams.set('github', outcome);
  return NextResponse.redirect(url, { status: 303 });
}

export function writeCookie(response: NextResponse, request: Request, name: string, value: object, maxAgeSeconds: number): void {
  response.cookies.set(name, Buffer.from(JSON.stringify(value)).toString('base64url'), {
    httpOnly: true,
    sameSite: 'lax',
    secure: requestOrigin(request).startsWith('https:'),
    path: '/api/github',
    maxAge: maxAgeSeconds,
  });
}

export function clearCookie(response: NextResponse, name: string): void {
  response.cookies.set(name, '', { httpOnly: true, sameSite: 'lax', path: '/api/github', maxAge: 0 });
}

export function readCookie<T>(request: NextRequest, name: string, fields: ReadonlyArray<keyof T & string>): T | null {
  const raw = request.cookies.get(name)?.value;
  if (raw === undefined || raw.length === 0 || raw.length > 4000) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
    return fields.every((field) => typeof parsed[field] === 'string' && (parsed[field] as string).length > 0) ? (parsed as T) : null;
  } catch {
    return null;
  }
}
