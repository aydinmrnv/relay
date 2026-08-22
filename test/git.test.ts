import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, win32 } from 'node:path';
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
  type PathStyle,
} from '../src/git/worktree.ts';
import { discoverRepository, emptyTreeSha, resolveBaseRef } from '../src/git/repository.ts';
import { snapshotDiff, formatDiffStat } from '../src/git/diff.ts';
import { buildCommitMessage, commitWorktree, describeLanding } from '../src/git/commit.ts';
import {
  branchExistsSomewhere,
  deleteRemoteBranch,
  hasRemote,
  mergeBranch,
  mergeReadiness,
  pushBranch,
} from '../src/git/publish.ts';
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

/**
 * The same guard under Windows path semantics, simulated by injecting the
 * style. `useRealpath` is off because a `C:\` path has no realpath on the OS
 * running the tests; the real-Windows CI leg exercises the realpath branch.
 * This guard is what stands between a bug and someone's home directory, so
 * every Windows-only spelling — drive letters, UNC shares, verbatim prefixes,
 * mixed case — gets its own verdict here.
 */
describe('worktree path validation on Windows (simulated)', () => {
  const style: PathStyle = { path: win32, caseInsensitive: true, useRealpath: false };
  const root = 'C:\\Users\\u\\.relay\\workspaces';

  it('permits a run worktree under a drive-letter root', () => {
    const candidate = 'C:\\Users\\u\\.relay\\workspaces\\acme\\widgets\\issue-1-abc';
    assert.equal(assertRemovableWorktreePath(candidate, root, style), candidate);
  });

  it('accepts forward slashes, the way git reports Windows paths', () => {
    const candidate = 'C:/Users/u/.relay/workspaces/acme/widgets/issue-9-xyz';
    assert.equal(assertRemovableWorktreePath(candidate, root, style), win32.resolve(candidate));
  });

  it('compares case-insensitively without rewriting the caller\'s spelling', () => {
    const candidate = 'c:\\USERS\\u\\.Relay\\Workspaces\\acme\\widgets\\issue-2-def';
    assert.equal(assertRemovableWorktreePath(candidate, root, style), win32.resolve(candidate));
  });

  it('knows the root is the root in any capitalization', () => {
    assert.throws(() => assertRemovableWorktreePath('C:\\USERS\\U\\.RELAY\\WORKSPACES', root, style), RelayError);
  });

  it('refuses a path on a different drive', () => {
    assert.throws(
      () => assertRemovableWorktreePath('D:\\Users\\u\\.relay\\workspaces\\acme\\widgets\\issue-1-abc', root, style),
      RelayError,
    );
  });

  it('refuses a drive-relative spelling, which depends on cmd.exe state', () => {
    assert.throws(() => assertRemovableWorktreePath('C:acme\\widgets\\issue-1-abc', root, style), RelayError);
  });

  it('sees through the verbatim prefix in both directions', () => {
    const candidate = '\\\\?\\C:\\Users\\u\\.relay\\workspaces\\acme\\widgets\\issue-3-ghi';
    assert.equal(
      assertRemovableWorktreePath(candidate, root, style),
      'C:\\Users\\u\\.relay\\workspaces\\acme\\widgets\\issue-3-ghi',
    );
    // The verbatim spelling of the root itself is still the root.
    assert.throws(() => assertRemovableWorktreePath('\\\\?\\C:\\Users\\u\\.relay\\workspaces', root, style), RelayError);
  });

  it('treats UNC roots share-by-share', () => {
    const uncRoot = '\\\\server\\share\\relay\\workspaces';

    const inside = '\\\\server\\share\\relay\\workspaces\\acme\\widgets\\issue-1-abc';
    assert.equal(assertRemovableWorktreePath(inside, uncRoot, style), inside);

    const mixedCase = '\\\\SERVER\\Share\\relay\\workspaces\\acme\\widgets\\issue-2-def';
    assert.equal(assertRemovableWorktreePath(mixedCase, uncRoot, style), win32.resolve(mixedCase));

    const verbatim = '\\\\?\\UNC\\server\\share\\relay\\workspaces\\acme\\widgets\\issue-4-jkl';
    assert.equal(
      assertRemovableWorktreePath(verbatim, uncRoot, style),
      '\\\\server\\share\\relay\\workspaces\\acme\\widgets\\issue-4-jkl',
    );

    // A different share on the same server is a different filesystem.
    assert.throws(
      () => assertRemovableWorktreePath('\\\\server\\other\\relay\\workspaces\\acme\\widgets\\issue-1-abc', uncRoot, style),
      RelayError,
    );
    // A UNC path is never inside a drive-letter root, nor the other way round.
    assert.throws(() => assertRemovableWorktreePath(inside, root, style), RelayError);
    assert.throws(
      () => assertRemovableWorktreePath('C:\\Users\\u\\.relay\\workspaces\\acme\\widgets\\issue-1-abc', uncRoot, style),
      RelayError,
    );
  });

  it('refuses device-namespace paths outright', () => {
    assert.throws(
      () => assertRemovableWorktreePath('\\\\.\\C:\\Users\\u\\.relay\\workspaces\\acme\\widgets\\issue-1-abc', root, style),
      RelayError,
    );
  });

  it('refuses traversal, and anything shallower than a run worktree', () => {
    assert.throws(
      () =>
        assertRemovableWorktreePath(
          'C:\\Users\\u\\.relay\\workspaces\\acme\\widgets\\..\\..\\..\\..\\..\\Windows\\System32',
          root,
          style,
        ),
      RelayError,
    );
    assert.throws(() => assertRemovableWorktreePath('C:\\Users\\u\\.relay\\workspaces\\acme', root, style), RelayError);
    assert.throws(
      () => assertRemovableWorktreePath('C:\\Users\\u\\.relay\\workspaces\\acme\\widgets', root, style),
      RelayError,
    );
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

/**
 * A repository nobody has committed to yet.
 *
 * This is where a project starts, and it used to be the one repository Relay
 * refused: there was no commit to branch from, so there was no run. There still
 * is no commit — the run branches from the empty tree instead, every file it
 * writes is an addition against nothing, and the commit it makes at the end is
 * the repository's first. Everything below is that claim, checked against git.
 */
describe('a repository with no commits', () => {
  let repo: TempRepo;

  before(async () => {
    repo = await createTempRepo({ empty: true });
    process.env['RELAY_HOME'] = repo.relayHome;
  });

  after(async () => {
    delete process.env['RELAY_HOME'];
    await repo.cleanup();
  });

  it('is discovered rather than refused', async () => {
    const info = await discoverRepository(repo.root);

    assert.equal(info.isEmpty, true);
    assert.equal(info.headSha, '');
    // HEAD is unborn, but it still names the branch the first commit creates.
    assert.equal(info.currentBranch, 'main');
    assert.equal(info.defaultBranch, 'main');
  });

  it('branches a worktree from the empty tree, leaving the checkout unborn', async () => {
    const info = await discoverRepository(repo.root);
    const worktree = await createWorktree({ repo: info, issue: 'first-project', runShortId: 'emp001' });

    assert.equal(worktree.fromEmptyRepository, true);
    assert.equal(worktree.baseSha, await emptyTreeSha(repo.root));
    assert.equal(await worktreeExists(worktree.path), true);
    // The base is a tree, not a commit — there is no commit to name.
    assert.equal(await repo.git('cat-file', '-t', worktree.baseSha), 'tree');

    // The user's own checkout is exactly as it was: still empty, still unborn.
    assert.equal((await discoverRepository(repo.root)).isEmpty, true);
    assert.equal(await repo.git('symbolic-ref', '--short', 'HEAD'), 'main');
  });

  it('measures every file the run wrote as an addition against nothing', async () => {
    const info = await discoverRepository(repo.root);
    const worktree = await createWorktree({ repo: info, issue: 'diff-it', runShortId: 'emp002' });

    // Nothing written yet: an empty repository and an untouched worktree are
    // the same diff, which is no diff at all.
    assert.equal((await snapshotDiff(worktree.path, worktree.baseSha)).isEmpty, true);

    await mkdir(join(worktree.path, 'src'), { recursive: true });
    await writeFile(join(worktree.path, 'src', 'index.ts'), 'export const started = true;\n', 'utf8');
    await writeFile(join(worktree.path, 'README.md'), '# New project\n', 'utf8');

    const snapshot = await snapshotDiff(worktree.path, worktree.baseSha);
    assert.equal(snapshot.isEmpty, false);
    assert.deepEqual(snapshot.files.map((file) => file.path).sort(), ['README.md', 'src/index.ts']);
    assert.deepEqual([...new Set(snapshot.files.map((file) => file.status))], ['A']);
    assert.equal(snapshot.deletions, 0);
  });

  it('commits the repository\'s first commit, with no parent and on the run branch', async () => {
    const info = await discoverRepository(repo.root);
    const worktree = await createWorktree({ repo: info, issue: 'commit-it', runShortId: 'emp003' });
    const subject = { branch: worktree.branch, baseSha: worktree.baseSha, changedFiles: 1 };

    // An unborn branch is not an answer Relay cannot give: it is work that was
    // never committed, which is exactly what `unlanded` means.
    await writeFile(join(worktree.path, 'index.ts'), 'export const value = 1;\n', 'utf8');
    assert.equal(await describeLanding(repo.root, subject), 'unlanded');

    const result = await commitWorktree(worktree.path, { subject: 'Start the project' });
    assert.ok(result !== undefined);
    assert.equal(await describeLanding(repo.root, subject), 'committed');

    // A root commit: no parent, and only the run's branch points at it.
    assert.equal(await repo.git('-C', worktree.path, 'rev-list', '--count', '--max-parents=0', 'HEAD'), '1');
    assert.equal(await repo.git('rev-parse', worktree.branch), result.sha);
    assert.equal((await discoverRepository(repo.root)).isEmpty, true);
  });

  it('has no base branch anywhere to open a pull request into', async () => {
    assert.equal(await branchExistsSomewhere(repo.root, 'main', null), false);
    // A run branch that has been committed does exist, which is what makes the
    // question about the base branch worth asking separately.
    const info = await discoverRepository(repo.root);
    const worktree = await createWorktree({ repo: info, issue: 'base-check', runShortId: 'emp004' });
    await writeFile(join(worktree.path, 'a.txt'), 'a\n', 'utf8');
    await commitWorktree(worktree.path, { subject: 'work' });

    assert.equal(await branchExistsSomewhere(repo.root, worktree.branch, null), true);
  });
});
