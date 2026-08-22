import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { realpathSync } from 'node:fs';
import { rm, mkdir, stat } from 'node:fs/promises';

import type { IssueIdentity } from '../issues/identity.ts';
import { RelayError } from '../util/errors.ts';
import { slugify } from '../util/text.ts';
import { emptyTreeSha, git, resolveBaseRef, type RepositoryInfo } from './repository.ts';

export interface Worktree {
  /** Absolute path to the isolated checkout. */
  path: string;
  branch: string;
  /**
   * Commit the branch was created from; every diff is computed against this. In
   * a repository with no commits it is the empty tree instead — there is no
   * commit to name, and a diff against nothing is still a diff.
   */
  baseSha: string;
  baseRef: string;
  baseBranch: string;
  /**
   * True when the run branched from an empty repository: the branch is unborn
   * until the run commits, and that commit is the repository's first.
   */
  fromEmptyRepository?: boolean;
}

/** What `baseRef` records when there was no ref to branch from. */
export const EMPTY_BASE_REF = '(empty repository)';

/** Root under which every Relay worktree lives. Nothing is ever removed outside it. */
export function workspacesRoot(): string {
  return process.env.RELAY_HOME !== undefined && process.env.RELAY_HOME.length > 0
    ? join(process.env.RELAY_HOME, 'workspaces')
    : join(homedir(), '.relay', 'workspaces');
}

type PlatformPath = typeof posix;

/**
 * How paths behave on a platform: which `node:path` implementation applies and
 * whether two spellings that differ only in case name the same file. Injected
 * so the removal guard's Windows behaviour — drive letters, UNC prefixes,
 * case-insensitive comparison — is testable from any operating system.
 */
export interface PathStyle {
  path: PlatformPath;
  /** Windows filesystems compare case-insensitively; the guard must too. */
  caseInsensitive: boolean;
  /**
   * Whether canonicalization may consult the real filesystem. Simulated styles
   * turn it off: a `C:\` path has no realpath on the OS running the tests.
   */
  useRealpath: boolean;
}

export function nativePathStyle(): PathStyle {
  const isWindows = process.platform === 'win32';
  return {
    path: isWindows ? win32 : posix,
    caseInsensitive: isWindows,
    useRealpath: true,
  };
}

/**
 * Windows verbatim namespaces (`\\?\C:\…`, `\\?\UNC\server\share\…`) name the
 * same locations as their ordinary spellings but compare unequal as strings —
 * and `path.win32` passes them through untouched. Reduced here so the guard
 * compares what a path means, not how it is spelt.
 */
function stripVerbatimPrefix(candidate: string, style: PathStyle): string {
  if (style.path !== win32 || !/^[\\/]{2}\?[\\/]/.test(candidate)) return candidate;
  const rest = candidate.slice(4);
  if (/^UNC[\\/]/i.test(rest)) return `\\\\${rest.slice(4)}`;
  return rest;
}

/**
 * Resolves symlinks so paths Relay constructs can be compared with the paths
 * git reports. On macOS `/var` is a symlink to `/private/var`, so a temp-dir
 * worktree would otherwise never match git's own listing — and both the
 * "is this a worktree I created?" check and the removal guard would fail.
 *
 * Paths that do not exist yet are canonicalized against their nearest existing
 * ancestor, so the guard works before a directory is created.
 */
export function canonicalizePath(candidate: string, style: PathStyle = nativePathStyle()): string {
  const p = style.path;
  const absolute = p.resolve(stripVerbatimPrefix(candidate, style));
  if (!style.useRealpath) return absolute;
  try {
    return realpathSync.native(absolute);
  } catch {
    // Not created yet — fall through to the ancestor walk.
  }

  const trailing: string[] = [];
  let current = absolute;
  for (;;) {
    const parent = p.dirname(current);
    if (parent === current) return absolute;
    trailing.unshift(p.basename(current));
    current = parent;
    try {
      return p.join(realpathSync.native(current), ...trailing);
    } catch {
      continue;
    }
  }
}

/**
 * Both names a run is known by, built from the issue's identity and the run's
 * short id. The short id is what makes them collision-safe: two runs against the
 * same issue — or the same spec file — never share a branch or a directory.
 */
