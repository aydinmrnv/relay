import { json, withUser } from '@/server/api';
import { assertCredentials, testApp } from '@/server/connections';
import { LIMITS } from '@/server/rate-limit';

/**
 * Posts a short "this channel is connected" message through a webhook
 * connection; an app connected with a token has none, and is told so.
 * The words are the server's own: nothing a request sends ends up in
 * somebody's channel, where `<!channel>` would ping everyone in it.
 */
export async function POST(request: Request, context: RouteContext<'/api/connections/[connectorId]/test'>) {
  return withUser(
    request,
    async (user) => {
      assertCredentials();
      const { connectorId } = await context.params;
      return json({ connection: await testApp(user.id, connectorId) });
    },
    { limit: LIMITS.message },
  );
}
