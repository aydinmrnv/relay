/**
 * A person's studio in the database: their workspace settings, workflows,
 * runs, saved versions and share links. Route handlers call these after
 * checking who is asking; nothing here trusts a user id it was not given.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { customAlphabet, nanoid } from 'nanoid';
import type { ShareSummary, VersionSummary } from '@/lib/cloud/types';
import type { Run, Workflow } from '@/lib/workflow/schema';
import { redactForSharing } from '@/lib/workflow/redact';
import { ApiError } from './api';
import { listConnections, mergeConnections } from './connections';
import { getDb } from './db';
import { connection, deletedUser, run, share, workflow, workflowVersion, workspace } from './db/schema';
import type { OnboardingAnswers } from './validate';

export const MAX_WORKFLOWS = 300;
/** The same number a browser keeps and a load returns: a run past it is gone everywhere, not hidden somewhere. */
const MAX_RUNS = 200;
const MAX_AUTO_VERSIONS = 40;
const MAX_NAMED_VERSIONS = 50;
/**
 * Everything one account may store, in bytes of JSON: workflows, their saved
 * versions and runs together. Far above what the per-item limits allow a
 * person to reach by working; it is there so that nobody can fill the
 * database by saving a megabyte three hundred times, with ninety versions each.
 */
const ACCOUNT_MAX_BYTES = 60_000_000;
/**
 * How much of a workspace one answer carries. The host caps a response at a
 * few megabytes, and an account past that could never load at all; what does
 * not fit is named instead, and the studio fetches those one by one.
 */
const LOAD_BUDGET_BYTES = 3_000_000;
/** While someone is editing, keep at most one automatic version per this long. */
const AUTO_VERSION_EVERY_MS = 10 * 60_000;

export interface WorkspaceRecord {
  settings: Record<string, unknown> | null;
  connections: Record<string, unknown> | null;
  toursSeen: Record<string, boolean> | null;
  checklistDismissed: boolean;
  onboarding: OnboardingAnswers | null;
  onboardedAt: string | null;
}

export interface WorkspacePayload {
  workspace: WorkspaceRecord;
  workflows: Workflow[];
  /** Workflow id → the server's revision of it, which the next save must name. */
  revisions: Record<string, string>;
  runs: Run[];
  /** Workflow id → share slug, for the ones that are public. */
  shares: Record<string, string>;
  /** What did not fit in this answer, by id: fetch each from `/api/workflows/<id>` or `/api/runs/<id>`. */
  rest: { workflows: string[]; runs: string[] };
}

export async function ensureWorkspace(userId: string): Promise<WorkspaceRecord> {
  const db = await getDb();
  await db.insert(workspace).values({ userId }).onConflictDoNothing();
  const [row] = await db.select().from(workspace).where(eq(workspace.userId, userId));
  if (row === undefined) throw new ApiError(500, 'NO_WORKSPACE', 'Could not create your workspace.');
  return {
    settings: (row.settings as Record<string, unknown> | null) ?? null,
    connections: (row.connections as Record<string, unknown> | null) ?? null,
    toursSeen: (row.toursSeen as Record<string, boolean> | null) ?? null,
    checklistDismissed: row.checklistDismissed,
    onboarding: (row.onboarding as OnboardingAnswers | null) ?? null,
    onboardedAt: row.onboardedAt?.toISOString() ?? null,
  };
}

