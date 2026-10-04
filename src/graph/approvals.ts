import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWriteJson, readJsonFile } from '../storage/atomic.ts';
import { relayDir } from '../storage/config.ts';
import { RelayError } from '../util/errors.ts';
import { shortId } from '../util/ids.ts';

/**
 * Approvals a workflow is waiting on.
 *
 * A Human approval node holds a run until a person says yes or no. The
 * request is a file under `.relay/approvals/`, because the thing waiting and
 * the thing answering are different processes: the workflow sits in `relay
 * workflow run` or `relay workflow serve`, and the answer comes from `relay
 * workflow approve` in another terminal, from the studio through `relay
 * connect`, or from the terminal the workflow itself runs in.
 *
 * What a file cannot do is prove who answered. The name on a decision is what
 * the person answering said it was, and the list of approvers is checked
 * against that. On a machine one person uses, that is a note to self; where
 * several people share a runner, who can write to its `.relay/` is the real
 * boundary, and this says so rather than dressing a text field up as
 * authentication.
 */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalRecord {
  id: string;
  workflow: string;
  node: string;
  /** What is waiting: the ticket's title, usually. */
  subject: string;
  via: string;
  /** Who may answer. Empty means anyone who can reach this machine. */
  approvers: string[];
  requestedAt: string;
  expiresAt: string;
  status: ApprovalStatus;
  decidedAt?: string;
  decidedBy?: string;
}

export function approvalsDir(repoRoot: string): string {
  return join(relayDir(repoRoot), 'approvals');
}

const APPROVAL_ID = /^ap-[a-z0-9]{6,12}$/;

function approvalPath(repoRoot: string, id: string): string {
  // The id becomes a file name, so it is held to the shape this file mints.
  if (!APPROVAL_ID.test(id)) throw new RelayError(`"${id}" is not an approval id.`, { code: 'APPROVAL_NOT_FOUND', hint: 'List the ones waiting with `relay workflow approvals`.' });
  return join(approvalsDir(repoRoot), `${id}.json`);
}

export async function createApproval(
  repoRoot: string,
  ask: { workflow: string; node: string; subject: string; via: string; approvers: string[]; expiresAt: Date },
  now: Date = new Date(),
): Promise<ApprovalRecord> {
  const record: ApprovalRecord = {
    id: `ap-${shortId(8)}`,
    workflow: ask.workflow,
    node: ask.node,
    subject: ask.subject,
    via: ask.via,
    approvers: ask.approvers,
    requestedAt: now.toISOString(),
    expiresAt: ask.expiresAt.toISOString(),
    status: 'pending',
  };
  await mkdir(approvalsDir(repoRoot), { recursive: true });
  await atomicWriteJson(approvalPath(repoRoot, record.id), record);
  return record;
}

export async function readApproval(repoRoot: string, id: string): Promise<ApprovalRecord | undefined> {
  return readJsonFile<ApprovalRecord>(approvalPath(repoRoot, id));
}

/** Every approval on record, newest first. */
export async function listApprovals(repoRoot: string): Promise<ApprovalRecord[]> {
  let names: string[];
  try {
    names = await readdir(approvalsDir(repoRoot));
  } catch {
    return [];
  }
  const records: ApprovalRecord[] = [];
  for (const name of names) {
    const id = name.replace(/\.json$/, '');
    if (!name.endsWith('.json') || !APPROVAL_ID.test(id)) continue;
    const record = await readJsonFile<ApprovalRecord>(join(approvalsDir(repoRoot), name)).catch(() => undefined);
    if (record !== undefined && typeof record.id === 'string') records.push(record);
  }
  return records.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

/** Whether nobody can answer this any more: it was answered, or its time ran out. */
export function approvalOpen(record: ApprovalRecord, now: Date = new Date()): boolean {
  return record.status === 'pending' && new Date(record.expiresAt).getTime() > now.getTime();
}

/**
 * Records a person's answer. Refuses one for a request that is already
 * answered or has run out of time, and one from a name that is not on the
 * request's list of approvers.
 */
export async function decideApproval(repoRoot: string, id: string, decision: { approved: boolean; by: string }, now: Date = new Date()): Promise<ApprovalRecord> {
  const record = await readApproval(repoRoot, id);
  if (record === undefined) throw new RelayError(`There is no approval ${id} in this repository.`, { code: 'APPROVAL_NOT_FOUND', hint: 'List the ones waiting with `relay workflow approvals`.' });
  if (record.status !== 'pending') {
    throw new RelayError(`Approval ${id} was already ${record.status}${record.decidedBy === undefined ? '' : ` by ${record.decidedBy}`}.`, { code: 'APPROVAL_CLOSED' });
  }
  if (!approvalOpen(record, now)) throw new RelayError(`Approval ${id} ran out of time at ${record.expiresAt}; the run it was holding has moved on.`, { code: 'APPROVAL_CLOSED' });
  const by = decision.by.trim().replace(/^@/, '');
  if (record.approvers.length > 0 && !record.approvers.some((approver) => approver.toLowerCase() === by.toLowerCase())) {
    throw new RelayError(`${by.length === 0 ? 'Nobody named' : by} is not on the list of people who may answer approval ${id}.`, {
      code: 'APPROVAL_NOT_ALLOWED',
      hint: `It names: ${record.approvers.join(', ')}. Answer as one of them with --as <login>.`,
    });
  }
  const decided: ApprovalRecord = { ...record, status: decision.approved ? 'approved' : 'rejected', decidedAt: now.toISOString(), ...(by.length === 0 ? {} : { decidedBy: by }) };
  await atomicWriteJson(approvalPath(repoRoot, id), decided);
  return decided;
}

export interface WaitOptions {
  signal: AbortSignal;
  now?: () => Date;
  /** How often the file is looked at. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Waits for an answer or for the deadline, whichever is first. Rejects when
 * the signal aborts: a cancelled run is not a rejected approval.
 */
export async function waitForApproval(repoRoot: string, id: string, options: WaitOptions): Promise<{ record: ApprovalRecord; timedOut: boolean }> {
  const now = options.now ?? ((): Date => new Date());
  const pause = options.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    if (options.signal.aborted) throw new Error('cancelled');
    const record = await readApproval(repoRoot, id);
    if (record === undefined) throw new RelayError(`Approval ${id} disappeared while the run was waiting on it.`, { code: 'APPROVAL_NOT_FOUND' });
    if (record.status !== 'pending') return { record, timedOut: false };
    if (new Date(record.expiresAt).getTime() <= now().getTime()) return { record, timedOut: true };
    await pause(options.pollMs ?? 1_000);
  }
}
