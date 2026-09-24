import { errorResponse, json } from '@/server/api';
import { databaseConfigured } from '@/server/db';
import { countShare } from '@/server/studio';

/** Counts a remix. Anyone may remix, signed in or not, so this needs no session. */
export async function POST(_request: Request, context: RouteContext<'/api/share/[slug]/remix'>) {
  try {
    if (!databaseConfigured()) return json({ ok: false }, { status: 503 });
    const { slug } = await context.params;
    await countShare(slug, 'remixes');
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
