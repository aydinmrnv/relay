import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { git } from '../git/repository.ts';
import { RelayError } from '../util/errors.ts';

/** A fetch talks to a remote, so it gets a network's patience rather than a command's. */
const FETCH_TIMEOUT_MS = 120_000;

export interface CheckoutState {
  branch: string;
  /** The remote-tracking ref the branch follows, e.g. `origin/main`. */
  upstream: string;
  head: string;
  /** Local commits the remote does not have. */
  ahead: number;
  /** Remote commits this checkout does not have. */
  behind: number;
}

/**
 * Where the checkout stands against its remote, measured after a fetch so
 * "up to date" is a fact about the remote rather than about the last time
 * somebody fetched.
 */
export async function inspectCheckout(root: string): Promise<CheckoutState> {
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
  if (branch === 'HEAD') {
    throw new RelayError('The Relay checkout is not on a branch (detached HEAD).', {
      code: 'UPDATE_DETACHED',
      hint: `Check out a branch in ${root}, then run \`relay --update\` again.`,
    });
  }

  const remote = (await quiet(['config', '--get', `branch.${branch}.remote`], root)) ?? 'origin';
  await fetch(root, remote);

  const upstream = await resolveUpstream(root, branch, remote);
  const [ahead = '0', behind = '0'] = (
    await git(['rev-list', '--left-right', '--count', `HEAD...${upstream}`], { cwd: root })
  ).split(/\s+/);

  return {
    branch,
    upstream,
    head: await git(['rev-parse', '--short', 'HEAD'], { cwd: root }),
    ahead: Number.parseInt(ahead, 10) || 0,
    behind: Number.parseInt(behind, 10) || 0,
  };
}

async function fetch(root: string, remote: string): Promise<void> {
  try {
    await git(['fetch', '--quiet', '--prune', remote], { cwd: root, timeoutMs: FETCH_TIMEOUT_MS });
  } catch (error) {
    throw new RelayError(`Could not reach \`${remote}\` to check for a newer Relay.`, {
      code: 'UPDATE_FETCH_FAILED',
      hint: `Check your network, then run \`relay --update\` again. Nothing was changed in ${root}.`,
      cause: error,
    });
  }
}

/**
 * The branch's own upstream, falling back to the same name on the remote — a
 * checkout made by `git clone` has one, a branch made locally may not.
 */
async function resolveUpstream(root: string, branch: string, remote: string): Promise<string> {
  const configured = await quiet(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], root);
  if (configured !== null && configured.length > 0) return configured;

  const sameName = `${remote}/${branch}`;
  const exists = await quiet(['rev-parse', '--verify', '--quiet', `${sameName}^{commit}`], root);
  if (exists !== null && exists.length > 0) return sameName;

  throw new RelayError(`Branch \`${branch}\` in the Relay checkout tracks nothing on \`${remote}\`.`, {
    code: 'UPDATE_NO_UPSTREAM',
    hint: `Relay cannot tell what "latest" means here. In ${root}, check out the branch you installed from.`,
  });
}

/**
 * Advances the checkout to its upstream, and refuses to do anything else.
 *
 * `--ff-only` is the whole safety story: an update that cannot be a
 * fast-forward is a merge of somebody's local work, and Relay updating itself
 * is not the moment to attempt one.
 */
export async function fastForward(root: string, upstream: string): Promise<void> {
  try {
    await git(['merge', '--ff-only', upstream], { cwd: root });
  } catch (error) {
    throw new RelayError('The Relay checkout could not be fast-forwarded.', {
      code: 'UPDATE_FF_FAILED',
      hint:
        `Local changes in ${root} are in the way. Commit or stash them there, ` +
        'then run `relay --update` again.',
      cause: error,
    });
  }
}

/** Paths touched between two commits, used to decide whether install and build are needed. */
export async function changedPaths(root: string, from: string, to: string): Promise<string[]> {
  const output = await git(['diff', '--name-only', `${from}..${to}`], { cwd: root });
  return output.split('\n').filter((line) => line.length > 0);
}

/** Subjects of the commits an update brought in, newest first. */
export async function newCommits(root: string, from: string, to: string, limit: number): Promise<string[]> {
  const output = await git(['log', '--format=%s', `--max-count=${limit}`, `${from}..${to}`], { cwd: root });
  return output.split('\n').filter((line) => line.length > 0);
}

/** A git query whose failure is an answer ("not configured"), not an error. */
async function quiet(args: readonly string[], root: string): Promise<string | null> {
  try {
    return await git(args, { cwd: root });
  } catch {
    return null;
  }
}

/**
 * Whether the launcher will run compiled output. `bin/relay.mjs` prefers
 * `dist/` whenever it exists, so a checkout that has one is running stale code
 * until it is rebuilt, and a checkout that has none never needs a build.
 */
export async function usesCompiledBuild(root: string): Promise<boolean> {
  try {
    await access(join(root, 'dist'));
    return true;
  } catch {
    return false;
  }
}
