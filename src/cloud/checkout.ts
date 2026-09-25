import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { runProcess } from '../process/runner.ts';
import { configureGitForGithub } from '../studio/accounts.ts';
import { REPOSITORY_SLUG } from '../studio/runs.ts';
import { RelayError } from '../util/errors.ts';

/**
 * The repositories a cloud runner works in, one checkout each.
 *
 * A laptop runs in the repository `relay connect` was started in. A cloud
 * runner has none of its own: every run names `owner/name`, and the runner
 * keeps a checkout of each under `~/.relay/repos/`, cloned the first time
 * and fetched every time after. The engine never touches the checkout's own
 * working tree — it branches from `origin/<default>` into a worktree — so a
 * fetch is all a later run needs to start from what is on GitHub now.
 *
 * Clones are blobless (`--filter=blob:none`): history without file contents,
 * which git fetches when a worktree needs them. On a machine with a small
 * disk that works in a handful of repositories, that is most of the saving.
 */

const CLONE_TIMEOUT_MS = 15 * 60_000;
const FETCH_TIMEOUT_MS = 5 * 60_000;
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0' };

/** Checkouts in progress, by slug: two runs in one repository share the fetch instead of racing it. */
const inFlight = new Map<string, Promise<string>>();

export interface CheckoutOptions {
  /** Where checkouts live. */
  root: string;
  /** The remote, from the slug. A seam for the tests, which clone from a local path. */
  remoteFor?: (slug: string) => string;
}

export function checkoutPath(root: string, slug: string): string {
  const [owner, name] = slug.split('/') as [string, string];
  return join(root, owner.toLowerCase(), name.toLowerCase());
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function git(args: string[], cwd: string, timeoutMs: number, slug: string): Promise<void> {
  const result = await runProcess('git', args, { cwd, timeoutMs, env: GIT_ENV, maxCaptureChars: 64_000 });
  if (result.ok) return;
  const said = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-3).join('\n');
  if (/could not read Username|Authentication failed|Repository not found|terminal prompts disabled/i.test(said)) {
    throw new RelayError(`GitHub would not let this machine read ${slug}.`, {
      code: 'CHECKOUT_DENIED',
      hint: 'Sign in to GitHub on your cloud machine (Settings → Agent accounts), with an account that can read the repository.',
    });
  }
  throw new RelayError(`git ${args[0]} failed${result.timedOut ? ' (timed out)' : ''}: ${said}`, { code: 'CHECKOUT_FAILED' });
}

/**
 * Clones or fetches `owner/name`, and answers with the checkout's root. A run
 * stopped while it waits stops waiting; the clone itself carries on for any
 * other run that wants the same repository, and for the next one.
 */
export function checkoutRepository(slug: string, signal: AbortSignal, options: CheckoutOptions): Promise<string> {
  if (!REPOSITORY_SLUG.test(slug)) return Promise.reject(new RelayError(`"${slug}" is not a GitHub repository.`, { code: 'BAD_REPOSITORY' }));
  const stopped = new Promise<never>((_, reject) => {
    const abort = () => reject(new RelayError('Stopped while checking out the repository.', { code: 'CANCELLED' }));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  stopped.catch(() => undefined);
  return Promise.race([shared(slug, options), stopped]);
}

function shared(slug: string, options: CheckoutOptions): Promise<string> {
  const key = slug.toLowerCase();
  const running = inFlight.get(key);
  if (running !== undefined) return running;
  const work = (async () => {
    const path = checkoutPath(options.root, slug);
    const remote = options.remoteFor?.(slug) ?? `https://github.com/${slug}.git`;
    // Harmless when gh is signed out or absent; when it is signed in, git asks it for credentials.
    if (options.remoteFor === undefined) await configureGitForGithub().catch(() => false);
    if (await exists(join(path, '.git'))) {
      await git(['fetch', '--prune', '--quiet', 'origin'], path, FETCH_TIMEOUT_MS, slug);
      // Follow a renamed default branch, so the engine branches from the right one.
      await runProcess('git', ['remote', 'set-head', 'origin', '--auto'], { cwd: path, timeoutMs: 60_000, env: GIT_ENV }).catch(() => undefined);
      return path;
    }
    await mkdir(join(path, '..'), { recursive: true });
    await git(['clone', '--quiet', '--filter=blob:none', '--', remote, path], options.root, CLONE_TIMEOUT_MS, slug);
    return path;
  })();
  inFlight.set(key, work);
  const clear = () => {
    if (inFlight.get(key) === work) inFlight.delete(key);
  };
  work.then(clear, clear);
  return work;
}
