import * as z from 'zod';
import { ApiError, json, readJson, withUser } from '@/server/api';
import { LIMITS } from '@/server/rate-limit';
import { loadWorkspace, patchWorkspace } from '@/server/studio';
import { describeZodError, WORKSPACE_MAX_BYTES, workspacePatchSchema } from '@/server/validate';

/** Everything the studio needs to draw a signed-in person's workspace. */
export async function GET(request: Request) {
  return withUser(request, async (user) => json({ user, ...(await loadWorkspace(user.id)) }), { limit: LIMITS.load });
}

/** Settings, connections marked ready, tours seen: the small things, saved together. */
export async function PATCH(request: Request) {
  return withUser(request, async (user) => {
    const parsed = workspacePatchSchema.safeParse(await readJson(request, WORKSPACE_MAX_BYTES));
    if (!parsed.success) throw new ApiError(400, 'INVALID', describeZodError(parsed.error as z.ZodError));
    const { settings, connections, toursSeen, checklistDismissed } = parsed.data;
    await patchWorkspace(user.id, { settings, connections, toursSeen, checklistDismissed });
    return json({ ok: true });
  });
}
