import { join } from 'node:path';

import { acquireLock } from '../git/lock.ts';
import { atomicWriteJson, readJsonFile } from '../storage/atomic.ts';
import { relayDir } from '../storage/config.ts';

/**
 * What the server has already picked up, on disk.
 *
 * The label is the request and removing it is the acknowledgement, so most of
 * the "did I already do this?" problem is solved by the tracker itself. This
 * file covers the gap the tracker cannot: the moment between deciding to start
 * an issue and having removed its label, and the case where somebody puts the
 * label back on an issue a run is still working on.
 *
 * It is small, append-mostly and written atomically under the repository lock,
 * because two servers pointed at one repository is a configuration mistake that
 * must not become two runs on one issue.
 */

export interface UnattendedClaim {
  /** Provider-scoped issue identity, e.g. `github:acme/widgets#142`. */
  issueId: string;
  /** What the user would type to reach it, kept for the log lines. */
  issueRef: string;
  runId: string;
  label: string;
  /** Who applied the label, when the tracker said. */
  actor: string | null;
  at: string;
}

export interface UnattendedLedger {
  version: 1;
  claims: UnattendedClaim[];
}

/** Claims older than this are forgotten, so the file cannot grow without end. */
const RETAIN_DAYS = 30;

export function ledgerPath(repoRoot: string): string {
  return join(relayDir(repoRoot), 'unattended.json');
}

export async function loadLedger(repoRoot: string): Promise<UnattendedLedger> {
  const raw = await readJsonFile<unknown>(ledgerPath(repoRoot));
  if (raw === null || typeof raw !== 'object') return { version: 1, claims: [] };
  const claims = (raw as Partial<UnattendedLedger>).claims;
  if (!Array.isArray(claims)) return { version: 1, claims: [] };
  return {
    version: 1,
    claims: claims.filter(
      (claim): claim is UnattendedClaim =>
        claim !== null &&
        typeof claim === 'object' &&
        typeof (claim as UnattendedClaim).issueId === 'string' &&
        typeof (claim as UnattendedClaim).runId === 'string',
    ),
  };
}

export function claimFor(ledger: UnattendedLedger, issueId: string): UnattendedClaim | undefined {
  return ledger.claims.find((claim) => claim.issueId === issueId);
}

/**
 * Records a claim, refusing to write a second one for the same issue.
 *
 * The lock is held across the read and the write, so the answer this returns is
 * the answer for every process: `claimed` false means somebody else got there,
 * and the caller must not start a run.
 */
export async function claimIssue(
  repoRoot: string,
  claim: UnattendedClaim,
  options: { now?: Date } = {},
): Promise<{ claimed: boolean; existing?: UnattendedClaim }> {
  const lock = await acquireLock(repoRoot, 'unattended');
  try {
    const ledger = await loadLedger(repoRoot);
    const existing = claimFor(ledger, claim.issueId);
    if (existing !== undefined) return { claimed: false, existing };
    ledger.claims.push(claim);
    await atomicWriteJson(ledgerPath(repoRoot), {
      version: 1,
      claims: prune(ledger.claims, options.now ?? new Date()),
    });
    return { claimed: true };
  } finally {
    await lock.release();
  }
}

/**
 * Drops a claim, so an issue whose run never started can be picked up again.
 *
 * Called when the run fails to launch at all. A claim that outlived its run
 * would be a silently ignored issue, which is worse than a duplicate: nothing
 * on the tracker would say why the work never happened.
 */
export async function releaseClaim(repoRoot: string, issueId: string): Promise<void> {
  const lock = await acquireLock(repoRoot, 'unattended');
  try {
    const ledger = await loadLedger(repoRoot);
    await atomicWriteJson(ledgerPath(repoRoot), {
      version: 1,
      claims: ledger.claims.filter((claim) => claim.issueId !== issueId),
    });
  } finally {
    await lock.release();
  }
}

function prune(claims: readonly UnattendedClaim[], now: Date): UnattendedClaim[] {
  const cutoff = now.getTime() - RETAIN_DAYS * 24 * 60 * 60_000;
  return claims.filter((claim) => {
    const at = new Date(claim.at).getTime();
    return !Number.isFinite(at) || at >= cutoff;
  });
}
