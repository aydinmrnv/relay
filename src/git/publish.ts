import { RelayError, errorMessage } from '../util/errors.ts';
import { git } from './repository.ts';

/**
 * Publishing a run's branch: the operations that move something outside the
 * run's own worktree.
 *
 * Everything here is unreachable unless a person asked for it by name — no
 * phase, no agent and no default calls into this file. What it does provide is
 * the honest version of "yes, push it": one git invocation, reported by what
 * git actually did, with the checks that decide whether the answer can be
 * offered at all done before the question is asked rather than after.
 */

export interface PushResult {
  remote: string;
  branch: string;
  sha: string;
}

export async function remoteUrl(repoRoot: string, remote = 'origin'): Promise<string | null> {
  try {
    const url = await git(['remote', 'get-url', remote], { cwd: repoRoot });
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

export async function hasRemote(repoRoot: string, remote = 'origin'): Promise<boolean> {
  return (await remoteUrl(repoRoot, remote)) !== null;
}

/**
 * Pushes a run branch and sets its upstream.
 *
 * Relay runs git without a terminal, so a repository whose credentials are not
 * already cached fails here rather than hanging on a prompt nobody can see. The
 * error says so and names the command to run by hand, which is the one thing
 * that does work in that situation.
 */
export async function pushBranch(
  repoRoot: string,
  branch: string,
  options: { remote?: string; signal?: AbortSignal } = {},
): Promise<PushResult> {
  const remote = options.remote ?? 'origin';
  const signalOpt = options.signal ? { signal: options.signal } : {};

  try {
    await git(['push', '--set-upstream', remote, branch], { cwd: repoRoot, ...signalOpt });
  } catch (error) {
    throw new RelayError(`Could not push ${branch} to ${remote}: ${errorMessage(error)}`, {
      code: 'PUSH_FAILED',
      hint:
        `Relay runs git with no terminal attached, so it cannot answer a credential prompt.\n` +
        `Push it yourself with \`git push -u ${remote} ${branch}\`, or run \`gh auth setup-git\` first.`,
      cause: error,
    });
  }

  return { remote, branch, sha: await git(['rev-parse', `refs/heads/${branch}`], { cwd: repoRoot, ...signalOpt }) };
}

/** Deletes a published run branch. Missing refs are a successful no-op. */
export async function deleteRemoteBranch(
  repoRoot: string,
  remote: string,
  branch: string,
  options: { signal?: AbortSignal } = {},
): Promise<'deleted' | 'absent'> {
  try {
    await git(['push', remote, '--delete', branch], {
      cwd: repoRoot,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return 'deleted';
  } catch (error) {
    const message = errorMessage(error);
    if (/remote ref does not exist|unable to delete|not found/i.test(message)) return 'absent';
    throw new RelayError(`Could not delete ${remote}/${branch}: ${message}`, { code: 'PUSH_FAILED', cause: error });
  }
}

/** Why a merge cannot run right now, phrased to be shown next to the option. */
export interface MergeReadiness {
  ok: boolean;
  reason?: string;
}

/**
 * Whether merging into the base branch would touch only what the user expects.
 *
 * A merge is the one action that writes to the user's own checkout, so it is
 * offered only when that checkout is already sitting on the base branch with
 * nothing uncommitted. Both conditions are read from git rather than assumed,
 * and the reason is kept so the menu can say why instead of hiding the option.
 */
export async function mergeReadiness(repoRoot: string, baseBranch: string): Promise<MergeReadiness> {
  let current: string;
  try {
    current = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot });
  } catch (error) {
    return { ok: false, reason: `git could not read your current branch: ${errorMessage(error)}` };
  }

  if (current !== baseBranch) {
    return { ok: false, reason: `your checkout is on ${current}, not ${baseBranch}` };
  }

  const dirty = await dirtyPaths(repoRoot);
  if (dirty.length > 0) {
    return { ok: false, reason: `your working tree has ${dirty.length} uncommitted change(s)` };
  }

  return { ok: true };
}

/**
 * What the user has in flight, which is not the same as what git reports.
 *
 * `.relay/` is Relay's own run record, written into the repository by the run
 * that is asking this question. Counting it would mean a repository that never
 * gitignored it could never merge — blocked, every time, by the evidence of the
 * work it is trying to merge.
 */
async function dirtyPaths(repoRoot: string): Promise<string[]> {
  const status = await git(['status', '--porcelain'], { cwd: repoRoot });

  return status
    .split('\n')
    .filter((line) => line.trim().length > 0)
    // Porcelain v1: two status characters, a space, then the path (renames
    // carry `old -> new`, whose new path is the one that matters here).
    .map((line) => line.slice(3).split(' -> ').pop()?.replace(/^"|"$/g, '') ?? '')
    // An untracked directory is reported as `.relay/`, a file inside it by its
    // full path; both start with the same prefix.
    .filter((path) => path.length > 0 && !path.startsWith('.relay/'));
}

export interface MergeResult {
  branch: string;
  into: string;
  sha: string;
  fastForward: boolean;
}

/**
 * Merges the run branch into the branch the user has checked out.
 *
 * The readiness check is repeated here rather than trusted from the caller,
 * because `git merge` merges into whatever HEAD happens to be: a caller that
 * skipped the check would merge a run into the branch the user wandered onto
 * while recording that it went into the base branch. Refusing is the only
 * honest answer to a question whose premise no longer holds.
 *
 * A merge that fails leaves conflict markers in the user's files, which is not
 * a state Relay is willing to hand back: the merge is aborted and the tree is
 * restored before the failure is reported. If even the abort fails, that is
 * said out loud rather than papered over.
 */
export async function mergeBranch(
  repoRoot: string,
  options: { branch: string; into: string; message?: string; signal?: AbortSignal },
): Promise<MergeResult> {
  const { branch, into } = options;
  const signalOpt = options.signal ? { signal: options.signal } : {};

  const ready = await mergeReadiness(repoRoot, into);
  if (!ready.ok) {
    throw new RelayError(`Cannot merge ${branch} into ${into}: ${ready.reason ?? 'the merge cannot run here'}.`, {
      code: 'MERGE_BLOCKED',
      hint: `Relay only merges into a clean checkout of ${into}. Nothing was changed.`,
    });
  }

  let output: string;
  try {
    output = await git(
      ['merge', '--no-edit', ...(options.message === undefined ? [] : ['-m', options.message]), branch],
      { cwd: repoRoot, ...signalOpt },
    );
  } catch (error) {
    const restored = await abortMerge(repoRoot);
    throw new RelayError(`Could not merge ${branch} into ${into}: ${errorMessage(error)}`, {
      code: 'MERGE_FAILED',
      hint: restored
        ? `Your checkout was restored to ${into} as it was. Merge it by hand if you want to resolve the conflicts: \`git merge ${branch}\`.`
        : `Relay could not undo the attempt. Run \`git merge --abort\` in ${repoRoot} to restore ${into}.`,
      cause: error,
    });
  }

  return {
    branch,
    into,
    sha: await git(['rev-parse', 'HEAD'], { cwd: repoRoot, ...signalOpt }),
    fastForward: /fast-forward/i.test(output),
  };
}

async function abortMerge(repoRoot: string): Promise<boolean> {
  try {
    await git(['merge', '--abort'], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}
