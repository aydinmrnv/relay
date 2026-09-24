import { json } from '@/server/api';
import { getDb } from '@/server/db';
import { authCapabilities, DATABASE } from '@/server/env';
import { sql } from 'drizzle-orm';

/** For uptime checks: is the app up, can it reach its database, and are accounts on. Says nothing secret. */
export async function GET() {
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
  return json({ ok, database, accounts: authCapabilities().enabled }, { status: ok ? 200 : 503 });
}
