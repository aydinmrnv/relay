import { RelayError } from '../util/errors.ts';
import { runProcess, resolveExecutable } from '../process/runner.ts';
import type { Issue, IssueComment, IssueListFilters, IssueProvider, IssueSummary } from './types.ts';

export interface ParsedIssueRef {
  number: number;
  owner?: string;
  repo?: string;
}

/**
 * Accepts `142`, `#142`, `owner/repo#142`, and issue URLs. Pull-request URLs
 * are rejected explicitly rather than silently treated as issues.
 */
export function parseIssueRef(ref: string): ParsedIssueRef {
  const value = ref.trim();
  if (value.length === 0) {
    throw new RelayError('No issue reference provided.', {
      code: 'BAD_ISSUE_REF',
      hint: 'Pass an issue number, for example `relay run 142`.',
    });
  }

  const urlMatch = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/.exec(value);
  if (urlMatch) {
    const [, owner, repo, kind, num] = urlMatch;
    if (kind === 'pull') {
      throw new RelayError(`${value} is a pull request, not an issue.`, {
        code: 'BAD_ISSUE_REF',
        hint: 'Relay works from issues in this MVP.',
      });
    }
    return { number: Number.parseInt(num ?? '0', 10), owner: owner!, repo: repo! };
  }

  const slugMatch = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(value);
  if (slugMatch) {
    const [, owner, repo, num] = slugMatch;
    return { number: Number.parseInt(num ?? '0', 10), owner: owner!, repo: repo! };
  }

  const numberMatch = /^#?(\d+)$/.exec(value);
  if (numberMatch) {
    return { number: Number.parseInt(numberMatch[1] ?? '0', 10) };
  }

  throw new RelayError(`Could not understand issue reference: ${ref}`, {
    code: 'BAD_ISSUE_REF',
    hint: 'Use an issue number (142), owner/repo#142, or a full issue URL.',
  });
}

interface GhIssuePayload {
  number?: number;
  title?: string;
  body?: string;
  url?: string;
  state?: string;
  author?: { login?: string } | null;
  labels?: Array<{ name?: string }>;
  comments?: Array<{ author?: { login?: string } | null; createdAt?: string; body?: string }>;
}

/** Maps `gh issue view --json` output onto Relay's Issue, tolerating missing fields. */
export function normalizeGhIssue(
  payload: unknown,
  fallback: { owner?: string; name?: string; number: number },
): Issue {
  if (payload === null || typeof payload !== 'object') {
    throw new RelayError('GitHub returned an unexpected response for this issue.', { code: 'BAD_ISSUE_PAYLOAD' });
  }
  const raw = payload as GhIssuePayload;

  const number = typeof raw.number === 'number' ? raw.number : fallback.number;
  const url = typeof raw.url === 'string' ? raw.url : '';
  const fromUrl = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/issues\/\d+/.exec(url);

  const owner = fallback.owner ?? fromUrl?.[1];
  const name = fallback.name ?? fromUrl?.[2];

  const comments: IssueComment[] = Array.isArray(raw.comments)
    ? raw.comments.map((comment) => ({
        author: comment?.author?.login ?? 'unknown',
        createdAt: typeof comment?.createdAt === 'string' ? comment.createdAt : '',
        body: typeof comment?.body === 'string' ? comment.body : '',
      }))
    : [];

  return {
    id: owner !== undefined && name !== undefined ? `github:${owner}/${name}#${number}` : `github:#${number}`,
    number,
    title: typeof raw.title === 'string' ? raw.title : `Issue #${number}`,
    body: typeof raw.body === 'string' ? raw.body : '',
    url,
    state: typeof raw.state === 'string' ? raw.state.toLowerCase() : 'unknown',
    author: raw.author?.login ?? null,
    labels: Array.isArray(raw.labels)
      ? raw.labels.map((label) => label?.name).filter((name_): name_ is string => typeof name_ === 'string')
      : [],
    repository: owner !== undefined && name !== undefined ? { owner, name } : null,
    comments,
  };
}

const ISSUE_FIELDS = 'number,title,body,url,state,author,labels,comments';
const LIST_FIELDS = 'number,title,labels,createdAt,url,author,state';
const DEFAULT_LIST_LIMIT = 30;

