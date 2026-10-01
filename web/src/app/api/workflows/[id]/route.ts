import * as z from 'zod';
import { ApiError, json, readJson, withUser } from '@/server/api';
import { deleteWorkflow, getWorkflow, saveWorkflow } from '@/server/studio';
import { describeZodError, WORKFLOW_MAX_BYTES, workflowSchema } from '@/server/validate';
import type { Workflow } from '@/lib/workflow/schema';

/** One workflow, for a workspace too large to arrive in one answer. */
export async function GET(request: Request, context: RouteContext<'/api/workflows/[id]'>) {
  return withUser(request, async (user) => {
    const { id } = await context.params;
    const found = await getWorkflow(user.id, id);
    if (found === null) throw new ApiError(404, 'NOT_FOUND', 'No such workflow.');
    return json(found);
  });
}

export async function PUT(request: Request, context: RouteContext<'/api/workflows/[id]'>) {
  return withUser(request, async (user) => {
    const { id } = await context.params;
    const parsed = workflowSchema.safeParse(await readJson(request, WORKFLOW_MAX_BYTES));
    if (!parsed.success) throw new ApiError(400, 'INVALID', describeZodError(parsed.error as z.ZodError));
    if (parsed.data.id !== id) throw new ApiError(400, 'ID_MISMATCH', 'The workflow id does not match the address.');
    // The revision this save is based on: an ISO timestamp from the server, or "none" for a new workflow.
    const base = request.headers.get('x-relay-revision');
    const result = await saveWorkflow(user.id, parsed.data as unknown as Workflow, { baseRevision: base === null || base === 'none' ? null : base });
    return json({ ok: true, ...result });
  });
}

export async function DELETE(request: Request, context: RouteContext<'/api/workflows/[id]'>) {
  return withUser(request, async (user) => {
    const { id } = await context.params;
    await deleteWorkflow(user.id, id);
    return json({ ok: true });
  });
}
