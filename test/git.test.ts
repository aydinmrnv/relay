import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rm, writeFile, mkdir } from 'node:fs/promises';

import {
  assertRemovableWorktreePath,
  branchNameFor,
  canonicalizePath,
  createWorktree,
  listWorktrees,
  removeWorktree,
  worktreePathFor,
  worktreeExists,
} from '../src/git/worktree.ts';
import { discoverRepository, resolveBaseRef } from '../src/git/repository.ts';
import { snapshotDiff, formatDiffStat } from '../src/git/diff.ts';
import { RelayError } from '../src/util/errors.ts';
import { createTempRepo, type TempRepo } from './helpers/tempRepo.ts';

describe('worktree path validation', () => {
  const root = '/home/u/.relay/workspaces';

  it('permits a real run worktree', () => {
    // The returned path is canonicalized, so compare against the canonical form
    // rather than the literal input (macOS rewrites /home and /var).
    const candidate = '/home/u/.relay/workspaces/acme/widgets/issue-1-abc';
    assert.equal(assertRemovableWorktreePath(candidate, root), canonicalizePath(candidate));
  });

  it('refuses anything outside the workspaces root', () => {
    for (const candidate of ['/home/u/projects/real-repo', '/', '/home/u', '/tmp/somewhere']) {
      assert.throws(() => assertRemovableWorktreePath(candidate, root), RelayError, `should refuse ${candidate}`);
    }
  });

  it('refuses the workspaces root itself and its shallow children', () => {
    assert.throws(() => assertRemovableWorktreePath(root, root), RelayError);
    assert.throws(() => assertRemovableWorktreePath('/home/u/.relay/workspaces/acme', root), RelayError);
    assert.throws(() => assertRemovableWorktreePath('/home/u/.relay/workspaces/acme/widgets', root), RelayError);
  });

  it('refuses traversal that escapes the root', () => {
    assert.throws(
      () => assertRemovableWorktreePath('/home/u/.relay/workspaces/acme/widgets/../../../../etc', root),
      RelayError,
    );
  });

  it('refuses relative paths', () => {
    assert.throws(() => assertRemovableWorktreePath('acme/widgets/issue-1', root), RelayError);
  });
});

describe('worktree naming', () => {
  it('derives a stable path from owner, repo and issue', () => {
    process.env['RELAY_HOME'] = '/tmp/relay-home';
    const path = worktreePathFor({ owner: 'Acme', name: 'Widgets', root: '/x' }, 142, 'a1b2c3');
    assert.equal(path, '/tmp/relay-home/workspaces/acme/widgets/issue-142-a1b2c3');
    delete process.env['RELAY_HOME'];
  });

  it('sanitizes unsafe characters out of path components', () => {
    process.env['RELAY_HOME'] = '/tmp/relay-home';
    const path = worktreePathFor({ owner: '../evil', name: 'a b/c', root: '/x' }, 1, 'id');
    assert.ok(!path.includes('..'));
    assert.match(path, /workspaces\/evil\/a-b-c\/issue-1-id$/);
    delete process.env['RELAY_HOME'];
  });

  it('builds a namespaced branch name', () => {
    assert.equal(branchNameFor(142, 'a1b2c3'), 'relay/142-a1b2c3');
    assert.equal(branchNameFor(142, 'a1b2c3', 'bot'), 'bot/142-a1b2c3');
  });
});

