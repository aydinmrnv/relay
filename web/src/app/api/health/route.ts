import { json } from '@/server/api';
import { getDb } from '@/server/db';
import { authCapabilities, DATABASE, IS_PRODUCTION } from '@/server/env';
import { sql } from 'drizzle-orm';

/**
 * For uptime checks: is the app up, can it reach its database, are accounts
 * on, and is everything a public deployment needs in place. Says nothing
 * secret.
 *
 * In production it answers 503 unless all of that is true. A deployment
 * missing its keys or its database still serves the site, with every "Try it
 * free" leading to a page that says sign-in is not available; a check that
 * called that healthy is how it would go unnoticed.
 */
export async function GET() {
  let database: 'ok' | 'unreachable' | 'not configured' = 'not configured';
  if (DATABASE.kind !== 'none') {
    try {
      const db = await getDb();
      await db.execute(sql`select 1`);
      database = 'ok';
    } catch (error) {
      console.error('[health] database check failed:', error instanceof Error ? error.message.slice(0, 200) : 'unknown error');
      database = 'unreachable';
    }
  }
  const capabilities = authCapabilities();
  const accounts = capabilities.enabled;
  // Without it, deleting a user in Clerk leaves their data and their public links here.
  const deletionWebhook = (process.env.CLERK_WEBHOOK_SIGNING_SECRET ?? '').trim().length > 0;
  const connections = capabilities.credentials === true;
  const missing = [
    database === 'ok' ? null : 'database',
    accounts ? null : 'accounts',
    !IS_PRODUCTION || deletionWebhook ? null : 'account deletion webhook',
    !IS_PRODUCTION || connections ? null : 'credentials key',
  ].filter((item): item is string => item !== null);
  const ok = IS_PRODUCTION ? missing.length === 0 : database !== 'unreachable';
  return json({ ok, database, accounts, deletionWebhook, connections, cloud: capabilities.cloudHub != null, ...(missing.length > 0 ? { missing } : {}) }, { status: ok ? 200 : 503 });
}
