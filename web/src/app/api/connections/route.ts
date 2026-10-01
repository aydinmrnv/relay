import { json, withUser } from '@/server/api';
import { deleteConnections } from '@/server/connections';

/** Forgets every credential this person connected: what "Clear workspace" promises. Each stays valid in its app until revoked there. */
export async function DELETE(request: Request) {
  return withUser(request, async (user) => {
    await deleteConnections(user.id);
    return json({ ok: true });
  });
}
