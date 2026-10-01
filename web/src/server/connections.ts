/**
 * Apps a person connected for real. The credential is checked with the app
 * before it is kept, sealed before it reaches the database, and never sent
 * back: the browser gets a `Connection` with a summary instead.
 */
import { and, eq } from 'drizzle-orm';
import { credentialHint, credentialSpec, type CredentialSpec } from '@/lib/connectors/credentials';
import type { Connection, CredentialKind } from '@/lib/workflow/schema';
import { ApiError } from './api';
import { seal, unseal } from './credentials/crypto';
import { checkCredential, sendTestMessage, type CheckResult } from './credentials/verify';
import { getDb } from './db';
import { connection } from './db/schema';
import { BRAND } from '@/lib/brand';
import { CREDENTIALS_ENABLED, CREDENTIALS_UNAVAILABLE_REASON, IS_PRODUCTION } from './env';

/** Refuses when this server cannot keep credentials: accounts off, or no key in production. */
export function assertCredentials(): void {
  if (!CREDENTIALS_ENABLED) throw new ApiError(503, 'CREDENTIALS_DISABLED', credentialsUnavailable());
}

/** Why, for whoever is asking. In production that is a stranger, who is not told which setting the server is missing. */
export function credentialsUnavailable(): string {
  return IS_PRODUCTION ? 'Real connections are not switched on for this server.' : (CREDENTIALS_UNAVAILABLE_REASON ?? 'Real connections are not switched on for this server.');
}

type Row = typeof connection.$inferSelect;

function toConnection(row: Row): Connection {
  return {
    connectorId: row.connectorId,
    status: row.status === 'error' ? 'error' : 'connected',
    account: row.account,
    connectedAt: row.createdAt.toISOString(),
    credential: {
      kind: row.kind as CredentialKind,
      hint: row.hint,
      checkedAt: row.checkedAt.toISOString(),
      ...(row.error === null ? {} : { error: row.error }),
    },
  };
}

function specFor(connectorId: string): CredentialSpec {
  const spec = credentialSpec(connectorId);
  if (spec === undefined) throw new ApiError(404, 'NOT_CONNECTABLE', 'This app cannot be connected for real yet. Mark it ready instead.');
  return spec;
}

/** A failed check, as the error the route answers with. */
function failure(spec: CredentialSpec, result: Extract<CheckResult, { ok: false }>): ApiError {
  return result.reason === 'unreachable' ? new ApiError(502, 'APP_UNREACHABLE', result.message) : new ApiError(422, 'CREDENTIAL_REFUSED', result.message, { kind: spec.kind });
}

async function find(userId: string, connectorId: string): Promise<Row> {
  const db = await getDb();
  const [row] = await db.select().from(connection).where(and(eq(connection.userId, userId), eq(connection.connectorId, connectorId)));
  if (row === undefined) throw new ApiError(404, 'NOT_CONNECTED', 'This app is not connected. Connect it first.');
  return row;
}

/** Every app this person connected for real, keyed by app. */
export async function listConnections(userId: string): Promise<Record<string, Connection>> {
  const db = await getDb();
  const rows = await db.select().from(connection).where(eq(connection.userId, userId));
  return Object.fromEntries(rows.map((row) => [row.connectorId, toConnection(row)]));
}

/** Checks the credential with the app, then keeps it, replacing any earlier one for the same app. */
export async function connectApp(userId: string, connectorId: string, secret: string, label: string | undefined): Promise<Connection> {
  const spec = specFor(connectorId);
  const value = secret.trim();
  if (!spec.input.pattern.test(value)) throw new ApiError(400, 'CREDENTIAL_SHAPE', spec.input.mismatch);
  const result = await checkCredential(spec.kind, value);
  if (!result.ok) throw failure(spec, result);
  const hint = credentialHint(value);
  const account = label?.trim() || result.account || `${spec.name} ···${hint}`;
  const sealed = await seal(value, userId, connectorId);
  const now = new Date();
  const db = await getDb();
  const values = { userId, connectorId, kind: spec.kind, account, secret: sealed, hint, status: 'connected', error: null, checkedAt: now, createdAt: now, updatedAt: now };
  const [row] = await db
    .insert(connection)
    .values(values)
    .onConflictDoUpdate({ target: [connection.userId, connection.connectorId], set: { kind: values.kind, account, secret: sealed, hint, status: 'connected', error: null, checkedAt: now, createdAt: now, updatedAt: now } })
    .returning();
  return toConnection(row!);
}

