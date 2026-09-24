import * as z from 'zod';
import { ApiError, json, readJson, withUser } from '@/server/api';
import { loadWorkspace, patchWorkspace } from '@/server/studio';
import { describeZodError, WORKSPACE_MAX_BYTES, workspacePatchSchema } from '@/server/validate';

/** Everything the studio needs to draw a signed-in person's workspace. */
export async function GET(request: Request) {
  return withUser(request, async (user) => json({ user, ...(await loadWorkspace(user.id)) }));
}

/** Settings, product name, connections, tours seen: the small things, saved together. */
export async function PATCH(request: Request) {
  return withUser(request, async (user) => {
    const parsed = workspacePatchSchema.safeParse(await readJson(request, WORKSPACE_MAX_BYTES));
    if (!parsed.success) throw new ApiError(400, 'INVALID', describeZodError(parsed.error as z.ZodError));
    await patchWorkspace(user.id, parsed.data);
    return json({ ok: true });
  });
}