export async function loadWorkspace(userId: string): Promise<WorkspacePayload> {
  const db = await getDb();
  const record = await ensureWorkspace(userId);
  const [workflows, runs, shares, connections] = await Promise.all([
    db.select({ id: workflow.id, data: workflow.data, updatedAt: workflow.updatedAt }).from(workflow).where(eq(workflow.userId, userId)).orderBy(desc(workflow.updatedAt)),
    db.select({ id: run.id, data: run.data }).from(run).where(eq(run.userId, userId)).orderBy(desc(run.startedAt)).limit(MAX_RUNS),
    db.select({ workflowId: share.workflowId, slug: share.slug }).from(share).where(eq(share.userId, userId)),
    listConnections(userId),
  ]);
  // Workflows first, newest first, then runs, until the answer is as large as
  // it may be. Every workflow's revision is sent whether or not it fits.
  let budget = LOAD_BUDGET_BYTES;
  const fits = (data: unknown): boolean => {
    const size = Buffer.byteLength(JSON.stringify(data), 'utf8');
    if (size > budget) return false;
    budget -= size;
    return true;
  };
  const sentWorkflows: Workflow[] = [];
  const rest = { workflows: [] as string[], runs: [] as string[] };
  for (const row of workflows) {
    if (fits(row.data)) sentWorkflows.push(row.data as Workflow);
    else rest.workflows.push(row.id);
  }
  const sentRuns: Run[] = [];
  for (const row of runs) {
    if (fits(row.data)) sentRuns.push(row.data as Run);
    else rest.runs.push(row.id);
  }
  return {
    workspace: { ...record, connections: mergeConnections(record.connections, connections) },
    workflows: sentWorkflows,
    revisions: Object.fromEntries(workflows.map((row) => [row.id, row.updatedAt.toISOString()])),
    runs: sentRuns,
    shares: Object.fromEntries(shares.map((row) => [row.workflowId, row.slug])),
    rest,
  };
}

/** One workflow, for a workspace too large to send in one answer. */
export async function getWorkflow(userId: string, workflowId: string): Promise<{ workflow: Workflow; revision: string } | null> {
  const db = await getDb();
  const [row] = await db.select({ data: workflow.data, updatedAt: workflow.updatedAt }).from(workflow).where(and(eq(workflow.userId, userId), eq(workflow.id, workflowId)));
  return row === undefined ? null : { workflow: row.data as Workflow, revision: row.updatedAt.toISOString() };
}

export async function getRun(userId: string, runId: string): Promise<Run | null> {
  const db = await getDb();
  const [row] = await db.select({ data: run.data }).from(run).where(and(eq(run.userId, userId), eq(run.id, runId)));
  return row === undefined ? null : (row.data as Run);
}

/**
 * Everything the studio holds for one person, gone: on account deletion. One
 * transaction, so a failure leaves either all of it or none; and the id is
 * written down as deleted in the same breath, so a tab still holding a
 * session cannot sync a copy back in the minute its token outlives the
 * account (see `withUser`).
 */
export async function deleteUserData(userId: string): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.insert(deletedUser).values({ userId }).onConflictDoNothing();
    await tx.delete(connection).where(eq(connection.userId, userId));
    await tx.delete(share).where(eq(share.userId, userId));
    await tx.delete(workflowVersion).where(eq(workflowVersion.userId, userId));
    await tx.delete(run).where(eq(run.userId, userId));
    await tx.delete(workflow).where(eq(workflow.userId, userId));
    await tx.delete(workspace).where(eq(workspace.userId, userId));
  });
  // The record only has to outlast the last session token; a day is generous. Swept here, where deletions happen.
  await db.delete(deletedUser).where(sql`${deletedUser.deletedAt} < now() - interval '1 day'`).catch(() => undefined);
}

/** Refuses a save that would take the account past what it may store. */
async function assertRoom(userId: string, addingBytes: number): Promise<void> {
  const db = await getDb();
  const result = (await db.execute(sql`
    SELECT
      (SELECT coalesce(sum(pg_column_size(data)), 0) FROM workflow WHERE user_id = ${userId}) +
      (SELECT coalesce(sum(pg_column_size(data)), 0) FROM workflow_version WHERE user_id = ${userId}) +
      (SELECT coalesce(sum(pg_column_size(data)), 0) FROM run WHERE user_id = ${userId}) AS bytes`)) as unknown as { rows?: Array<{ bytes: number | string }> } | Array<{ bytes: number | string }>;
  const rows = Array.isArray(result) ? result : (result.rows ?? []);
  const used = Number(rows[0]?.bytes ?? 0);
  if (used + addingBytes > ACCOUNT_MAX_BYTES) {
    throw new ApiError(413, 'ACCOUNT_FULL', `Your account is full (${Math.round(used / 1_000_000)} MB of ${Math.round(ACCOUNT_MAX_BYTES / 1_000_000)} MB). Delete old workflows, saved versions or runs to make room.`);
  }
}