/**
 * Asks the app again. A refusal is recorded, so the studio can show the
 * connection as failing; no answer at all changes nothing and says so.
 */
export async function recheckApp(userId: string, connectorId: string): Promise<Connection> {
  const spec = specFor(connectorId);
  const row = await find(userId, connectorId);
  const opened = await unseal(row.secret, userId, connectorId);
  const result = await checkCredential(spec.kind, opened.value);
  if (!result.ok && result.reason === 'unreachable') throw failure(spec, result);
  const now = new Date();
  const db = await getDb();
  // Opened with a key that is being retired: seal it again with the current one, so the old key can go.
  const resealed = opened.stale ? { secret: await seal(opened.value, userId, connectorId) } : {};
  const [updated] = await db
    .update(connection)
    .set(result.ok ? { status: 'connected', error: null, checkedAt: now, updatedAt: now, ...resealed } : { status: 'error', error: result.message, checkedAt: now, updatedAt: now, ...resealed })
    .where(and(eq(connection.userId, userId), eq(connection.connectorId, connectorId)))
    .returning();
  return toConnection(updated!);
}

/** Posts a short message through the connection, so the person sees it arrive where they expect. */
export async function testApp(userId: string, connectorId: string): Promise<Connection> {
  const spec = specFor(connectorId);
  const row = await find(userId, connectorId);
  // What is true today: the studio keeps the webhook and can post a test
  // through it. A run does not post through it yet; an exported workflow
  // posts with the same URL held as a secret in its own repository.
  const text = `${BRAND.name}: this webhook works, and test messages like this one arrive here. An exported workflow posts here once the same URL is set as a secret in its repository.`;
  const result = await sendTestMessage(spec.kind, (await unseal(row.secret, userId, connectorId)).value, text);
  if (!result.ok && result.reason === 'unreachable') throw failure(spec, result);
  const now = new Date();
  const db = await getDb();
  const [updated] = await db
    .update(connection)
    .set(result.ok ? { status: 'connected', error: null, checkedAt: now, updatedAt: now } : { status: 'error', error: result.message, checkedAt: now, updatedAt: now })
    .where(and(eq(connection.userId, userId), eq(connection.connectorId, connectorId)))
    .returning();
  // Refused: the connection is now failing, and the browser gets its new state with the error.
  if (!result.ok) throw new ApiError(422, 'CREDENTIAL_REFUSED', result.message, { connection: toConnection(updated!) });
  return toConnection(updated!);
}

/** Forgets the credential. Revoking it in the app itself is the person's to do; the studio says so. */
export async function disconnectApp(userId: string, connectorId: string): Promise<void> {
  const db = await getDb();
  await db.delete(connection).where(and(eq(connection.userId, userId), eq(connection.connectorId, connectorId)));
}

export async function deleteConnections(userId: string): Promise<void> {
  const db = await getDb();
  await db.delete(connection).where(eq(connection.userId, userId));
}

/**
 * The workspace's connections as the browser should see them: markers from
 * the workspace row, and every real connection from its own table, which
 * wins. A summary the browser kept for a credential that is gone (deleted
 * from another tab, say) is dropped, so nothing claims a connection that
 * does not exist.
 */
export function mergeConnections(saved: Record<string, unknown> | null, real: Record<string, Connection>): Record<string, unknown> {
  const markers = Object.entries(saved ?? {}).filter(([, value]) => typeof value === 'object' && value !== null && (value as Partial<Connection>).credential === undefined);
  return { ...Object.fromEntries(markers), ...real };
}
