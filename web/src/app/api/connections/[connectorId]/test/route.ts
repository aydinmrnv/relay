import * as z from 'zod';
import { ApiError, json, readJson, withUser } from '@/server/api';
import { assertCredentials, testApp } from '@/server/connections';
import { describeZodError } from '@/server/validate';

const body = z.object({ product: z.string().trim().min(1).max(60) });

/** Posts a short "this channel is connected" message through the connection. */
export async function POST(request: Request, context: RouteContext<'/api/connections/[connectorId]/test'>) {
  return withUser(request, async (user) => {
    assertCredentials();
    const { connectorId } = await context.params;
    const parsed = body.safeParse(await readJson(request, 1_000));
    if (!parsed.success) throw new ApiError(400, 'INVALID', describeZodError(parsed.error as z.ZodError));
    return json({ connection: await testApp(user.id, connectorId, parsed.data.product) });
  });
}
