import { json, withUser } from '@/server/api';
import { assertCredentials, recheckApp } from '@/server/connections';
import { LIMITS } from '@/server/rate-limit';

/** Asks the app whether the stored credential still works, and records the answer. Nothing is posted. */
export async function POST(request: Request, context: RouteContext<'/api/connections/[connectorId]/check'>) {
  return withUser(request, async (user) => {
    assertCredentials();
    const { connectorId } = await context.params;
    return json({ connection: await recheckApp(user.id, connectorId) });
  }, { limit: LIMITS.connect });
}
