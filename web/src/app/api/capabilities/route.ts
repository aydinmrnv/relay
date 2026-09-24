import { authCapabilities } from '@/server/env';

/**
 * What this deployment supports, read when the server runs rather than when
 * it was built. Pages prerendered by a build without the database settings
 * would otherwise switch accounts off for good. No database access; the CDN
 * may keep it for a few minutes.
 */
export function GET() {
  return Response.json(authCapabilities(), { headers: { 'cache-control': 'public, max-age=60, s-maxage=300' } });
}