export interface GitHubIssueProviderOptions {
  /** Directory `gh` runs in; determines the repository it resolves against. */
  cwd: string;
  /** Falls back to this repo when the ref carries no owner/name. */
  defaultRepo?: { owner: string; name: string } | null;
  binary?: string;
  timeoutMs?: number;
}

export class GitHubIssueProvider implements IssueProvider {
  readonly name = 'github';

  private readonly cwd: string;
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly defaultRepo: { owner: string; name: string } | null;

  constructor(options: GitHubIssueProviderOptions) {
    this.cwd = options.cwd;
    this.binary = options.binary ?? 'gh';
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.defaultRepo = options.defaultRepo ?? null;
  }

  /** Argv construction is separated out so tests can assert it without spawning `gh`. */
  buildArgs(ref: ParsedIssueRef): string[] {
    const args = ['issue', 'view', String(ref.number), '--json', ISSUE_FIELDS];
    const owner = ref.owner ?? this.defaultRepo?.owner;
    const repo = ref.repo ?? this.defaultRepo?.name;
    if (owner !== undefined && repo !== undefined) {
      args.push('--repo', `${owner}/${repo}`);
    }
    return args;
  }

  buildListArgs(filters: IssueListFilters): string[] {
    const args = ['issue', 'list', '--json', LIST_FIELDS, '--state', 'open', '--limit', String(filters.limit ?? DEFAULT_LIST_LIMIT)];
    for (const label of filters.labels ?? []) args.push('--label', label);
    if (filters.mine === true) args.push('--assignee', '@me');
    else if (filters.assignee !== undefined) args.push('--assignee', filters.assignee);
    if (this.defaultRepo !== null) args.push('--repo', `${this.defaultRepo.owner}/${this.defaultRepo.name}`);
    return args;
  }