export async function patchWorkspace(userId: string, patch: Partial<Omit<WorkspaceRecord, 'onboarding' | 'onboardedAt'>>): Promise<void> {
  const db = await getDb();
  await ensureWorkspace(userId);
  const set: Partial<typeof workspace.$inferInsert> = { updatedAt: new Date() };
  if (patch.settings !== undefined) set.settings = patch.settings;
  if (patch.connections !== undefined) set.connections = patch.connections;
  if (patch.toursSeen !== undefined) set.toursSeen = patch.toursSeen;
  if (patch.checklistDismissed !== undefined) set.checklistDismissed = patch.checklistDismissed;
  await db.update(workspace).set(set).where(eq(workspace.userId, userId));
}

export async function completeOnboarding(userId: string, answers: OnboardingAnswers): Promise<void> {
  const db = await getDb();
  await ensureWorkspace(userId);
  await db.update(workspace).set({ onboarding: answers, onboardedAt: new Date(), updatedAt: new Date() }).where(eq(workspace.userId, userId));
}

/* ------------------------------------------------------------------ */
/* Workflows                                                            */
/* ------------------------------------------------------------------ */

export interface SaveOptions {
  /**
   * The revision the client last saw, `null` for a workflow it believes is
   * new. A save against anything but the current revision is a conflict:
   * the server keeps its copy and hands it back, rather than letting a stale
   * tab or device silently replace newer work.
   */
  baseRevision: string | null;
  /** Imports skip the check: they bring in copies that have never been synced. */
  force?: boolean;
}

/** Whether two JSON values are the same whatever order their keys are in: Postgres hands `jsonb` back with its own. */
function sameJson(a: unknown, b: unknown): boolean {
  const ordered = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(ordered);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
    }
    return value;
  };
  return JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
}

export async function saveWorkflow(userId: string, next: Workflow, options: SaveOptions): Promise<{ revision: string }> {
  const db = await getDb();
  await assertRoom(userId, Buffer.byteLength(JSON.stringify(next), 'utf8'));
  // Read, check and write as one step, with the row locked in between: two
  // saves against the same revision cannot both pass the check, and the
  // version kept of the old graph is the one that was really replaced.
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ data: workflow.data, updatedAt: workflow.updatedAt })
      .from(workflow)
      .where(and(eq(workflow.userId, userId), eq(workflow.id, next.id)))
      .for('update');

    if (existing === undefined) {
      // Absent here but known to the client means it was deleted elsewhere;
      // an edit made since wins over that delete, so it is saved again.
      const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(workflow).where(eq(workflow.userId, userId));
      if (count >= MAX_WORKFLOWS) throw new ApiError(409, 'TOO_MANY_WORKFLOWS', `An account can hold ${MAX_WORKFLOWS} workflows. Delete one to make room.`);
    } else {
      const revision = existing.updatedAt.toISOString();
      if (options.force !== true && options.baseRevision !== revision) {
        // The same save arriving twice (a tab that sent it as it closed, and
        // sends it again when it opens) is not two people editing: what is
        // stored is already what was asked for, so say so and change nothing.
        if (sameJson(existing.data, next)) return { revision };
        throw new ApiError(409, 'CONFLICT', 'This workflow was changed somewhere else.', { workflow: existing.data, revision });
      }
      // Before the first save of an editing session, keep what it looked like,
      // so "restore" can undo a whole session rather than a keystroke.
      const previous = existing.data as Workflow;
      if (graphChanged(previous, next)) await maybeAutoVersion(tx, userId, previous);
    }

    // Never earlier than the revision it replaces: two saves in the same
    // millisecond must still have different revisions.
    const now = new Date(Math.max(Date.now(), (existing?.updatedAt.getTime() ?? 0) + 1));
    await tx
      .insert(workflow)
      .values({ userId, id: next.id, name: next.name.slice(0, 200), data: next, createdAt: safeDate(next.createdAt), updatedAt: now })
      .onConflictDoUpdate({ target: [workflow.userId, workflow.id], set: { name: next.name.slice(0, 200), data: next, updatedAt: now } });
    return { revision: now.toISOString() };
  });
}

