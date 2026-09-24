/**
 * One database handle per server process, ready once its migrations ran.
 *
 * With DATABASE_URL it is node-postgres against any Postgres. Without one, in
 * development, it is PGlite — Postgres compiled to WebAssembly, kept in
 * `web/.data/pglite` — so `npm run dev` has working accounts with nothing to
 * install. Both speak the same SQL, so the schema and every query are shared.
 *
 * The handle lives on `globalThis` because the dev server re-evaluates
 * modules on every edit, and a second PGlite opening the same directory
 * would corrupt it.
 */
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { DATABASE, PGLITE_DIR } from '../env';
import { MIGRATIONS } from './migrations';
import { schema } from './schema';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/** The raw connection migrations run on: one connection, so their transaction and its lock hold. */
interface RawSession {
  exec: (sql: string) => Promise<void>;
  rows: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
  release: () => void;
}

interface Handle {
  db: Db;
  session: () => Promise<RawSession>;
}

const GLOBAL_KEY = Symbol.for('relay.studio.db');
type GlobalWithDb = typeof globalThis & { [GLOBAL_KEY]?: Promise<Handle> };

/** An arbitrary constant: the advisory lock every instance takes before migrating. */
const MIGRATION_LOCK = 727_274_101;

export function databaseConfigured(): boolean {
  return DATABASE.kind !== 'none';
}

export async function getDb(): Promise<Db> {
  const store = globalThis as GlobalWithDb;
  if (store[GLOBAL_KEY] === undefined) {
    store[GLOBAL_KEY] = open().catch((error: unknown) => {
      // Let the next request try again rather than caching the failure forever.
      store[GLOBAL_KEY] = undefined;
      throw error;
    });
  }
  return (await store[GLOBAL_KEY]).db;
}

async function open(): Promise<Handle> {
  const handle = DATABASE.kind === 'postgres' ? await openPostgres(DATABASE.url) : DATABASE.kind === 'pglite' ? await openPglite(PGLITE_DIR) : null;
  if (handle === null) throw new Error('No database is configured. Set DATABASE_URL.');
  await migrate(handle);
  return handle;
}

async function openPostgres(url: string): Promise<Handle> {
  const { Pool } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  // Small: on serverless every instance has its own pool, and they add up.
  const pool = new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 });
  pool.on('error', (error) => console.error('[db] idle client error', error));
  const db = drizzle({ client: pool, schema }) as unknown as Db;
  return {
    db,
    session: async () => {
      const client = await pool.connect();
      return {
        exec: async (sql) => {
          await client.query(sql);
        },
        rows: async <T,>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as T[],
        release: () => client.release(),
      };
    },
  };
}

async function openPglite(dir: string): Promise<Handle> {
  const { mkdir } = await import('node:fs/promises');
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  await mkdir(dir, { recursive: true });
  const client = new PGlite(dir);
  await client.waitReady;
  const db = drizzle({ client, schema }) as unknown as Db;
  return {
    db,
    session: async () => ({
      exec: async (sql) => {
        await client.exec(sql);
      },
      rows: async <T,>(sql: string, params: unknown[] = []) => (await client.query<T>(sql, params)).rows,
      release: () => undefined,
    }),
  };
}

/**
 * Everything in one transaction, under a transaction-scoped advisory lock:
 * behind a transaction-mode pooler (Neon's pooled URL, PgBouncer) a
 * session lock and its unlock can land on different connections and leave
 * the lock held forever. A transaction always stays on one connection, and
 * its lock is released when it ends, however it ends.
 */
async function migrate(handle: Handle): Promise<void> {
  const session = await handle.session();
  try {
    await session.exec('BEGIN');
    try {
      await session.rows('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
      await session.exec('CREATE TABLE IF NOT EXISTS _relay_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      const applied = new Set((await session.rows<{ id: string }>('SELECT id FROM _relay_migrations')).map((row) => row.id));
      for (const migration of MIGRATIONS) {
        if (applied.has(migration.id)) continue;
        await session.exec(migration.sql);
        await session.rows('INSERT INTO _relay_migrations (id) VALUES ($1)', [migration.id]);
        console.info(`[db] applied ${migration.id}`);
      }
      await session.exec('COMMIT');
    } catch (error) {
      await session.exec('ROLLBACK');
      throw error;
    }
  } finally {
    session.release();
  }
}
