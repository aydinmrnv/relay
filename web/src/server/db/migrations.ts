/**
 * Schema changes, applied in order the first time a server instance touches
 * the database (see `index.ts`). Pending ones run together in one
 * transaction, under an advisory lock, so two cold starts racing each other
 * cannot both apply them. Never edit a migration that has shipped; add the next one.
 *
 * `schema.ts` describes the same tables for queries; keep the two in step.
 */
export interface Migration {
  id: string;
  /**
   * The SQL, or a function of the migrations this database had already
   * applied before this start, for the one migration that must behave
   * differently on a database it has never seen.
   */
  sql: string | ((appliedBefore: ReadonlySet<string>) => string);
}

export const MIGRATIONS: Migration[] = [
  {
    // The studio's own tables. This once also made sign-in tables named
    // `user`, `session`, `account`, `verification` and `rate_limit`, which
    // the next migration dropped again when accounts moved to Clerk. A
    // database that applied it then has already been through both; a new one
    // never gets those tables, so nothing here can touch a table of the same
    // name that belongs to something else in the same database.
    id: '0001_accounts_and_workspaces',
    sql: `
      CREATE TABLE IF NOT EXISTS workspace (
        user_id text PRIMARY KEY,
        settings jsonb,
        brand jsonb,
        connections jsonb,
        tours_seen jsonb,
        checklist_dismissed boolean NOT NULL DEFAULT false,
        onboarding jsonb,
        onboarded_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS workflow (
        user_id text NOT NULL,
        id text NOT NULL,
        name text NOT NULL,
        data jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, id)
      );

      CREATE TABLE IF NOT EXISTS run (
        user_id text NOT NULL,
        id text NOT NULL,
        workflow_id text NOT NULL,
        status text NOT NULL,
        started_at timestamptz NOT NULL,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, id)
      );
      CREATE INDEX IF NOT EXISTS run_user_started_idx ON run (user_id, started_at);

      CREATE TABLE IF NOT EXISTS workflow_version (
        id text PRIMARY KEY,
        user_id text NOT NULL,
        workflow_id text NOT NULL,
        label text,
        auto boolean NOT NULL DEFAULT true,
        node_count integer NOT NULL,
        edge_count integer NOT NULL,
        data jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS workflow_version_lookup_idx ON workflow_version (user_id, workflow_id, created_at);

      CREATE TABLE IF NOT EXISTS share (
        slug text PRIMARY KEY,
        user_id text NOT NULL,
        workflow_id text NOT NULL,
        author_name text NOT NULL,
        data jsonb NOT NULL,
        views integer NOT NULL DEFAULT 0,
        remixes integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS share_owner_idx ON share (user_id, workflow_id);
    `,
  },
  {
    // Accounts moved to Clerk: people are Clerk user ids now, with no row
    // here to point at, and the old sign-in tables are no longer used. Only a
    // database that was given those tables by the first migration, on an
    // earlier start, has them dropped: on any other, `user` and `session`
    // are somebody else's, and are left alone.
    id: '0002_accounts_on_clerk',
    sql: (appliedBefore) =>
      appliedBefore.has('0001_accounts_and_workspaces')
        ? `
      ALTER TABLE workspace DROP CONSTRAINT IF EXISTS workspace_user_id_fkey;
      ALTER TABLE workflow DROP CONSTRAINT IF EXISTS workflow_user_id_fkey;
      ALTER TABLE run DROP CONSTRAINT IF EXISTS run_user_id_fkey;
      ALTER TABLE workflow_version DROP CONSTRAINT IF EXISTS workflow_version_user_id_fkey;
      ALTER TABLE share DROP CONSTRAINT IF EXISTS share_user_id_fkey;
      DROP TABLE IF EXISTS session;
      DROP TABLE IF EXISTS account;
      DROP TABLE IF EXISTS verification;
      DROP TABLE IF EXISTS rate_limit;
      DROP TABLE IF EXISTS "user";
    `
        : 'SELECT 1;',
  },
  {
    // Apps connected for real: an encrypted credential per app per person.
    id: '0003_connection_credentials',
    sql: `
      CREATE TABLE IF NOT EXISTS connection (
        user_id text NOT NULL,
        connector_id text NOT NULL,
        kind text NOT NULL,
        account text NOT NULL,
        secret text NOT NULL,
        hint text NOT NULL,
        status text NOT NULL DEFAULT 'connected',
        error text,
        checked_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, connector_id)
      );
    `,
  },
  {
    // Request counters, so one account or one address cannot use the studio's
    // server as a free probe or fill its database; and the ids of deleted
    // accounts, so a tab still holding a session cannot write their data back.
    id: '0004_rate_limits_and_deleted_users',
    sql: `
      CREATE TABLE IF NOT EXISTS relay_rate_limit (
        key text PRIMARY KEY,
        window_start bigint NOT NULL,
        count integer NOT NULL
      );
      CREATE INDEX IF NOT EXISTS relay_rate_limit_window_idx ON relay_rate_limit (window_start);

      CREATE TABLE IF NOT EXISTS relay_deleted_user (
        user_id text PRIMARY KEY,
        deleted_at timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
];
