import * as z from 'zod';
import { ApiError, json, readJson, withUser } from '@/server/api';
import { assertCredentials, connectApp, disconnectApp } from '@/server/connections';
import { LIMITS } from '@/server/rate-limit';
import { describeZodError } from '@/server/validate';

const body = z.object({
  secret: z.string().min(1).max(500),
  label: z.string().max(80).optional(),
});

/** Connects the app for real, or replaces its credential: checked with the app first, then kept encrypted. */
export async function PUT(request: Request, context: RouteContext<'/api/connections/[connectorId]'>) {
  return withUser(request, async (user) => {
    assertCredentials();
    const { connectorId } = await context.params;
    const parsed = body.safeParse(await readJson(request, 2_000));
    if (!parsed.success) throw new ApiError(400, 'INVALID', describeZodError(parsed.error as z.ZodError));
    return json({ connection: await connectApp(user.id, connectorId, parsed.data.secret, parsed.data.label) });
  }, { limit: LIMITS.connect });
}

/** Forgets the credential. It stays valid in the app until revoked there. */
export async function DELETE(request: Request, context: RouteContext<'/api/connections/[connectorId]'>) {
  return withUser(request, async (user) => {
    const { connectorId } = await context.params;
    await disconnectApp(user.id, connectorId);
    return json({ ok: true });
  });
}
