import { describeLanding } from '../../git/commit.ts';
import { removeWorktree } from '../../git/worktree.ts';
import { loadConfig } from '../../storage/config.ts';
import { pruneArtifacts } from '../../storage/retention.ts';
import { listRuns } from '../../storage/runs.ts';
import { isTerminal } from '../../workflow/phases.ts';
import { createCliContext } from '../context.ts';
import { emitJson } from '../json.ts';
import { out } from '../output.ts';
import type { CleanResult } from '../cleanJson.ts';
import { isRelayError, RelayError } from '../../util/errors.ts';

export interface CleanOptions { all?: boolean; olderThan?: string; force?: boolean; yes?: boolean; json?: boolean }

export async function cleanCommand(options: CleanOptions = {}): Promise<number> {
  const cli = await createCliContext();
  const config = await loadConfig(cli.repo.root);
  await pruneArtifacts(cli.repo.root, config.retention.artifactDays).catch(() => undefined);
  const results = await cleanRepository(cli.repo.root, options);
  if (options.json === true) emitJson('clean', { dryRun: options.yes !== true, results });
  else for (const result of results) out(`${result.action === 'remove' ? options.yes ? 'Removed' : 'Would remove' : 'Skipped'} ${result.path} (${result.reason})`);
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
