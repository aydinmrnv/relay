import { RelayError } from '../util/errors.ts';
import { runProcess } from '../process/runner.ts';

export interface RepositoryInfo {
  /** Absolute path to the repository root (the user's checkout). */
  root: string;
  /** Path to the shared `.git` directory, common to all worktrees. */
  gitDir: string;
  currentBranch: string | null;
  headSha: string;
  isDirty: boolean;
  dirtyFiles: string[];
  defaultBranch: string;
  remoteUrl: string | null;
  owner: string | null;
  name: string | null;
}

export async function git(
  args: readonly string[],
  options: { cwd: string; timeoutMs?: number; signal?: AbortSignal; stdin?: string },
): Promise<string> {
  const result = await runProcess('git', args, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 120_000,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    // Keep git non-interactive: a credential or editor prompt inside an
    // orchestrated run would hang forever with no one to answer it.
    env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  if (!result.ok) {
    throw new RelayError(
      `git ${args.join(' ')} failed: ${(result.stderr.trim() || result.stdout.trim()).split('\n').slice(-4).join('\n')}`,
      { code: 'GIT_FAILED' },
    );
  }
  return result.stdout.trim();
}

async function gitQuiet(args: readonly string[], cwd: string): Promise<string | null> {
  try {
    return await git(args, { cwd });
  } catch {
    return null;
  }
}

export async function discoverRepository(cwd: string): Promise<RepositoryInfo> {
  const root = await gitQuiet(['rev-parse', '--show-toplevel'], cwd);
  if (root === null) {
    throw new RelayError('Not inside a git repository.', {
      code: 'NOT_A_REPOSITORY',
      hint: 'Run relay from inside a git repository, or run `git init` first.',
    });
  }

  const gitDir = (await gitQuiet(['rev-parse', '--path-format=absolute', '--git-common-dir'], root)) ?? `${root}/.git`;
  const branchRaw = await gitQuiet(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const currentBranch = branchRaw === null || branchRaw === 'HEAD' ? null : branchRaw;

  const headSha = (await gitQuiet(['rev-parse', 'HEAD'], root)) ?? '';
  if (headSha === '') {
    throw new RelayError('This repository has no commits yet.', {
      code: 'EMPTY_REPOSITORY',
      hint: 'Relay branches from an existing commit. Make an initial commit first.',
    });
  }

  const status = (await gitQuiet(['status', '--porcelain'], root)) ?? '';
  const dirtyFiles = status
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const remoteUrl = await gitQuiet(['remote', 'get-url', 'origin'], root);
  const slug = remoteUrl === null ? null : parseRemoteUrl(remoteUrl);

  return {
    root,
    gitDir,
    currentBranch,
    headSha,
    isDirty: dirtyFiles.length > 0,
    dirtyFiles,
    defaultBranch: await detectDefaultBranch(root),
    remoteUrl,
    owner: slug?.owner ?? null,
    name: slug?.name ?? null,
  };
}

/**
 * Parses github remotes in both SSH and HTTPS forms.
 * Returns null for hosts we cannot confidently interpret.
 */
export function parseRemoteUrl(url: string): { host: string; owner: string; name: string } | null {
  const trimmed = url.trim().replace(/\.git$/, '');

  const sshMatch = /^(?:ssh:\/\/)?(?:[^@]+@)?([^:/]+)[:/]([^/]+)\/(.+)$/.exec(trimmed);
  const httpsMatch = /^https?:\/\/(?:[^@]+@)?([^/]+)\/([^/]+)\/(.+)$/.exec(trimmed);
  const match = httpsMatch ?? sshMatch;
  if (!match) return null;

  const [, host, owner, rest] = match;
  if (!host || !owner || !rest) return null;

  const name = rest.split('/').pop();
  if (!name) return null;

  return { host, owner, name };
}

/**
 * Prefers the remote's own idea of HEAD, then a local default-looking branch.
 * Never guesses a branch that does not exist.
 */
export async function detectDefaultBranch(root: string): Promise<string> {
  const symbolic = await gitQuiet(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root);
  if (symbolic !== null && symbolic.length > 0) {
    return symbolic.replace(/^origin\//, '');
  }

  for (const candidate of ['main', 'master', 'develop', 'trunk']) {
    const exists = await gitQuiet(['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`], root);
    if (exists !== null && exists.length > 0) return candidate;
  }

  const current = await gitQuiet(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  return current !== null && current !== 'HEAD' ? current : 'HEAD';
}

/** Resolves a ref to a sha, preferring the remote-tracking copy when present. */
export async function resolveBaseRef(root: string, branch: string): Promise<{ ref: string; sha: string }> {
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`, branch]) {
    const sha = await gitQuiet(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root);
    if (sha !== null && sha.length > 0) return { ref, sha };
  }
  throw new RelayError(`Could not resolve base branch \`${branch}\`.`, {
    code: 'BASE_REF_NOT_FOUND',
    hint: 'Set a valid base with `relay run <issue> --base <branch>`.',
  });
}
