import { describeLanding } from '../../git/commit.ts';
import { removeWorktree } from '../../git/worktree.ts';
import { loadConfig } from '../../storage/config.ts';
import { pruneArtifacts } from '../../storage/retention.ts';
import { listRuns } from '../../storage/runs.ts';
import { isTerminal } from '../../workflow/phases.ts';
import { createCliContext } from '../context.ts';
import { emitJson } from '../json.ts';
import { hint, out } from '../output.ts';
import type { CleanResult } from '../cleanJson.ts';
import { isRelayError, RelayError } from '../../util/errors.ts';

export interface CleanOptions { all?: boolean; olderThan?: string; force?: boolean; yes?: boolean; json?: boolean }

export async function cleanCommand(options: CleanOptions = {}): Promise<number> {
  const cli = await createCliContext();
  const config = await loadConfig(cli.repo.root);
  const dryRun = options.yes !== true;
  // Old artifacts are deleted for real, so only a real run deletes them. A dry
  // run that pruned on its way to printing "would remove" removed something.
  if (!dryRun) await pruneArtifacts(cli.repo.root, config.retention.artifactDays).catch(() => undefined);
  const results = await cleanRepository(cli.repo.root, options);
  if (options.json === true) {
    emitJson('clean', { dryRun, results });
    return 0;
  }

  for (const result of results) out(`${result.action === 'remove' ? options.yes ? 'Removed' : 'Would remove' : 'Skipped'} ${result.path} (${result.reason})`);
  // Nothing to do is an answer, and silence reads as a command that did not run.
  if (results.length === 0) {
    out(
      options.all === true
        ? 'Nothing to clean: no finished run has a worktree left.'
        : 'Nothing to clean: no merged run has a worktree left.',
    );
    if (options.all !== true) hint('`relay clean --all` also considers finished runs that were never merged.');
  } else if (dryRun && results.some((result) => result.action === 'remove')) {
    hint('This was a dry run. `relay clean --yes` removes them.');
  }
  return 0;
}

/** The removal core is dependency-free so its safety rules can be tested against real git. */
export async function cleanRepository(repoRoot: string, options: CleanOptions = {}): Promise<CleanResult[]> {
  const days = options.olderThan === undefined ? undefined : Number(options.olderThan);
  if (days !== undefined && (!Number.isFinite(days) || days < 0)) throw new RelayError('--older-than must be a non-negative number of days.', { code: 'BAD_FLAG' });
  const cutoff = days === undefined ? undefined : Date.now() - days * 86_400_000;
  const results: CleanResult[] = [];
  for (const state of await listRuns(repoRoot)) {
    if (!isTerminal(state.phase) || state.workspace === undefined) continue;
    if (cutoff !== undefined && (state.finishedAt === undefined || new Date(state.finishedAt).getTime() > cutoff)) continue;
    if (options.all !== true && state.merge === undefined) continue;
    const landing = state.merge === undefined ? await describeLanding(repoRoot, { branch: state.workspace.branch, baseSha: state.workspace.baseSha, changedFiles: state.diff?.fileCount ?? 0, ...(state.commit ? { committedSha: state.commit.sha } : {}) }) : 'committed';
    const safe = landing === 'committed' || landing === 'empty';
    if (!safe && options.force !== true) { results.push({ runId: state.runId, path: state.workspace.path, action: 'skip', reason: `${landing} work requires --force` }); continue; }
    results.push({ runId: state.runId, path: state.workspace.path, action: 'remove', reason: options.yes === true ? 'removed' : 'dry run' });
    if (options.yes === true) {
      try { await removeWorktree(repoRoot, state.workspace.path, { force: options.force === true }); }
      catch (error) {
        if (!isRelayError(error) || error.code !== 'UNKNOWN_WORKTREE') throw error;
        results[results.length - 1] = { runId: state.runId, path: state.workspace.path, action: 'skip', reason: 'already removed or no longer registered' };
      }
    }
  }
  return results;
}
