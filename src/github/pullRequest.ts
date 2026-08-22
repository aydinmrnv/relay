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

/**
 * Whether this repository lets a pull request merge itself once its checks
 * pass. Read from the repository settings rather than found out by trying:
 * `gh pr merge --auto` failing at the prompt is a worse answer than a
 * two-answer question.
 *
 * Anything that prevents an answer — no `gh`, no auth, a `gh` too old to know
 * the field — reads as "not available", because the fallback is simply not
 * offering the option.
 */
export async function autoMergeAllowed(
  repo: string | undefined,
  options: PullRequestOptions,
): Promise<boolean> {
  const binary = options.binary ?? 'gh';
  if ((await resolveExecutable(binary)) === null) return false;

  const result = await runProcess(
    binary,
    [
      'repo',
      'view',
      ...(repo === undefined ? [] : [repo]),
      '--json',
      'autoMergeAllowed',
      '--jq',
      '.autoMergeAllowed',
    ],
    {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? 15_000,
      ...(options.signal ? { signal: options.signal } : {}),
      env: { GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
    },
  );

  return result.ok && result.stdout.trim() === 'true';
}

/**
 * Arms GitHub's auto-merge on a pull request: `gh pr merge --auto`.
 *
 * Nothing merges here. The decision is made now, by a person, and GitHub holds
 * it until the required checks pass — which is why this is only ever reached
 * from a question that person answered.
 */
export async function enableAutoMerge(
  url: string,
  method: MergeMethod,
  options: PullRequestOptions,
): Promise<void> {
  const binary = options.binary ?? 'gh';

  const result = await runProcess(binary, ['pr', 'merge', url, '--auto', `--${method}`], {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 60_000,
    ...(options.signal ? { signal: options.signal } : {}),
    env: { GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
  });

  if (!result.ok) {
    const combined = `${result.stdout}\n${result.stderr}`;
    throw new RelayError(`\`gh pr merge --auto\` failed: ${lastLines(combined)}`, {
      code: 'AUTO_MERGE_FAILED',
      hint:
        `The pull request is open at ${url} and nothing was merged.\n` +
        'A repository with auto-merge disabled, or a pull request with no required checks to wait for, ' +
        'both land here — merge it now instead, or merge it on GitHub.',
    });
  }
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
