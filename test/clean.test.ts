import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { join } from 'node:path';

import { cleanRepository } from '../src/cli/commands/clean.ts';
import { discoverRepository } from '../src/git/repository.ts';
import { createWorktree, worktreeExists } from '../src/git/worktree.ts';
import { DEFAULT_CONFIG } from '../src/storage/config.ts';
import { RunStore } from '../src/storage/runs.ts';
import { createRunState, type RunState } from '../src/workflow/state.ts';
import { RelayError } from '../src/util/errors.ts';
import { createTempRepo, type TempRepo } from './helpers/tempRepo.ts';

describe('clean', () => {
  let repo: TempRepo;
  let sequence = 0;

  before(async () => {
    repo = await createTempRepo();
    process.env['RELAY_HOME'] = repo.relayHome;
  });
  after(async () => {
    delete process.env['RELAY_HOME'];
    await repo.cleanup();
  });

  async function finished(options: { changedFiles: number; merged?: boolean; outside?: boolean }): Promise<RunState> {
    sequence += 1;
    const info = await discoverRepository(repo.root);
    const worktree = await createWorktree({ repo: info, issue: 700 + sequence, runShortId: `cln00${sequence}` });
    const state = createRunState({
      runId: `20260101T0000${String(sequence).padStart(2, '0')}-clean${sequence}`,
      shortId: `clean${sequence}`, issueRef: String(700 + sequence),
      repository: { root: repo.root, owner: null, name: null, defaultBranch: 'main' },
      config: structuredClone(DEFAULT_CONFIG),
    });
    state.phase = 'COMPLETE';
    state.finishedAt = new Date(0).toISOString();
    state.workspace = { path: options.outside ? join(repo.root, 'outside') : worktree.path, branch: worktree.branch, baseSha: worktree.baseSha, baseRef: 'main', baseBranch: 'main' };
    state.diff = { fileCount: options.changedFiles, additions: 1, deletions: 0, files: ['x'], patchFile: 'patches/x.patch', at: state.finishedAt };
    if (options.merged) state.merge = { into: 'main', via: 'local', at: state.finishedAt };
    const store = new RunStore(repo.root, state.runId);
    await store.init();
    await store.saveState(state);
    return state;
  }

  it('is a dry run by default and removes landed work only with --yes', async () => {
    const state = await finished({ changedFiles: 0, merged: true });
    const preview = await cleanRepository(repo.root);
    assert.equal(preview.find((entry) => entry.runId === state.runId)?.reason, 'dry run');
    assert.equal(await worktreeExists(state.workspace!.path), true);
    await cleanRepository(repo.root, { yes: true });
    assert.equal(await worktreeExists(state.workspace!.path), false);
    const again = await cleanRepository(repo.root, { yes: true });
    assert.equal(again.find((entry) => entry.runId === state.runId)?.reason, 'already removed or no longer registered');
  });

  it('protects unlanded work unless --force is explicit', async () => {
    const state = await finished({ changedFiles: 1 });
    const protectedResults = await cleanRepository(repo.root, { all: true, yes: true });
    assert.match(protectedResults.find((entry) => entry.runId === state.runId)!.reason, /requires --force/);
    assert.equal(await worktreeExists(state.workspace!.path), true);
    await cleanRepository(repo.root, { all: true, yes: true, force: true });
    assert.equal(await worktreeExists(state.workspace!.path), false);
  });

  it('refuses a doctored path outside the workspaces root', async () => {
    await finished({ changedFiles: 0, merged: true, outside: true });
    await assert.rejects(
      () => cleanRepository(repo.root, { yes: true }),
      (error: unknown) => error instanceof RelayError && error.code === 'UNSAFE_PATH',
    );
  });
});
