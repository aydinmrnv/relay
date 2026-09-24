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
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: '0001_accounts_and_workspaces',
    sql: `
      CREATE TABLE IF NOT EXISTS "user" (
        id text PRIMARY KEY,
        name text NOT NULL,
        email text NOT NULL UNIQUE,
        email_verified boolean NOT NULL DEFAULT false,
        image text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS session (
        id text PRIMARY KEY,
        expires_at timestamptz NOT NULL,
        token text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        ip_address text,
        user_agent text,
        user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS session_user_idx ON session (user_id);

      CREATE TABLE IF NOT EXISTS account (
        id text PRIMARY KEY,
        account_id text NOT NULL,
        provider_id text NOT NULL,
        user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        access_token text,
        refresh_token text,
        id_token text,
        access_token_expires_at timestamptz,
        refresh_token_expires_at timestamptz,
        scope text,
        password text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS account_user_idx ON account (user_id);

      CREATE TABLE IF NOT EXISTS verification (
        id text PRIMARY KEY,
        identifier text NOT NULL,
        value text NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification (identifier);

      CREATE TABLE IF NOT EXISTS rate_limit (
        id text PRIMARY KEY,
        key text NOT NULL UNIQUE,
        count integer NOT NULL,
        last_request bigint NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace (
        user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
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
        user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        id text NOT NULL,
        name text NOT NULL,
        data jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, id)
      );

      CREATE TABLE IF NOT EXISTS run (
        user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
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
        user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
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
        user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
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
    // here to point at, and the old sign-in tables are no longer used.
    id: '0002_accounts_on_clerk',
    sql: `
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
    `,
  },
];
