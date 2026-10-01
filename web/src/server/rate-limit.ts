/**
 * How often one account, or one address, may ask for something.
 *
 * A fixed window per key, counted in the database: on a serverless host every
 * request can land on a different instance, so a counter in memory limits
 * nothing. One statement per check, and no transaction: it either adds one to
 * this window's count or starts a new window, and says what the count is now.
 *
 * It fails open. A limiter that cannot reach the database must not be the
 * reason nobody can save; the request it let through will fail on its own if
 * the database is really gone.
 */
import { sql } from 'drizzle-orm';
import { ApiError } from './api';
import { getDb } from './db';

export interface Limit {
  /** What is being limited: `write`, `connect`, `remix`… */
  name: string;
  /** How many times per window. */
  max: number;
  windowSeconds: number;
}

export const LIMITS = {
  /** Every change the studio saves. Dragging a node is one request every second or so; this is far above a person. */
  write: { name: 'write', max: 600, windowSeconds: 60 },
  /** Loading a workspace reads everything in it. */
  load: { name: 'load', max: 60, windowSeconds: 60 },
  /** Each attempt asks Slack or Discord whether a webhook is real: an oracle for leaked URLs, from the server's address. */
  connect: { name: 'connect', max: 10, windowSeconds: 600 },
  /** Each one posts a message to somebody's channel. */
  message: { name: 'message', max: 10, windowSeconds: 600 },
  /** Each one asks Clerk for a name. */
  share: { name: 'share', max: 30, windowSeconds: 3600 },
  /** Each one saves up to hundreds of rows. */
  import: { name: 'import', max: 6, windowSeconds: 600 },
  account: { name: 'account', max: 5, windowSeconds: 3600 },
  /** Open to anyone, so by address: counters, and images that cost a render. */
  remix: { name: 'remix', max: 20, windowSeconds: 60 },
  view: { name: 'view', max: 60, windowSeconds: 60 },
  image: { name: 'image', max: 60, windowSeconds: 60 },
} satisfies Record<string, Limit>;

/** Throws a 429 once `subject` is over the limit for this window. */
export async function rateLimit(limit: Limit, subject: string): Promise<void> {
  const window = Math.floor(Date.now() / 1000 / limit.windowSeconds) * limit.windowSeconds;
  const key = `${limit.name}:${subject}`.slice(0, 200);
  let count: number;
  try {
    const db = await getDb();
    const result = (await db.execute(sql`
      INSERT INTO relay_rate_limit (key, window_start, count) VALUES (${key}, ${window}, 1)
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN relay_rate_limit.window_start = EXCLUDED.window_start THEN relay_rate_limit.count + 1 ELSE 1 END,
        window_start = EXCLUDED.window_start
      RETURNING count`)) as unknown as { rows?: Array<{ count: number }> } | Array<{ count: number }>;
    const rows = Array.isArray(result) ? result : (result.rows ?? []);
    count = Number(rows[0]?.count ?? 1);
    // Old windows are of no use to anyone. Now and then, sweep them.
    if (Math.random() < 0.01) void db.execute(sql`DELETE FROM relay_rate_limit WHERE window_start < ${window - 86_400}`).catch(() => undefined);
  } catch (error) {
    console.error('[rate-limit] could not count, letting the request through:', error instanceof Error ? error.message.slice(0, 200) : 'unknown error');
    return;
  }
  if (count > limit.max) {
    const retryAfter = Math.max(1, window + limit.windowSeconds - Math.floor(Date.now() / 1000));
    throw new ApiError(429, 'RATE_LIMITED', `That is more often than this allows. Try again in ${retryAfter < 90 ? `${retryAfter} seconds` : `${Math.ceil(retryAfter / 60)} minutes`}.`, { retryAfter });
  }
}

/** The address a request came from, as the host's proxy reports it. `unknown` shares one bucket, which is the safe side. */
export function clientAddress(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first !== undefined && first.length > 0 ? first : (request.headers.get('x-real-ip')?.trim() || 'unknown');
}
