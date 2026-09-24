import { ApiError, json, readJson, withUser } from '@/server/api';
import { deleteClerkUser } from '@/server/auth';
import { deleteUserData } from '@/server/studio';

/**
 * Deletes the person: their workflows, runs, versions and share links here,
 * then their Clerk user. Studio data goes first, so a failure half-way
 * leaves an account with nothing in it rather than data with no owner.
 */
export async function DELETE(request: Request) {
  return withUser(request, async (user) => {
    const body = (await readJson(request, 1_000)) as { confirm?: unknown };
    if (body.confirm !== 'delete') throw new ApiError(400, 'CONFIRM', 'Type “delete” to confirm.');
    await deleteUserData(user.id);
    await deleteClerkUser(user.id);
    return json({ ok: true });
  });
}
