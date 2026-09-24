import { ApiError, json, withUser } from '@/server/api';
import { deleteVersion, getVersion } from '@/server/studio';

export async function GET(request: Request, context: RouteContext<'/api/workflows/[id]/versions/[versionId]'>) {
  return withUser(request, async (user) => {
    const { id, versionId } = await context.params;
    const workflow = await getVersion(user.id, id, versionId);
    if (workflow === null) throw new ApiError(404, 'NOT_FOUND', 'That version no longer exists.');
    return json({ workflow });
  });
}

export async function DELETE(request: Request, context: RouteContext<'/api/workflows/[id]/versions/[versionId]'>) {
  return withUser(request, async (user) => {
    const { id, versionId } = await context.params;
    await deleteVersion(user.id, id, versionId);
    return json({ ok: true });
  });
}