  async listIssues(filters: IssueListFilters, options: { signal?: AbortSignal } = {}): Promise<IssueSummary[]> {
    const result = await runProcess(this.binary, this.buildListArgs(filters), {
      cwd: this.cwd,
      timeoutMs: this.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
      env: { GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
    });
    if (!result.ok) {
      const stderr = result.stderr.trim();
      if (/auth|logged in|authentication/i.test(stderr)) {
        throw new RelayError('GitHub CLI is not authenticated.', { code: 'GH_NOT_AUTHENTICATED', hint: 'Run `gh auth login`, then `relay doctor`.' });
      }
      throw new RelayError(`Failed to list issues: ${stderr.split('\n').slice(-3).join(' ')}`, { code: 'GH_FAILED', hint: 'Run `relay doctor` to check your GitHub CLI setup.' });
    }
    let payload: unknown;
    try { payload = JSON.parse(result.stdout); } catch (error) {
      throw new RelayError('GitHub CLI returned output that was not valid JSON.', { code: 'BAD_ISSUE_PAYLOAD', cause: error });
    }
    if (!Array.isArray(payload)) throw new RelayError('GitHub returned an unexpected issue list.', { code: 'BAD_ISSUE_PAYLOAD' });
    return payload.map((entry: unknown) => {
      const raw = (entry !== null && typeof entry === 'object' ? entry : {}) as GhIssuePayload & { createdAt?: string };
      return {
        number: typeof raw.number === 'number' ? raw.number : 0,
        title: typeof raw.title === 'string' ? raw.title : '',
        labels: Array.isArray(raw.labels) ? raw.labels.map((label) => label?.name).filter((name): name is string => typeof name === 'string') : [],
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
        url: typeof raw.url === 'string' ? raw.url : '',
        author: raw.author?.login ?? null,
        state: typeof raw.state === 'string' ? raw.state.toLowerCase() : 'open',
      };
    });
  }

  async getIssue(ref: string, options: { signal?: AbortSignal } = {}): Promise<Issue> {
    const parsed = parseIssueRef(ref);
    const args = this.buildArgs(parsed);

    const result = await runProcess(this.binary, args, {
      cwd: this.cwd,
      timeoutMs: this.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
      env: { GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
    });

    if (!result.ok) {
      const stderr = result.stderr.trim();
      if (/could not resolve to an issue|not found/i.test(stderr)) {
        throw new RelayError(`Issue #${parsed.number} was not found.`, {
          code: 'ISSUE_NOT_FOUND',
          hint: 'Check the issue number and that you have access to the repository.',
        });
      }
      if (/auth|logged in|authentication/i.test(stderr)) {
        throw new RelayError('GitHub CLI is not authenticated.', {
          code: 'GH_NOT_AUTHENTICATED',
          hint: 'Run `gh auth login`, then `relay doctor`.',
        });
      }
      throw new RelayError(`Failed to fetch issue #${parsed.number}: ${stderr.split('\n').slice(-3).join(' ')}`, {
        code: 'GH_FAILED',
        hint: 'Run `relay doctor` to check your GitHub CLI setup.',
      });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(result.stdout);
    } catch (error) {
      throw new RelayError('GitHub CLI returned output that was not valid JSON.', {
        code: 'BAD_ISSUE_PAYLOAD',
        cause: error,
      });
    }

    const fallback: { owner?: string; name?: string; number: number } = { number: parsed.number };
    const owner = parsed.owner ?? this.defaultRepo?.owner;
    const name = parsed.repo ?? this.defaultRepo?.name;
    if (owner !== undefined) fallback.owner = owner;
    if (name !== undefined) fallback.name = name;

    return normalizeGhIssue(payload, fallback);
  }

  async comment(
    ref: string,
    body: string,
    options: { signal?: AbortSignal; marker?: string } = {},
  ): Promise<{ url?: string; created: boolean }> {
    if (options.marker !== undefined) {
      const issue = await this.getIssue(ref, options);
      if (issue.comments.some((entry) => entry.body.includes(options.marker!))) return { created: false };
    }
    const parsed = parseIssueRef(ref);
    const args = ['issue', 'comment', String(parsed.number)];
    const owner = parsed.owner ?? this.defaultRepo?.owner;
    const repo = parsed.repo ?? this.defaultRepo?.name;
    if (owner !== undefined && repo !== undefined) args.push('--repo', `${owner}/${repo}`);
    args.push('--body-file', '-');
    const result = await runProcess(this.binary, args, {
      cwd: this.cwd,
      timeoutMs: this.timeoutMs,
      stdin: body,
      ...(options.signal ? { signal: options.signal } : {}),
      env: { GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
    });
    if (!result.ok) {
      const stderr = result.stderr.trim();
      if (/auth|logged in|authentication/i.test(stderr)) {
        throw new RelayError('GitHub CLI is not authenticated.', { code: 'GH_NOT_AUTHENTICATED', hint: 'Run `gh auth login`.' });
      }
      throw new RelayError(`Failed to comment on issue #${parsed.number}: ${stderr}`, { code: 'GH_FAILED' });
    }
    const url = result.stdout.trim().split(/\s+/).find((part) => /^https?:\/\//.test(part));
    return { created: true, ...(url === undefined ? {} : { url }) };
  }

  /** Checks auth status without ever reading or printing the token itself. */
  async checkAvailability(): Promise<{ available: boolean; detail: string; hint?: string }> {
    const binaryPath = await resolveExecutable(this.binary);
    if (binaryPath === null) {
      return {
        available: false,
        detail: 'not installed',
        hint: 'Install the GitHub CLI (https://cli.github.com), then run `gh auth login`.',
      };
    }

    const result = await runProcess(this.binary, ['auth', 'status'], {
      cwd: this.cwd,
      timeoutMs: 20_000,
      env: { NO_COLOR: '1' },
    });

    if (!result.ok) {
      return { available: false, detail: 'not authenticated', hint: 'Run `gh auth login`.' };
    }

    // `gh auth status` prints the account name and a masked token; report only
    // the account so nothing token-shaped is ever echoed by Relay.
    const account = /Logged in to \S+ account (\S+)/.exec(`${result.stdout}\n${result.stderr}`)?.[1];
    return { available: true, detail: account === undefined ? 'authenticated' : `authenticated as ${account}` };
  }
}
