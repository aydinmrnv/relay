import * as z from 'zod';
import { ApiError, json, readJson, withUser } from '@/server/api';
import { getShareFor, publishShare, unpublishShare } from '@/server/studio';
import { displayName } from '@/server/auth';
import { describeZodError, WORKFLOW_MAX_BYTES, workflowSchema } from '@/server/validate';
import type { Workflow } from '@/lib/workflow/schema';

export async function GET(request: Request, context: RouteContext<'/api/workflows/[id]/share'>) {
  return withUser(request, async (user) => {
    const { id } = await context.params;
    return json({ share: await getShareFor(user.id, id) });
  });
}

const body = z.object({ workflow: workflowSchema });

/** Publishes the workflow as it is now; calling it again refreshes the public copy under the same link. */
export async function POST(request: Request, context: RouteContext<'/api/workflows/[id]/share'>) {
  return withUser(request, async (user) => {
    const { id } = await context.params;
    const parsed = body.safeParse(await readJson(request, WORKFLOW_MAX_BYTES + 1_000));
    if (!parsed.success) throw new ApiError(400, 'INVALID', describeZodError(parsed.error as z.ZodError));
    if (parsed.data.workflow.id !== id) throw new ApiError(400, 'ID_MISMATCH', 'The workflow id does not match the address.');
    return json({ share: await publishShare(user.id, await displayName(), parsed.data.workflow as unknown as Workflow) });
  });
}

export async function DELETE(request: Request, context: RouteContext<'/api/workflows/[id]/share'>) {
  return withUser(request, async (user) => {
    const { id } = await context.params;
    await unpublishShare(user.id, id);
    return json({ ok: true });
  });
}