export function worktreePathFor(
  repo: Pick<RepositoryInfo, 'owner' | 'name' | 'root'>,
  issue: IssueIdentity,
  runShortId: string,
): string {
  const owner = slugify(repo.owner ?? 'local', 'local');
  // Split on both separators: git on Windows reports roots with forward
  // slashes even though the platform separator is a backslash.
  const name = slugify(repo.name ?? repo.root.split(/[\\/]/).pop() ?? 'repo', 'repo');
  return join(workspacesRoot(), owner, name, `issue-${slugify(String(issue), 'issue')}-${slugify(runShortId, 'run')}`);
}

export function branchNameFor(issue: IssueIdentity, runShortId: string, prefix = 'relay'): string {
  return `${prefix}/${slugify(String(issue), 'issue')}-${slugify(runShortId, 'run')}`;
}

/**
 * Guards every destructive path operation. A worktree may only be removed if it
 * sits strictly inside the Relay workspaces root — never the user's checkout,
 * never a parent directory, never a path escaping via `..` or a symlink.
 */
export function assertRemovableWorktreePath(
  candidate: string,
  root = workspacesRoot(),
  style: PathStyle = nativePathStyle(),
): string {
  const p = style.path;
  // A drive-relative spelling like `C:dir` is not absolute: it means "dir,
  // relative to wherever the process last stood on C:", which is exactly the
  // ambiguity a removal guard cannot accept.
  if (!p.isAbsolute(stripVerbatimPrefix(candidate, style))) {
    throw new RelayError(`Refusing to remove a non-absolute path: ${candidate}`, { code: 'UNSAFE_PATH' });
  }

  const normalizedRoot = canonicalizePath(root, style);
  const normalized = canonicalizePath(candidate, style);

  // `\\.\C:` and friends name devices, never worktrees.
  if (p === win32 && /^[\\/]{2}[.?][\\/]/.test(normalized)) {
    throw new RelayError(`Refusing to remove a Windows device-namespace path: ${candidate}`, { code: 'UNSAFE_PATH' });
  }

  // Comparisons fold case where the filesystem does; the returned path never
  // does — it is handed to git and `rm`, which want the caller's spelling.
  const fold = (value: string): string => (style.caseInsensitive ? value.toLowerCase() : value);

  if (fold(normalized) === fold(normalizedRoot)) {
    throw new RelayError('Refusing to remove the Relay workspaces root itself.', { code: 'UNSAFE_PATH' });
  }

  // `path.win32.relative` already compares case-insensitively and answers with
  // an absolute path when the two share no root — a different drive letter or
  // a different UNC share can never be "inside" the workspaces root.
  const rel = p.relative(normalizedRoot, normalized);
  if (rel.length === 0 || rel.startsWith('..') || p.isAbsolute(rel)) {
    throw new RelayError(`Refusing to remove a path outside the Relay workspace root: ${candidate}`, {
      code: 'UNSAFE_PATH',
      hint: `Relay only removes directories under ${normalizedRoot}.`,
    });
  }

  // owner/repo/worktree — anything shallower would take out a whole repo or owner.
  const depth = rel.split(p.sep).filter((part) => part.length > 0).length;
  if (depth < 3) {
    throw new RelayError(`Refusing to remove a shared workspace directory: ${candidate}`, {
      code: 'UNSAFE_PATH',
      hint: 'Only individual run worktrees (owner/repo/issue-N-id) can be removed.',
    });
  }

  return normalized;
}

export interface CreateWorktreeOptions {
  repo: RepositoryInfo;
  /**
   * What the branch and the worktree directory are named after: `142` for an
   * issue with a number, `fix-flaky-timeout` for a task without one.
   */
  issue: IssueIdentity;
  runShortId: string;
  baseBranch?: string;
  branchPrefix?: string;
  signal?: AbortSignal;
}

