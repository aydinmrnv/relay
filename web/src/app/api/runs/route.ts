import { json, withUser } from '@/server/api';
import { clearRuns } from '@/server/studio';

/** "Clear run history". */
export async function DELETE(request: Request) {
  return withUser(request, async (user) => {
    await clearRuns(user.id);
    return json({ ok: true });
  });
}
