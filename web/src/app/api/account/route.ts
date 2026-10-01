import { ApiError, describeForLog, json, readJson, withUser } from '@/server/api';
import { deleteClerkUser } from '@/server/auth';
import { LIMITS } from '@/server/rate-limit';
import { deleteUserData } from '@/server/studio';
import { SUPPORT_EMAIL } from '@/lib/links';

/**
 * Deletes the person: their workflows, runs, versions, share links and app
 * credentials here, in one transaction, then their Clerk user. Studio data
 * goes first, so a failure half-way leaves an account with nothing in it
 * rather than data with no owner — and each failure says which half it was.
 *
 * A Relay Cloud machine is not the studio's to delete: the hub knows people
 * by their own session, so the browser removes the machine before it calls
 * this (see `DeleteAccount`).
 */
export async function DELETE(request: Request) {
  return withUser(
    request,
    async (user) => {
      const body = (await readJson(request, 1_000)) as { confirm?: unknown };
      if (body.confirm !== 'delete') throw new ApiError(400, 'CONFIRM', 'Type “delete” to confirm.');
      try {
        await deleteUserData(user.id);
      } catch (error) {
        console.error('[account] could not delete studio data:', describeForLog(error));
        throw new ApiError(500, 'DELETE_FAILED', 'Nothing was deleted: the database could not be reached. Your account is as it was. Try again in a minute.');
      }
      try {
        await deleteClerkUser(user.id);
      } catch (error) {
        console.error('[account] studio data deleted, Clerk user not:', describeForLog(error));
        throw new ApiError(502, 'SIGN_IN_NOT_DELETED', `Everything in your account was deleted, but your sign-in itself could not be removed. Try again, or write to ${SUPPORT_EMAIL} and we will remove it.`);
      }
      return json({ ok: true });
    },
    { limit: LIMITS.account },
  );
}
