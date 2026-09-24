import * as z from 'zod';
import { ApiError, json, readJson, withUser } from '@/server/api';
import { listVersions, saveNamedVersion } from '@/server/studio';
import { describeZodError, WORKFLOW_MAX_BYTES, workflowSchema } from '@/server/validate';
import type { Workflow } from '@/lib/workflow/schema';

export async function GET(request: Request, context: RouteContext<'/api/workflows/[id]/versions'>) {
  return withUser(request, async (user) => {
    const { id } = await context.params;
    return json({ versions: await listVersions(user.id, id) });
  });
}

const body = z.object({ label: z.string().max(120), workflow: workflowSchema });

/** "Save a version": the graph as it is now, under a name, kept until deleted. */
export async function POST(request: Request, context: RouteContext<'/api/workflows/[id]/versions'>) {
  return withUser(request, async (user) => {
    const { id } = await context.params;
    const parsed = body.safeParse(await readJson(request, WORKFLOW_MAX_BYTES + 1_000));
    if (!parsed.success) throw new ApiError(400, 'INVALID', describeZodError(parsed.error as z.ZodError));
    if (parsed.data.workflow.id !== id) throw new ApiError(400, 'ID_MISMATCH', 'The workflow id does not match the address.');
    return json({ version: await saveNamedVersion(user.id, parsed.data.workflow as unknown as Workflow, parsed.data.label) });
  });
}