describe('git integration', () => {
  let repo: TempRepo;

  before(async () => {
    repo = await createTempRepo();
    process.env['RELAY_HOME'] = repo.relayHome;
  });

  after(async () => {
    delete process.env['RELAY_HOME'];
    await repo.cleanup();
  });

  it('discovers repository metadata', async () => {
    const info = await discoverRepository(repo.root);
    assert.equal(info.root, repo.root);
    assert.equal(info.currentBranch, 'main');
    assert.equal(info.defaultBranch, 'main');
    assert.equal(info.isDirty, false);
    assert.equal(info.owner, null);
  });

  it('detects a dirty working tree', async () => {
    await repo.writeFile('scratch.txt', 'uncommitted\n');
    const info = await discoverRepository(repo.root);
    assert.equal(info.isDirty, true);
    await rm(join(repo.root, 'scratch.txt'));
  });

  it('resolves the base ref to a commit', async () => {
    const base = await resolveBaseRef(repo.root, 'main');
    assert.match(base.sha, /^[0-9a-f]{40}$/);
  });

  it('refuses to resolve a branch that does not exist', async () => {
    await assert.rejects(() => resolveBaseRef(repo.root, 'no-such-branch'), RelayError);
  });

  it('creates an isolated worktree without touching the user branch', async () => {
    const info = await discoverRepository(repo.root);
    const worktree = await createWorktree({ repo: info, issueNumber: 142, runShortId: 'test01' });

    assert.equal(worktree.branch, 'relay/142-test01');
    assert.equal(await worktreeExists(worktree.path), true);
    assert.equal(worktree.baseSha, info.headSha);

    // The user's checkout is untouched: same branch, still clean.
    const after = await discoverRepository(repo.root);
    assert.equal(after.currentBranch, 'main');
    assert.equal(after.isDirty, false);

    const entries = await listWorktrees(repo.root);
    assert.ok(entries.some((entry) => entry.branch === 'relay/142-test01'));
  });

  it('reuses an existing worktree instead of failing', async () => {
    const info = await discoverRepository(repo.root);
    const first = await createWorktree({ repo: info, issueNumber: 200, runShortId: 'reuse1' });
    const second = await createWorktree({ repo: info, issueNumber: 200, runShortId: 'reuse1' });
    assert.equal(first.path, second.path);
  });

  it('computes a diff from git, including new and deleted files', async () => {
    const info = await discoverRepository(repo.root);
    const worktree = await createWorktree({ repo: info, issueNumber: 300, runShortId: 'diff01' });

    await writeFile(join(worktree.path, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
    await mkdir(join(worktree.path, 'src', 'new'), { recursive: true });
    await writeFile(join(worktree.path, 'src', 'new', 'added.ts'), 'export const added = true;\n', 'utf8');
    await rm(join(worktree.path, 'README.md'));

    const snapshot = await snapshotDiff(worktree.path, worktree.baseSha);

    assert.equal(snapshot.isEmpty, false);
    const paths = snapshot.files.map((file) => file.path).sort();
    assert.deepEqual(paths, ['README.md', 'src/app.ts', 'src/new/added.ts']);
    assert.match(snapshot.patch, /src\/new\/added\.ts/);
    assert.match(formatDiffStat(snapshot), /3 files changed/);
  });

  it('reports an empty diff when nothing changed', async () => {
    const info = await discoverRepository(repo.root);
    const worktree = await createWorktree({ repo: info, issueNumber: 400, runShortId: 'empty1' });
    const snapshot = await snapshotDiff(worktree.path, worktree.baseSha);
    assert.equal(snapshot.isEmpty, true);
  });

  it('removes only worktrees git knows about, and only inside the workspaces root', async () => {
    const info = await discoverRepository(repo.root);
    const worktree = await createWorktree({ repo: info, issueNumber: 500, runShortId: 'rm0001' });

    await assert.rejects(() => removeWorktree(repo.root, repo.root), RelayError);
    await assert.rejects(() => removeWorktree(repo.root, join(repo.relayHome, 'workspaces')), RelayError);

    await removeWorktree(repo.root, worktree.path, { force: true });
    assert.equal(await worktreeExists(worktree.path), false);

    // The branch survives: it holds the only copy of the run's work.
    const branches = await repo.git('branch', '--list', 'relay/500-rm0001');
    assert.match(branches, /relay\/500-rm0001/);
  });
});
