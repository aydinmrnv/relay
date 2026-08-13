import { rm } from 'node:fs/promises';
import { describeLanding } from '../git/commit.ts';
import { isTerminal } from '../workflow/phases.ts';
import { listRuns, RunStore, RUN_FILES } from './runs.ts';

export async function pruneArtifacts(repoRoot: string, artifactDays: number, now = new Date()): Promise<void> {
  if (artifactDays === 0) return;
  const cutoff = now.getTime() - artifactDays * 86_400_000;
  for (const state of await listRuns(repoRoot)) {
    if (!isTerminal(state.phase) || state.workspace === undefined || state.finishedAt === undefined || new Date(state.finishedAt).getTime() >= cutoff) continue;
    let safe = state.merge !== undefined;
    if (!safe) {
      const landing = await describeLanding(repoRoot, { branch: state.workspace.branch, baseSha: state.workspace.baseSha, changedFiles: state.diff?.fileCount ?? 0, ...(state.commit ? { committedSha: state.commit.sha } : {}) });
      safe = landing === 'committed' || landing === 'empty';
    }
    if (!safe) continue;
    const store = new RunStore(repoRoot, state.runId);
    await Promise.all(['patches', 'tests', 'reviews', 'discussion', RUN_FILES.events].map((name) => rm(store.path(name), { recursive: true, force: true })));
  }
}
