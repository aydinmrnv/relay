import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rm, readFile, writeFile, mkdir } from 'node:fs/promises';

import { runProcess } from '../src/process/runner.ts';

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
import { buildCommitMessage, commitWorktree, describeLanding } from '../src/git/commit.ts';
import { deleteRemoteBranch, hasRemote, mergeBranch, mergeReadiness, pushBranch } from '../src/git/publish.ts';
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

describe('commit messages', () => {
  it('separates subject, body and trailers the way git expects', () => {
    const message = buildCommitMessage({
      subject: 'Add authentication rate limiting (#142)',
      body: ['Implemented by Relay run 20260811T120000-abc123.', ''],
      coAuthors: [
        { name: 'Claude', email: 'noreply@anthropic.com' },
        { name: 'Codex', email: 'noreply@openai.com' },
      ],
    });

    assert.equal(
      message,
      [
        'Add authentication rate limiting (#142)',
        '',
        'Implemented by Relay run 20260811T120000-abc123.',
        '',
        'Co-Authored-By: Claude <noreply@anthropic.com>',
        'Co-Authored-By: Codex <noreply@openai.com>',
        '',
      ].join('\n'),
    );
  });

  it('is just a subject when there is nothing else to say', () => {
    assert.equal(buildCommitMessage({ subject: 'Relay: work for issue 7' }), 'Relay: work for issue 7\n');
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
    const worktree = await createWorktree({ repo: info, issue: 142, runShortId: 'test01' });

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
    const first = await createWorktree({ repo: info, issue: 200, runShortId: 'reuse1' });
    const second = await createWorktree({ repo: info, issue: 200, runShortId: 'reuse1' });
    assert.equal(first.path, second.path);
  });

  it('computes a diff from git, including new and deleted files', async () => {
    const info = await discoverRepository(repo.root);
    const worktree = await createWorktree({ repo: info, issue: 300, runShortId: 'diff01' });

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
    const worktree = await createWorktree({ repo: info, issue: 400, runShortId: 'empty1' });
    const snapshot = await snapshotDiff(worktree.path, worktree.baseSha);
    assert.equal(snapshot.isEmpty, true);
  });

  it('commits a run\'s work to its own branch and leaves every other ref alone', async () => {
    const info = await discoverRepository(repo.root);
    const worktree = await createWorktree({ repo: info, issue: 600, runShortId: 'cmt001' });
    await writeFile(join(worktree.path, 'src', 'app.ts'), 'export const value = 42;\n', 'utf8');

    const result = await commitWorktree(worktree.path, {
      subject: 'Add authentication rate limiting (#600)',
      body: ['Implemented by Relay run 20260811T120000-cmt001.'],
      coAuthors: [{ name: 'Claude', email: 'noreply@anthropic.com' }],
    });

    assert.ok(result !== undefined);
    assert.match(result.sha, /^[0-9a-f]{40}$/);

    const message = await repo.git('-C', worktree.path, 'log', '-1', '--format=%B');
    assert.match(message, /^Add authentication rate limiting \(#600\)/);
    assert.match(message, /Co-Authored-By: Claude <noreply@anthropic\.com>/);

    // Committed on the run branch; nothing left staged, and main did not move.
    assert.equal(await repo.git('-C', worktree.path, 'status', '--porcelain'), '');
    assert.equal(await repo.git('rev-parse', 'main'), worktree.baseSha);
    assert.equal(await repo.git('rev-parse', 'relay/600-cmt001'), result.sha);
  });

  it('commits nothing when a run changed nothing', async () => {
    const info = await discoverRepository(repo.root);
    const worktree = await createWorktree({ repo: info, issue: 601, runShortId: 'cmt002' });
    assert.equal(await commitWorktree(worktree.path, { subject: 'nothing to see' }), undefined);
  });

  it('reports whether a run\'s work is committed or still only staged', async () => {
    const info = await discoverRepository(repo.root);
    const worktree = await createWorktree({ repo: info, issue: 602, runShortId: 'lnd001' });
    const subject = { branch: worktree.branch, baseSha: worktree.baseSha, changedFiles: 3 };

    // A run that changed nothing has nothing to strand.
    assert.equal(await describeLanding(repo.root, { ...subject, changedFiles: 0 }), 'empty');

    // Work exists, but the branch still points at the base commit.
    await writeFile(join(worktree.path, 'src', 'app.ts'), 'export const value = 43;\n', 'utf8');
    assert.equal(await describeLanding(repo.root, subject), 'unlanded');

    await commitWorktree(worktree.path, { subject: 'landed' });
    assert.equal(await describeLanding(repo.root, subject), 'committed');

    // A branch git no longer knows is never reported as safe.
    assert.equal(await describeLanding(repo.root, { ...subject, branch: 'relay/gone' }), 'unknown');
  });

  it('removes only worktrees git knows about, and only inside the workspaces root', async () => {
    const info = await discoverRepository(repo.root);
    const worktree = await createWorktree({ repo: info, issue: 500, runShortId: 'rm0001' });

    await assert.rejects(() => removeWorktree(repo.root, repo.root), RelayError);
    await assert.rejects(() => removeWorktree(repo.root, join(repo.relayHome, 'workspaces')), RelayError);

    await removeWorktree(repo.root, worktree.path, { force: true });
    assert.equal(await worktreeExists(worktree.path), false);

    // The branch survives: it holds the only copy of the run's work.
    const branches = await repo.git('branch', '--list', 'relay/500-rm0001');
    assert.match(branches, /relay\/500-rm0001/);
  });
});

/**
 * Publishing, against real git and a real remote.
 *
 * These are the operations that move something outside the run's worktree, so
 * they are worth testing against git itself: a push either updates a ref in
 * another repository or it does not, and a merge either lands in the user's
 * checkout or leaves it exactly as it was.
 */
describe('publishing a run branch', () => {
  let repo: TempRepo;
  let remote: string;

  before(async () => {
    repo = await createTempRepo();
    process.env['RELAY_HOME'] = repo.relayHome;

    remote = join(repo.relayHome, 'origin.git');
    await mkdir(remote, { recursive: true });
    await runProcess('git', ['init', '--bare', '-q', '-b', 'main', remote], { cwd: repo.root });
    await repo.git('remote', 'add', 'origin', remote);
    await repo.git('push', '-q', 'origin', 'main');
  });

  after(async () => {
    delete process.env['RELAY_HOME'];
    await repo.cleanup();
  });

  it('pushes the run branch and sets its upstream', async () => {
    const info = await discoverRepository(repo.root);
    const worktree = await createWorktree({ repo: info, issue: 700, runShortId: 'push01' });
    await writeFile(join(worktree.path, 'src', 'app.ts'), 'export const value = 700;\n', 'utf8');
    await commitWorktree(worktree.path, { subject: 'work for 700' });

    assert.equal(await hasRemote(repo.root), true);
    const result = await pushBranch(repo.root, worktree.branch);

    assert.equal(result.remote, 'origin');
    const remoteRefs = await repo.git('ls-remote', '--heads', 'origin', worktree.branch);
    assert.match(remoteRefs, new RegExp(result.sha));
    assert.equal(await repo.git('rev-parse', `${worktree.branch}@{upstream}`), result.sha);
  });

  it('deletes a remote branch idempotently without force pushing', async () => {
    const info = await discoverRepository(repo.root);
    const worktree = await createWorktree({ repo: info, issue: 704, runShortId: 'del001' });
    await writeFile(join(worktree.path, 'src', 'delete.ts'), 'export const deleted = true;\n', 'utf8');
    await commitWorktree(worktree.path, { subject: 'work for 704' });
    await pushBranch(repo.root, worktree.branch);

    assert.equal(await deleteRemoteBranch(repo.root, 'origin', worktree.branch), 'deleted');
    assert.equal(await repo.git('ls-remote', '--heads', 'origin', worktree.branch), '');
    assert.equal(await deleteRemoteBranch(repo.root, 'origin', worktree.branch), 'absent');
  });

  it('refuses to merge into a branch the user is not on, or a dirty tree', async () => {
    const info = await discoverRepository(repo.root);
    const worktree = await createWorktree({ repo: info, issue: 701, runShortId: 'mrg001' });
    await writeFile(join(worktree.path, 'src', 'app.ts'), 'export const value = 701;\n', 'utf8');
    await commitWorktree(worktree.path, { subject: 'work for 701' });

    assert.deepEqual(await mergeReadiness(repo.root, 'main'), { ok: true });

    // A branch other than the base is the common case: it is the reason the
    // option carries its reason instead of failing halfway through a merge.
    await repo.git('checkout', '-q', '-b', 'sidetrack');
    const elsewhere = await mergeReadiness(repo.root, 'main');
    assert.equal(elsewhere.ok, false);
    assert.match(elsewhere.reason ?? '', /sidetrack/);
    await repo.git('checkout', '-q', 'main');

    await writeFile(join(repo.root, 'untracked.txt'), 'in the way\n', 'utf8');
    const dirty = await mergeReadiness(repo.root, 'main');
    assert.equal(dirty.ok, false);
    assert.match(dirty.reason ?? '', /uncommitted/);
    await rm(join(repo.root, 'untracked.txt'));

    const merged = await mergeBranch(repo.root, { branch: worktree.branch, into: 'main', message: 'Merge 701' });
    assert.equal(merged.into, 'main');
    assert.equal(merged.fastForward, true);
    assert.equal(await repo.git('rev-parse', 'HEAD'), merged.sha);
    // The work is in the user's own files afterwards, which is the point.
    assert.match(await readFile(join(repo.root, 'src', 'app.ts'), 'utf8'), /701/);
  });

  it('refuses to merge into whatever branch happens to be checked out', async () => {
    const info = await discoverRepository(repo.root);
    const worktree = await createWorktree({ repo: info, issue: 703, runShortId: 'grd001' });
    await writeFile(join(worktree.path, 'src', 'guard.ts'), 'export const guarded = true;\n', 'utf8');
    await commitWorktree(worktree.path, { subject: 'work for 703' });

    // The check is not the caller's job: `git merge` merges into HEAD, so a
    // merge asked for while standing somewhere else must not quietly land there.
    await repo.git('checkout', '-q', '-b', 'somewhere-else');
    await assert.rejects(
      () => mergeBranch(repo.root, { branch: worktree.branch, into: 'main' }),
      (error: unknown) => error instanceof RelayError && error.code === 'MERGE_BLOCKED',
    );
    assert.equal(await repo.git('rev-parse', '--abbrev-ref', 'HEAD'), 'somewhere-else');
    await repo.git('checkout', '-q', 'main');

    // Same refusal for a tree with work in it that the merge would disturb.
    await writeFile(join(repo.root, 'in-progress.txt'), 'mine\n', 'utf8');
    await assert.rejects(
      () => mergeBranch(repo.root, { branch: worktree.branch, into: 'main' }),
      (error: unknown) => error instanceof RelayError && error.code === 'MERGE_BLOCKED',
    );
    await rm(join(repo.root, 'in-progress.txt'));
  });

  it('does not count Relay\'s own run record as the user\'s uncommitted work', async () => {
    // `.relay/` is written by the run that is asking. A repository that never
    // gitignored it would otherwise be permanently unmergeable, blocked by the
    // evidence of the very work it is trying to merge.
    await mkdir(join(repo.root, '.relay', 'runs', '20260812T210000-abc123'), { recursive: true });
    await writeFile(join(repo.root, '.relay', 'runs', '20260812T210000-abc123', 'state.json'), '{}\n', 'utf8');

    assert.deepEqual(await mergeReadiness(repo.root, 'main'), { ok: true });
    await rm(join(repo.root, '.relay'), { recursive: true, force: true });
  });

  it('restores the checkout when a merge conflicts instead of leaving markers behind', async () => {
    const info = await discoverRepository(repo.root);
    const worktree = await createWorktree({ repo: info, issue: 702, runShortId: 'cnf001' });
    await writeFile(join(worktree.path, 'src', 'app.ts'), 'export const value = 702;\n', 'utf8');
    await commitWorktree(worktree.path, { subject: 'work for 702' });

    // The same line, changed differently on the base branch.
    await writeFile(join(repo.root, 'src', 'app.ts'), 'export const value = 999;\n', 'utf8');
    await repo.commit('conflicting change on main');
    const before = await repo.git('rev-parse', 'HEAD');

    await assert.rejects(
      () => mergeBranch(repo.root, { branch: worktree.branch, into: 'main' }),
      (error: unknown) => error instanceof RelayError && error.code === 'MERGE_FAILED',
    );

    assert.equal(await repo.git('rev-parse', 'HEAD'), before);
    assert.equal(await repo.git('status', '--porcelain'), '');
    assert.match(await readFile(join(repo.root, 'src', 'app.ts'), 'utf8'), /999/);
  });
});