/** The account's copy of a workflow, or a 404: shares and versions only exist for workflows that do. */
async function requireWorkflow(userId: string, workflowId: string): Promise<void> {
  const db = await getDb();
  const [row] = await db.select({ id: workflow.id }).from(workflow).where(and(eq(workflow.userId, userId), eq(workflow.id, workflowId)));
  if (row === undefined) throw new ApiError(404, 'NOT_FOUND', 'Save the workflow to your account first, then try again.');
}

/** The workflow and everything that hangs off it, together: a public link must never outlive the workflow it shows. */
export async function deleteWorkflow(userId: string, workflowId: string): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.delete(share).where(and(eq(share.userId, userId), eq(share.workflowId, workflowId)));
    await tx.delete(workflowVersion).where(and(eq(workflowVersion.userId, userId), eq(workflowVersion.workflowId, workflowId)));
    await tx.delete(run).where(and(eq(run.userId, userId), eq(run.workflowId, workflowId)));
    await tx.delete(workflow).where(and(eq(workflow.userId, userId), eq(workflow.id, workflowId)));
  });
}

function graphChanged(a: Workflow, b: Workflow): boolean {
  return a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length || JSON.stringify([a.nodes, a.edges]) !== JSON.stringify([b.nodes, b.edges]);
}

type Executor = Pick<Awaited<ReturnType<typeof getDb>>, 'select' | 'insert' | 'execute'>;

async function maybeAutoVersion(db: Executor, userId: string, snapshot: Workflow): Promise<void> {
  const [latest] = await db
    .select({ createdAt: workflowVersion.createdAt })
    .from(workflowVersion)
    .where(and(eq(workflowVersion.userId, userId), eq(workflowVersion.workflowId, snapshot.id)))
    .orderBy(desc(workflowVersion.createdAt))
    .limit(1);
  if (latest !== undefined && Date.now() - latest.createdAt.getTime() < AUTO_VERSION_EVERY_MS) return;
  await insertVersion(db, userId, snapshot, null, true);
}

/* ------------------------------------------------------------------ */
/* Versions                                                             */
/* ------------------------------------------------------------------ */

async function insertVersion(db: Executor, userId: string, snapshot: Workflow, label: string | null, auto: boolean): Promise<VersionSummary> {
  const row = {
    id: `ver_${nanoid(12)}`,
    userId,
    workflowId: snapshot.id,
    label,
    auto,
    nodeCount: snapshot.nodes.length,
    edgeCount: snapshot.edges.length,
    data: snapshot,
    createdAt: new Date(),
  };
  await db.insert(workflowVersion).values(row);
  if (auto) {
    // Named versions are kept; automatic ones roll off.
    await db.execute(sql`
      DELETE FROM workflow_version
      WHERE user_id = ${userId} AND workflow_id = ${snapshot.id} AND auto
        AND id NOT IN (
          SELECT id FROM workflow_version
          WHERE user_id = ${userId} AND workflow_id = ${snapshot.id} AND auto
          ORDER BY created_at DESC LIMIT ${MAX_AUTO_VERSIONS}
        )`);
  }
  return { id: row.id, label, auto, nodeCount: row.nodeCount, edgeCount: row.edgeCount, createdAt: row.createdAt.toISOString() };
}

