/**
 * The studio's screens, which need an account. The site, the docs (`/guide`,
 * `/runners`), shared workflows (`/s/…`) and the sign-in pages do not. The
 * proxy turns signed-out requests for these away, and the studio's own gate
 * does the same for a tab whose session ends while it is open.
 */
export const STUDIO_ROUTES = ['/dashboard', '/workflows', '/runs', '/templates', '/integrations', '/settings', '/connect', '/onboarding'] as const;

export function isStudioPath(pathname: string): boolean {
  return STUDIO_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

/** Sign in, then back to `path`. */
export function signInThenTo(path: string): string {
  return path === '/dashboard' ? '/sign-in' : `/sign-in?next=${encodeURIComponent(path)}`;
}
