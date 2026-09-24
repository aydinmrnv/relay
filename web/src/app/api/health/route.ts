import { json } from '@/server/api';
import { getDb } from '@/server/db';
import { authCapabilities, DATABASE } from '@/server/env';
import { sql } from 'drizzle-orm';

/** For uptime checks: is the app up, and can it reach its database. Says nothing secret. */
export async function GET() {
  const capabilities = authCapabilities();
  let database: 'ok' | 'unreachable' | 'not configured' = 'not configured';
  if (DATABASE.kind !== 'none') {
    try {
      const db = await getDb();
      await db.execute(sql`select 1`);
      database = 'ok';
    } catch (error) {
      console.error('[health] database check failed', error);
      database = 'unreachable';
    }
  }
  const ok = database !== 'unreachable';
  return json({ ok, database, accounts: capabilities.enabled, github: capabilities.github, email: capabilities.email }, { status: ok ? 200 : 503 });
}
