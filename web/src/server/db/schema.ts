/**
 * The studio's tables: one workspace row per person, and their workflows,
 * runs, saved versions and public share links. People themselves live in
 * Clerk; here a person is only their Clerk user id (`user_…`).
 *
 * Workflows and runs keep their full JSON in a `data` column. Their shape is
 * the studio's (`src/lib/workflow/schema.ts`), it already round-trips through
 * import/export, and nothing on the server needs to look inside it beyond
 * the few columns lifted out here for sorting and listing.
 *
 * The SQL that creates all of this is in `migrations.ts`; keep them in step.
 */
import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/* ------------------------------------------------------------------ */
/* The studio                                                           */
/* ------------------------------------------------------------------ */

/** Everything about a person's studio that is not a workflow or a run. */
export const workspace = pgTable('workspace', {
  userId: text('user_id').primaryKey(),
  settings: jsonb('settings'),
  connections: jsonb('connections'),
  toursSeen: jsonb('tours_seen'),
  checklistDismissed: boolean('checklist_dismissed').notNull().default(false),
  /** The answers from onboarding, kept so the studio can tailor what it suggests. */
  onboarding: jsonb('onboarding'),
  onboardedAt: timestamp('onboarded_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const workflow = pgTable(
  'workflow',
  {
    // Ids are made in the browser (`wf_…`), so they are only unique per person.
    userId: text('user_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    data: jsonb('data').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.id] })],
);

export const run = pgTable(
  'run',
  {
    userId: text('user_id').notNull(),
    id: text('id').notNull(),
    workflowId: text('workflow_id').notNull(),
    status: text('status').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    data: jsonb('data').notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.id] }), index('run_user_started_idx').on(table.userId, table.startedAt)],
);

/** A saved copy of a workflow's graph, taken automatically while editing or by hand with a label. */
export const workflowVersion = pgTable(
  'workflow_version',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    workflowId: text('workflow_id').notNull(),
    label: text('label'),
    auto: boolean('auto').notNull().default(true),
    nodeCount: integer('node_count').notNull(),
    edgeCount: integer('edge_count').notNull(),
    data: jsonb('data').notNull(),
    createdAt: createdAt(),
  },
  (table) => [index('workflow_version_lookup_idx').on(table.userId, table.workflowId, table.createdAt)],
);

/** A public, read-only snapshot of a workflow at `/s/<slug>`, which anyone can remix. */
export const share = pgTable(
  'share',
  {
    slug: text('slug').primaryKey(),
    userId: text('user_id').notNull(),
    workflowId: text('workflow_id').notNull(),
    authorName: text('author_name').notNull(),
    data: jsonb('data').notNull(),
    views: integer('views').notNull().default(0),
    remixes: integer('remixes').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('share_owner_idx').on(table.userId, table.workflowId)],
);

/**
 * An app connected for real: the credential sealed with the server's key
 * (see `server/credentials/crypto.ts`), and what the studio may show about it.
 * One per app per person; markers stay in `workspace.connections`.
 */
export const connection = pgTable(
  'connection',
  {
    userId: text('user_id').notNull(),
    connectorId: text('connector_id').notNull(),
    kind: text('kind').notNull(),
    account: text('account').notNull(),
    secret: text('secret').notNull(),
    hint: text('hint').notNull(),
    status: text('status').notNull().default('connected'),
    error: text('error'),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.connectorId] })],
);

/** One counter per limited thing per window: `write:user_…`, `remix:203.0.113.7`. See `server/rate-limit.ts`. */
export const rateLimit = pgTable(
  'relay_rate_limit',
  {
    key: text('key').primaryKey(),
    windowStart: bigint('window_start', { mode: 'number' }).notNull(),
    count: integer('count').notNull(),
  },
  (table) => [index('relay_rate_limit_window_idx').on(table.windowStart)],
);

/**
 * Accounts that were deleted. A session token outlives the account by up to
 * a minute, and a tab holding one would otherwise sync its copy straight
 * back; a write from an id listed here is refused instead.
 */
export const deletedUser = pgTable('relay_deleted_user', {
  userId: text('user_id').primaryKey(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }).notNull().defaultNow(),
});

export const schema = { workspace, workflow, run, workflowVersion, share, connection, rateLimit, deletedUser };
