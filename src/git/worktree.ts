import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { rm, mkdir, stat } from 'node:fs/promises';

import type { IssueIdentity } from '../issues/identity.ts';
import { RelayError } from '../util/errors.ts';
import { slugify } from '../util/text.ts';
import { git, resolveBaseRef, type RepositoryInfo } from './repository.ts';

export interface Worktree {
  /** Absolute path to the isolated checkout. */
  path: string;
  branch: string;
  /** Commit the branch was created from; every diff is computed against this. */
  baseSha: string;
  baseRef: string;
  baseBranch: string;
}

/** Root under which every Relay worktree lives. Nothing is ever removed outside it. */
export function workspacesRoot(): string {
  return process.env.RELAY_HOME !== undefined && process.env.RELAY_HOME.length > 0
    ? join(process.env.RELAY_HOME, 'workspaces')
    : join(homedir(), '.relay', 'workspaces');
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
export function canonicalizePath(candidate: string): string {
  const absolute = resolve(candidate);
  try {
    return realpathSync.native(absolute);
  } catch {
    // Not created yet — fall through to the ancestor walk.
  }

  const trailing: string[] = [];
  let current = absolute;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) return absolute;
    trailing.unshift(basename(current));
    current = parent;
    try {
      return join(realpathSync.native(current), ...trailing);
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
  const name = slugify(repo.name ?? repo.root.split(sep).pop() ?? 'repo', 'repo');
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
export function assertRemovableWorktreePath(candidate: string, root = workspacesRoot()): string {
  if (!isAbsolute(candidate)) {
    throw new RelayError(`Refusing to remove a non-absolute path: ${candidate}`, { code: 'UNSAFE_PATH' });
  }

  const normalizedRoot = canonicalizePath(root);
  const normalized = canonicalizePath(candidate);

  if (normalized === normalizedRoot) {
    throw new RelayError('Refusing to remove the Relay workspaces root itself.', { code: 'UNSAFE_PATH' });
  }

  const rel = relative(normalizedRoot, normalized);
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) {
    throw new RelayError(`Refusing to remove a path outside the Relay workspace root: ${candidate}`, {
      code: 'UNSAFE_PATH',
      hint: `Relay only removes directories under ${normalizedRoot}.`,
    });
  }

  // owner/repo/worktree — anything shallower would take out a whole repo or owner.
  const depth = rel.split(sep).filter((part) => part.length > 0).length;
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
 */
export async function createWorktree(options: CreateWorktreeOptions): Promise<Worktree> {
  const { repo, issue, runShortId } = options;
  const baseBranch = options.baseBranch ?? repo.defaultBranch;
  const base = await resolveBaseRef(repo.root, baseBranch);

  const path = worktreePathFor(repo, issue, runShortId);
  const branch = branchNameFor(issue, runShortId, options.branchPrefix);

  const existing = await findWorktree(repo.root, path);
  if (existing) {
    return { path, branch: existing.branch ?? branch, baseSha: base.sha, baseRef: base.ref, baseBranch };
  }

  await mkdir(join(path, '..'), { recursive: true });

  await git(['worktree', 'add', '--no-track', '-b', branch, path, base.sha], {
    cwd: repo.root,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  return { path, branch, baseSha: base.sha, baseRef: base.ref, baseBranch };
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
