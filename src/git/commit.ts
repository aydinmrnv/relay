import { git } from './repository.ts';

export interface CoAuthor {
  name: string;
  email: string;
}

export interface CommitOptions {
  subject: string;
  /** Paragraphs placed under the subject, in order. */
  body?: readonly string[];
  coAuthors?: readonly CoAuthor[];
  signal?: AbortSignal;
}

export interface CommitResult {
  sha: string;
  message: string;
  at: string;
}

/**
 * Commits everything the run produced to the worktree's own branch.
 *
 * This is the only write Relay makes to git state, and it is deliberately
 * local: a commit on a throwaway branch inside `~/.relay/workspaces` publishes
 * nothing, moves no shared ref, and is undone with a single `git reset`. Push,
 * merge and PR remain the user's decision.
 */
export async function commitWorktree(
  worktreePath: string,
  options: CommitOptions,
): Promise<CommitResult | undefined> {
  const signalOpt = options.signal ? { signal: options.signal } : {};

  await git(['add', '-A'], { cwd: worktreePath, ...signalOpt });

  const staged = await git(['diff', '--cached', '--name-only'], { cwd: worktreePath, ...signalOpt });
  if (staged.trim().length === 0) return undefined;

  const message = buildCommitMessage(options);
  const identity = await commitIdentity(worktreePath);

  await git(
    [
      ...identity,
      // Signing can block on a passphrase prompt no one is there to answer, and
      // repository hooks are arbitrary code Relay was not asked to run: this
      // commit only records work that has already been reviewed and tested.
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--no-verify',
      '--message',
      message,
    ],
    { cwd: worktreePath, ...signalOpt },
  );

  return {
    sha: await git(['rev-parse', 'HEAD'], { cwd: worktreePath, ...signalOpt }),
    message,
    at: new Date().toISOString(),
  };
}

export function buildCommitMessage(options: Pick<CommitOptions, 'subject' | 'body' | 'coAuthors'>): string {
  const parts = [options.subject.trim(), ...(options.body ?? []).map((part) => part.trim()).filter(Boolean)];

  const trailers = (options.coAuthors ?? []).map((author) => `Co-Authored-By: ${author.name} <${author.email}>`);
  if (trailers.length > 0) parts.push(trailers.join('\n'));

  return `${parts.join('\n\n')}\n`;
}

/**
 * Falls back to a Relay identity only when git has none configured. Committing
 * is meant to rescue finished work, so it must not fail on a machine that never
 * set `user.email`.
 */
async function commitIdentity(worktreePath: string): Promise<string[]> {
  const configured = await Promise.all(
    ['user.name', 'user.email'].map(async (key) => {
      try {
        return (await git(['config', '--get', key], { cwd: worktreePath })).trim();
      } catch {
        return '';
      }
    }),
  );
  if (configured.every((value) => value.length > 0)) return [];
  return ['-c', 'user.name=Relay', '-c', 'user.email=relay@localhost'];
}

/**
 * Whether a run's work has been captured in a commit, or is still only a staged
 * index that one `git worktree prune` would take with it.
 */
export type Landing = 'committed' | 'unlanded' | 'empty' | 'unknown';

export interface LandingSubject {
  branch: string;
  baseSha: string;
  /** Number of files the run changed, as Relay measured it. */
  changedFiles: number;
  /** Set once Relay itself committed the work. */
  committedSha?: string;
}

/**
 * Reports whether a run's diff still lives only in the worktree. `unknown` is
 * returned rather than guessed when the branch is gone or git cannot be read —
 * claiming work is safe when that cannot be verified is the one wrong answer.
 */
export async function describeLanding(repoRoot: string, subject: LandingSubject): Promise<Landing> {
  if (subject.committedSha !== undefined) return 'committed';
  if (subject.changedFiles === 0) return 'empty';

  let head: string;
  try {
    head = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${subject.branch}^{commit}`], { cwd: repoRoot });
  } catch {
    return 'unknown';
  }
  if (head.length === 0) return 'unknown';

  return head === subject.baseSha ? 'unlanded' : 'committed';
}
