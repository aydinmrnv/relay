import { runProcess, resolveExecutable } from '../process/runner.ts';
import { RelayError } from '../util/errors.ts';

export interface PullRequestDraft {
  title: string;
  body: string;
  /** Branch the pull request merges into. */
  base: string;
  /** Branch carrying the work. Must already exist on the remote. */
  head: string;
  /** `owner/name`, when the run knows it. */
  repo?: string;
  draft?: boolean;
}

export interface PullRequestResult {
  url: string;
  number: number | null;
  /** False when a pull request for this branch already existed. */
  created: boolean;
}

export interface PullRequestOptions {
  cwd: string;
  binary?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Opens a pull request through the user's own `gh`.
 *
 * The body goes in on stdin rather than argv: a run summary is long, and an
 * argument list is the wrong place for text that grew from an issue nobody
 * here wrote. `gh` prints the URL of what it created, which is what gets
 * recorded — Relay never claims a pull request exists on its own say-so.
 *
 * A branch that already has a pull request is a success, not a failure: `gh`
 * reports the existing URL, and that URL is the answer to the question the user
 * actually asked.
 */
export async function createPullRequest(
  draft: PullRequestDraft,
  options: PullRequestOptions,
): Promise<PullRequestResult> {
  const binary = options.binary ?? 'gh';

  if ((await resolveExecutable(binary)) === null) {
    throw new RelayError(`${binary} is not installed, so Relay cannot open a pull request.`, {
      code: 'GH_NOT_INSTALLED',
      hint: 'Install the GitHub CLI (https://cli.github.com), or open the pull request in your browser.',
    });
  }

  const args = [
    'pr',
    'create',
    '--base',
    draft.base,
    '--head',
    draft.head,
    '--title',
    draft.title,
    '--body-file',
    '-',
    ...(draft.repo === undefined ? [] : ['--repo', draft.repo]),
    ...(draft.draft === true ? ['--draft'] : []),
  ];

  const result = await runProcess(binary, args, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 60_000,
    stdin: draft.body,
    ...(options.signal ? { signal: options.signal } : {}),
    env: { GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
  });

  const combined = `${result.stdout}\n${result.stderr}`;

  if (!result.ok) {
    const existing = /already exists:?\s*(https?:\/\/\S+)/i.exec(combined)?.[1];
    if (existing !== undefined) {
      return { url: existing, number: pullRequestNumber(existing), created: false };
    }
    if (/auth|logged in|authentication/i.test(combined)) {
      throw new RelayError('GitHub CLI is not authenticated, so Relay could not open a pull request.', {
        code: 'GH_NOT_AUTHENTICATED',
        hint: 'Run `gh auth login`, then `relay deliver <run>` to try again.',
      });
    }
    throw new RelayError(`\`gh pr create\` failed: ${lastLines(combined)}`, {
      code: 'PR_FAILED',
      hint: `Open it by hand with \`gh pr create --base ${draft.base} --head ${draft.head}\`.`,
    });
  }

  const url = /https?:\/\/\S+\/pull\/\d+/.exec(combined)?.[0];
  if (url === undefined) {
    throw new RelayError('`gh pr create` reported no pull request URL.', {
      code: 'PR_FAILED',
      hint: `Check with \`gh pr view --head ${draft.head}\`.`,
    });
  }

  return { url, number: pullRequestNumber(url), created: true };
}

export const MERGE_METHODS = ['squash', 'merge', 'rebase'] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export interface MergedPullRequest {
  url: string;
  method: MergeMethod;
}

/**
 * Merges a pull request through `gh`.
 *
 * The branch is deliberately left behind: it is the only copy of the run's work
 * that is not inside a throwaway worktree, and deleting it to tidy up would be
 * Relay destroying the thing it was asked to produce.
 */
export async function mergePullRequest(
  url: string,
  method: MergeMethod,
  options: PullRequestOptions,
): Promise<MergedPullRequest> {
  const binary = options.binary ?? 'gh';

  const result = await runProcess(binary, ['pr', 'merge', url, `--${method}`], {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 60_000,
    ...(options.signal ? { signal: options.signal } : {}),
    env: { GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
  });

  const combined = `${result.stdout}\n${result.stderr}`;
  if (!result.ok) {
    // Already merged is the one failure that is really a success — the work is
    // where it was asked to be, whoever put it there.
    if (/already merged|not mergeable because.*merged/i.test(combined)) return { url, method };

    throw new RelayError(`\`gh pr merge\` failed: ${lastLines(combined)}`, {
      code: 'MERGE_FAILED',
      hint:
        `The pull request is open at ${url} and the work is safe.\n` +
        `Branch protection, required checks and a disallowed merge method all land here — ` +
        `set \`workflow.mergeMethod\` in .relay/config.json, or merge it yourself.`,
    });
  }

  return { url, method };
}

export function pullRequestNumber(url: string): number | null {
  const match = /\/pull\/(\d+)/.exec(url);
  if (match?.[1] === undefined) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function lastLines(output: string, count = 4): string {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-count)
    .join('\n');
}
