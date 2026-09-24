import type { NextRequest } from 'next/server';
import { verifyWebhook } from '@clerk/nextjs/webhooks';
import { deleteUserData } from '@/server/studio';
import { databaseConfigured } from '@/server/db';

/**
 * Clerk tells the studio when a user is deleted anywhere — from their own
 * profile, or from the Clerk dashboard — so their studio data goes too.
 * Signed with Svix; set CLERK_WEBHOOK_SIGNING_SECRET and subscribe the
 * endpoint to `user.deleted` in the Clerk dashboard.
 */
export async function POST(request: NextRequest) {
  if ((process.env.CLERK_WEBHOOK_SIGNING_SECRET ?? '').length === 0) return Response.json({ ok: false, message: 'Webhook signing secret not configured.' }, { status: 503 });
  let event: Awaited<ReturnType<typeof verifyWebhook>>;
  try {
    event = await verifyWebhook(request);
  } catch {
    return Response.json({ ok: false, message: 'Signature did not verify.' }, { status: 400 });
  }
  if (event.type === 'user.deleted' && typeof event.data.id === 'string' && databaseConfigured()) {
    await deleteUserData(event.data.id);
  }
  return Response.json({ ok: true });
}