/**
 * Creates the isolated checkout for a run. The user's working tree is only ever
 * read: `git worktree add` does not touch the current branch, index, or files.
 *
 * A repository with no commits is a supported starting point rather than an
 * error. There is nothing to branch from, so the run gets a worktree on an
 * unborn branch and diffs against the empty tree; the commit it makes at the end
 * is the repository's first. Relay still writes nothing to the user's checkout:
 * the branch it creates is its own, and HEAD there stays unborn.
 */
export async function createWorktree(options: CreateWorktreeOptions): Promise<Worktree> {
  const { repo, issue, runShortId } = options;
  const baseBranch = options.baseBranch ?? repo.defaultBranch;
  const base = repo.isEmpty
    ? { ref: EMPTY_BASE_REF, sha: await emptyTreeSha(repo.root) }
    : await resolveBaseRef(repo.root, baseBranch);
  const empty = repo.isEmpty ? { fromEmptyRepository: true as const } : {};

  const path = worktreePathFor(repo, issue, runShortId);
  const branch = branchNameFor(issue, runShortId, options.branchPrefix);

  const existing = await findWorktree(repo.root, path);
  if (existing) {
    return { path, branch: existing.branch ?? branch, baseSha: base.sha, baseRef: base.ref, baseBranch, ...empty };
  }

  await mkdir(join(path, '..'), { recursive: true });

  const add = repo.isEmpty
    ? ['worktree', 'add', '--orphan', '-b', branch, path]
    : ['worktree', 'add', '--no-track', '-b', branch, path, base.sha];

  try {
    await git(add, { cwd: repo.root, ...(options.signal ? { signal: options.signal } : {}) });
  } catch (error) {
    if (!repo.isEmpty) throw error;
    // `--orphan` is the only way to check out a branch that has no commit, and
    // it arrived in git 2.42. The alternative is one command the user can run.
    throw new RelayError('Could not create a worktree in a repository with no commits.', {
      code: 'EMPTY_REPOSITORY',
      hint:
        'Starting from an empty repository needs `git worktree add --orphan`, which is git 2.42 or newer.\n' +
        'Upgrade git, or make the first commit yourself: `git commit --allow-empty -m "Initial commit"`.',
      cause: error,
    });
  }

  return { path, branch, baseSha: base.sha, baseRef: base.ref, baseBranch, ...empty };
}

export interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  locked: boolean;
}

export async function listWorktrees(repoRoot: string): Promise<WorktreeEntry[]> {
  const output = await git(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};

  const flush = (): void => {
    if (current.path !== undefined) {
      entries.push({
        path: current.path,
        head: current.head ?? null,
        branch: current.branch ?? null,
        locked: current.locked ?? false,
      });
    }
    current = {};
  };

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      current.path = line.slice('worktree '.length).trim();
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line.startsWith('locked')) {
      current.locked = true;
    }
  }
  flush();

  return entries;
}

async function findWorktree(repoRoot: string, path: string): Promise<WorktreeEntry | undefined> {
  try {
    const entries = await listWorktrees(repoRoot);
    const target = canonicalizePath(path);
    return entries.find((entry) => canonicalizePath(entry.path) === target);
  } catch {
    return undefined;
  }
}

export async function worktreeExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Removes a run's worktree. The branch is deliberately left behind: it holds the
 * only copy of the work, and deleting it would discard the run's output.
 */
export async function removeWorktree(
  repoRoot: string,
  path: string,
  options: { force?: boolean } = {},
): Promise<void> {
  const safePath = assertRemovableWorktreePath(path);

  const known = await findWorktree(repoRoot, safePath);
  if (!known) {
    throw new RelayError(`${safePath} is not a registered worktree of this repository.`, {
      code: 'UNKNOWN_WORKTREE',
      hint: 'Relay only removes worktrees that git itself reports for this repository.',
    });
  }

  const args = ['worktree', 'remove', safePath];
  if (options.force === true) args.push('--force');
  await git(args, { cwd: repoRoot });

  // `git worktree remove` leaves the directory behind if it held untracked
  // files. Re-validate before touching the filesystem directly.
  if (await worktreeExists(safePath)) {
    await rm(assertRemovableWorktreePath(safePath), { recursive: true, force: true });
  }
  await git(['worktree', 'prune'], { cwd: repoRoot });
}
