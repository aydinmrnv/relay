/**
 * A person's studio in the database: their workspace settings, workflows,
 * runs, saved versions and share links. Route handlers call these after
 * checking who is asking; nothing here trusts a user id it was not given.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { customAlphabet, nanoid } from 'nanoid';
import type { ShareSummary, VersionSummary } from '@/lib/cloud/types';
import type { Run, Workflow } from '@/lib/workflow/schema';
import { redactForSharing } from '@/lib/workflow/redact';
import { ApiError } from './api';
import { getDb } from './db';
import { run, share, workflow, workflowVersion, workspace } from './db/schema';
import type { OnboardingAnswers } from './validate';

const MAX_WORKFLOWS = 300;
const MAX_RUNS = 300;
const MAX_AUTO_VERSIONS = 40;
const MAX_NAMED_VERSIONS = 50;
/** While someone is editing, keep at most one automatic version per this long. */
const AUTO_VERSION_EVERY_MS = 10 * 60_000;

export interface WorkspaceRecord {
  settings: Record<string, unknown> | null;
  brand: Record<string, unknown> | null;
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
}

export async function ensureWorkspace(userId: string): Promise<WorkspaceRecord> {
  const db = await getDb();
  await db.insert(workspace).values({ userId }).onConflictDoNothing();
  const [row] = await db.select().from(workspace).where(eq(workspace.userId, userId));
  if (row === undefined) throw new ApiError(500, 'NO_WORKSPACE', 'Could not create your workspace.');
  return {
    settings: (row.settings as Record<string, unknown> | null) ?? null,
    brand: (row.brand as Record<string, unknown> | null) ?? null,
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
  const [workflows, runs, shares] = await Promise.all([
    db.select({ data: workflow.data, updatedAt: workflow.updatedAt }).from(workflow).where(eq(workflow.userId, userId)),
    db.select({ data: run.data }).from(run).where(eq(run.userId, userId)).orderBy(desc(run.startedAt)).limit(200),
    db.select({ workflowId: share.workflowId, slug: share.slug }).from(share).where(eq(share.userId, userId)),
  ]);
  return {
    workspace: record,
    workflows: workflows.map((row) => row.data as Workflow),
    revisions: Object.fromEntries(workflows.map((row) => [(row.data as Workflow).id, row.updatedAt.toISOString()])),
    runs: runs.map((row) => row.data as Run),
    shares: Object.fromEntries(shares.map((row) => [row.workflowId, row.slug])),
  };
}

export async function patchWorkspace(userId: string, patch: Partial<Omit<WorkspaceRecord, 'onboarding' | 'onboardedAt'>>): Promise<void> {
  const db = await getDb();
  await ensureWorkspace(userId);
  const set: Partial<typeof workspace.$inferInsert> = { updatedAt: new Date() };
  if (patch.settings !== undefined) set.settings = patch.settings;
  if (patch.brand !== undefined) set.brand = patch.brand;
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

export async function saveWorkflow(userId: string, next: Workflow, options: SaveOptions): Promise<{ revision: string }> {
  const db = await getDb();
  const [existing] = await db
    .select({ data: workflow.data, updatedAt: workflow.updatedAt })
    .from(workflow)
    .where(and(eq(workflow.userId, userId), eq(workflow.id, next.id)));

  if (existing === undefined) {
    // Absent here but known to the client means it was deleted elsewhere;
    // an edit made since wins over that delete, so it is saved again.
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(workflow).where(eq(workflow.userId, userId));
    if (count >= MAX_WORKFLOWS) throw new ApiError(409, 'TOO_MANY_WORKFLOWS', `An account can hold ${MAX_WORKFLOWS} workflows. Delete one to make room.`);
  } else {
    const revision = existing.updatedAt.toISOString();
    if (options.force !== true && options.baseRevision !== revision) {
      throw new ApiError(409, 'CONFLICT', 'This workflow was changed somewhere else.', { workflow: existing.data, revision });
    }
    // Before the first save of an editing session, keep what it looked like,
    // so "restore" can undo a whole session rather than a keystroke.
    const previous = existing.data as Workflow;
    if (graphChanged(previous, next)) await maybeAutoVersion(userId, previous);
  }

  const now = new Date();
  await db
    .insert(workflow)
    .values({ userId, id: next.id, name: next.name.slice(0, 200), data: next, createdAt: safeDate(next.createdAt), updatedAt: now })
    .onConflictDoUpdate({ target: [workflow.userId, workflow.id], set: { name: next.name.slice(0, 200), data: next, updatedAt: now } });
  return { revision: now.toISOString() };
}

/** The account's copy of a workflow, or a 404: shares and versions only exist for workflows that do. */
async function requireWorkflow(userId: string, workflowId: string): Promise<void> {
  const db = await getDb();
  const [row] = await db.select({ id: workflow.id }).from(workflow).where(and(eq(workflow.userId, userId), eq(workflow.id, workflowId)));
  if (row === undefined) throw new ApiError(404, 'NOT_FOUND', 'Save the workflow to your account first, then try again.');
}

export async function deleteWorkflow(userId: string, workflowId: string): Promise<void> {
  const db = await getDb();
  await db.delete(workflow).where(and(eq(workflow.userId, userId), eq(workflow.id, workflowId)));
  await db.delete(workflowVersion).where(and(eq(workflowVersion.userId, userId), eq(workflowVersion.workflowId, workflowId)));
  await db.delete(share).where(and(eq(share.userId, userId), eq(share.workflowId, workflowId)));
  await db.delete(run).where(and(eq(run.userId, userId), eq(run.workflowId, workflowId)));
}

function graphChanged(a: Workflow, b: Workflow): boolean {
  return a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length || JSON.stringify([a.nodes, a.edges]) !== JSON.stringify([b.nodes, b.edges]);
}

async function maybeAutoVersion(userId: string, snapshot: Workflow): Promise<void> {
  const db = await getDb();
  const [latest] = await db
    .select({ createdAt: workflowVersion.createdAt })
    .from(workflowVersion)
    .where(and(eq(workflowVersion.userId, userId), eq(workflowVersion.workflowId, snapshot.id)))
    .orderBy(desc(workflowVersion.createdAt))
    .limit(1);
  if (latest !== undefined && Date.now() - latest.createdAt.getTime() < AUTO_VERSION_EVERY_MS) return;
  await insertVersion(userId, snapshot, null, true);
}

/* ------------------------------------------------------------------ */
/* Versions                                                             */
/* ------------------------------------------------------------------ */

async function insertVersion(userId: string, snapshot: Workflow, label: string | null, auto: boolean): Promise<VersionSummary> {
  const db = await getDb();
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
    .limit(80);
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
  return insertVersion(userId, snapshot, label.trim().slice(0, 120) || 'Saved version', false);
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
  if (next.status !== 'running') {
    await db.execute(sql`
      DELETE FROM run WHERE user_id = ${userId} AND id IN (
        SELECT id FROM run WHERE user_id = ${userId} ORDER BY started_at DESC OFFSET ${MAX_RUNS}
      )`);
  }
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

export async function countShare(slug: string, what: 'views' | 'remixes'): Promise<void> {
  if (!/^[a-z0-9]{6,20}$/.test(slug)) return;
  const db = await getDb();
  await db
    .update(share)
    .set(what === 'views' ? { views: sql`${share.views} + 1` } : { remixes: sql`${share.remixes} + 1` })
    .where(eq(share.slug, slug));
}

function summarise(row: typeof share.$inferSelect): ShareSummary {
  return { slug: row.slug, views: row.views, remixes: row.remixes, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

function safeDate(value: string): Date {
  const time = Date.parse(value);
  return Number.isNaN(time) ? new Date() : new Date(time);
}
