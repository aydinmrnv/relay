import * as z from 'zod';
import { ApiError, json, readJson, withUser } from '@/server/api';
import { deleteRun, getRun, saveRun } from '@/server/studio';
import { describeZodError, RUN_MAX_BYTES, runSchema } from '@/server/validate';
import type { Run } from '@/lib/workflow/schema';

/** One run, for a workspace too large to arrive in one answer. */
export async function GET(request: Request, context: RouteContext<'/api/runs/[id]'>) {
  return withUser(request, async (user) => {
    const { id } = await context.params;
    const run = await getRun(user.id, id);
    if (run === null) throw new ApiError(404, 'NOT_FOUND', 'No such run.');
    return json({ run });
  });
}

export async function PUT(request: Request, context: RouteContext<'/api/runs/[id]'>) {
  return withUser(request, async (user) => {
    const { id } = await context.params;
    const parsed = runSchema.safeParse(await readJson(request, RUN_MAX_BYTES));
    if (!parsed.success) throw new ApiError(400, 'INVALID', describeZodError(parsed.error as z.ZodError));
    if (parsed.data.id !== id) throw new ApiError(400, 'ID_MISMATCH', 'The run id does not match the address.');
    await saveRun(user.id, parsed.data as unknown as Run);
    return json({ ok: true });
  });
}

export async function DELETE(request: Request, context: RouteContext<'/api/runs/[id]'>) {
  return withUser(request, async (user) => {
    const { id } = await context.params;
    await deleteRun(user.id, id);
    return json({ ok: true });
  });
}