export async function listVersions(userId: string, workflowId: string): Promise<VersionSummary[]> {
  const db = await getDb();
  const rows = await db
    .select({ id: workflowVersion.id, label: workflowVersion.label, auto: workflowVersion.auto, nodeCount: workflowVersion.nodeCount, edgeCount: workflowVersion.edgeCount, createdAt: workflowVersion.createdAt })
    .from(workflowVersion)
    .where(and(eq(workflowVersion.userId, userId), eq(workflowVersion.workflowId, workflowId)))
    .orderBy(desc(workflowVersion.createdAt))
    // Every version that can exist is listed: a version the list hides cannot be restored or deleted.
    .limit(MAX_AUTO_VERSIONS + MAX_NAMED_VERSIONS);
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

export async function saveNamedVersion(userId: string, snapshot: Workflow, label: string): Promise<VersionSummary> {
  await requireWorkflow(userId, snapshot.id);
  const db = await getDb();
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(workflowVersion)
    .where(and(eq(workflowVersion.userId, userId), eq(workflowVersion.workflowId, snapshot.id), eq(workflowVersion.auto, false)));
  if (count >= MAX_NAMED_VERSIONS) throw new ApiError(409, 'TOO_MANY_VERSIONS', `A workflow can keep ${MAX_NAMED_VERSIONS} named versions. Delete one to save another.`);
  await assertRoom(userId, Buffer.byteLength(JSON.stringify(snapshot), 'utf8'));
  return insertVersion(db, userId, snapshot, label.trim().slice(0, 120) || 'Saved version', false);
}

export async function getVersion(userId: string, workflowId: string, versionId: string): Promise<Workflow | null> {
  const db = await getDb();
  const [row] = await db
    .select({ data: workflowVersion.data })
    .from(workflowVersion)
    .where(and(eq(workflowVersion.userId, userId), eq(workflowVersion.workflowId, workflowId), eq(workflowVersion.id, versionId)));
  return row === undefined ? null : (row.data as Workflow);
}

export async function deleteVersion(userId: string, workflowId: string, versionId: string): Promise<void> {
  const db = await getDb();
  await db.delete(workflowVersion).where(and(eq(workflowVersion.userId, userId), eq(workflowVersion.workflowId, workflowId), eq(workflowVersion.id, versionId)));
}

/* ------------------------------------------------------------------ */
/* Runs                                                                 */
/* ------------------------------------------------------------------ */

export async function saveRun(userId: string, next: Run): Promise<void> {
  const db = await getDb();
  await db
    .insert(run)
    .values({ userId, id: next.id, workflowId: next.workflowId, status: next.status, startedAt: safeDate(next.startedAt), data: next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [run.userId, run.id], set: { status: next.status, data: next, updatedAt: new Date() } });
  // Whatever its status: a run saved as "running" and never finished would otherwise be kept for ever.
  await db.execute(sql`
    DELETE FROM run WHERE user_id = ${userId} AND id IN (
      SELECT id FROM run WHERE user_id = ${userId} ORDER BY started_at DESC OFFSET ${MAX_RUNS}
    )`);
}

/** Several runs at once, for an import: one statement to save them and one to prune, not two per run. */
export async function saveRuns(userId: string, runs: Run[]): Promise<void> {
  if (runs.length === 0) return;
  const db = await getDb();
  const now = new Date();
  await db
    .insert(run)
    .values(runs.map((next) => ({ userId, id: next.id, workflowId: next.workflowId, status: next.status, startedAt: safeDate(next.startedAt), data: next, updatedAt: now })))
    .onConflictDoUpdate({ target: [run.userId, run.id], set: { status: sql`excluded.status`, data: sql`excluded.data`, updatedAt: now } });
  await db.execute(sql`
    DELETE FROM run WHERE user_id = ${userId} AND id IN (
      SELECT id FROM run WHERE user_id = ${userId} ORDER BY started_at DESC OFFSET ${MAX_RUNS}
    )`);
}

/** Which of these workflow ids the account has. */
export async function existingWorkflowIds(userId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const db = await getDb();
  const rows = await db.select({ id: workflow.id }).from(workflow).where(and(eq(workflow.userId, userId), inArray(workflow.id, ids)));
  return new Set(rows.map((row) => row.id));
}

export async function countWorkflows(userId: string): Promise<number> {
  const db = await getDb();
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(workflow).where(eq(workflow.userId, userId));
  return count;
}

export async function deleteRun(userId: string, runId: string): Promise<void> {
  const db = await getDb();
  await db.delete(run).where(and(eq(run.userId, userId), eq(run.id, runId)));
}

export async function clearRuns(userId: string): Promise<void> {
  const db = await getDb();
  await db.delete(run).where(eq(run.userId, userId));
}

/* ------------------------------------------------------------------ */
/* Share links                                                          */
/* ------------------------------------------------------------------ */

const slugId = customAlphabet('abcdefghijkmnpqrstuvwxyz23456789', 10);

export interface PublicShare extends ShareSummary {
  authorName: string;
  workflow: Workflow;
}

export async function getShareFor(userId: string, workflowId: string): Promise<ShareSummary | null> {
  const db = await getDb();
  const [row] = await db.select().from(share).where(and(eq(share.userId, userId), eq(share.workflowId, workflowId)));
  return row === undefined ? null : summarise(row);
}

/** Publishes (or refreshes) the public copy. Secrets in node settings never leave the account. */
export async function publishShare(userId: string, authorName: string, source: Workflow): Promise<ShareSummary> {
  await requireWorkflow(userId, source.id);
  const db = await getDb();
  const snapshot = redactForSharing(source);
  const existing = await getShareFor(userId, source.id);
  if (existing !== null) {
    await db.update(share).set({ data: snapshot, authorName, updatedAt: new Date() }).where(eq(share.slug, existing.slug));
    return { ...existing, updatedAt: new Date().toISOString() };
  }
  const row = { slug: slugId(), userId, workflowId: source.id, authorName, data: snapshot, createdAt: new Date(), updatedAt: new Date() };
  await db.insert(share).values(row);
  return { slug: row.slug, views: 0, remixes: 0, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

export async function unpublishShare(userId: string, workflowId: string): Promise<void> {
  const db = await getDb();
  await db.delete(share).where(and(eq(share.userId, userId), eq(share.workflowId, workflowId)));
}

export async function getPublicShare(slug: string): Promise<PublicShare | null> {
  if (!/^[a-z0-9]{6,20}$/.test(slug)) return null;
  const db = await getDb();
  const [row] = await db.select().from(share).where(eq(share.slug, slug));
  return row === undefined ? null : { ...summarise(row), authorName: row.authorName, workflow: row.data as Workflow };
}

/**
 * Counts a view or a remix. Not the owner's own: a number that goes up when
 * its author looks at their page says nothing. `viewer` is the signed-in
 * person, or null.
 */
export async function countShare(slug: string, what: 'views' | 'remixes', viewer: string | null): Promise<void> {
  if (!/^[a-z0-9]{6,20}$/.test(slug)) return;
  const db = await getDb();
  await db
    .update(share)
    .set(what === 'views' ? { views: sql`${share.views} + 1` } : { remixes: sql`${share.remixes} + 1` })
    .where(viewer === null ? eq(share.slug, slug) : and(eq(share.slug, slug), sql`${share.userId} <> ${viewer}`));
}

function summarise(row: typeof share.$inferSelect): ShareSummary {
  return { slug: row.slug, views: row.views, remixes: row.remixes, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

function safeDate(value: string): Date {
  const time = Date.parse(value);
  return Number.isNaN(time) ? new Date() : new Date(time);
}
