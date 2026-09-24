/**
 * The database, in two halves. The first four tables are Better Auth's own
 * (users, sessions, linked sign-ins, one-time tokens) plus its rate-limit
 * counters; the rest are the studio's: one workspace row per person, and
 * their workflows, runs, saved versions and public share links.
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
/* Better Auth                                                          */
/* ------------------------------------------------------------------ */

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('session_user_idx').on(table.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('account_user_idx').on(table.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);

export const rateLimit = pgTable('rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
});

/* ------------------------------------------------------------------ */
/* The studio                                                           */
/* ------------------------------------------------------------------ */

/** Everything about a person's studio that is not a workflow or a run. */
export const workspace = pgTable('workspace', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  settings: jsonb('settings'),
  brand: jsonb('brand'),
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
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
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
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
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
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
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
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
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

export const schema = { user, session, account, verification, rateLimit, workspace, workflow, run, workflowVersion, share };
