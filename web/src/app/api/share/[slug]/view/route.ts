import { errorResponse, json } from '@/server/api';
import { getUserId } from '@/server/auth';
import { databaseConfigured } from '@/server/db';
import { clientAddress, LIMITS, rateLimit } from '@/server/rate-limit';
import { countShare } from '@/server/studio';

/**
 * Counts a view. Anyone may look, signed in or not, so this needs no session; it is
 * limited by address instead, and the owner's own visits are not counted. The
 * number is an indication, not an audit: nothing about an open counter can be.
 */
export async function POST(request: Request, context: RouteContext<'/api/share/[slug]/view'>) {
  try {
    if (!databaseConfigured()) return json({ ok: false }, { status: 503 });
    const { slug } = await context.params;
    await rateLimit(LIMITS.view, clientAddress(request));
    await countShare(slug, 'views', await getUserId().catch(() => null));
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
