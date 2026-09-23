import { RelayError, errorMessage } from '../util/errors.ts';
import { retryDelayMs, sleep } from '../workflow/retry.ts';
import type { Issue, IssueComment, IssueListFilters, IssueProvider, IssueSummary } from '../github/types.ts';

/**
 * Linear, spoken to directly over its GraphQL API.
 *
 * Linear has no first-party CLI to delegate to, so this is the provider that
 * talks to a tracker itself. It still holds no credential: the key is read from
 * `LINEAR_API_KEY` at the moment a request is made, sent in one header, and
 * never written to `.relay/`, logged, or echoed back — the redaction patterns
 * cover `lin_api_…` for the one place it could leak, an error message.
 */

export const LINEAR_API_URL = 'https://api.linear.app/graphql';
export const LINEAR_KEY_VARIABLE = 'LINEAR_API_KEY';
export const LINEAR_KEY_PAGE = 'https://linear.app/settings/account/security';

export type Fetch = typeof globalThis.fetch;

export interface LinearIssueProviderOptions {
  /** The team a bare `142` belongs to, e.g. `ENG`. Without it a bare number is GitHub's. */
  team?: string | null;
  fetch?: Fetch;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
  /** Attempts beyond the first for a request that failed transiently. */
  maxRetries?: number;
  timeoutMs?: number;
}

/**
 * `ENG-142`, `eng-142`, or `https://linear.app/acme/issue/ENG-142/some-slug`.
 * Returns the canonical identifier, or null when this is not a Linear reference.
 *
 * A team key is a letter followed by up to nine letters or digits — the shape
 * Linear enforces — so `v2-1` in a chat prompt is not mistaken for an issue
 * unless it actually looks like one.
 */
export function parseLinearRef(ref: string, options: { team?: string | null } = {}): string | null {
  const value = ref.trim();
  const url = /^https?:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]{0,9}-\d+)(?:[/?#]|$)/i.exec(value);
  if (url) return url[1]!.toUpperCase();
  const identifier = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d+)$/.exec(value);
  if (identifier) return `${identifier[1]!.toUpperCase()}-${Number.parseInt(identifier[2]!, 10)}`;
  const team = options.team?.trim();
  if (team) {
    const bare = /^#?(\d+)$/.exec(value);
    if (bare) return `${team.toUpperCase()}-${Number.parseInt(bare[1]!, 10)}`;
  }
  return null;
}

interface LinearUser { displayName?: string | null; name?: string | null }
interface LinearIssueNode {
  id?: string;
  identifier?: string;
  number?: number;
  title?: string;
  description?: string | null;
  url?: string;
  createdAt?: string;
  state?: { name?: string; type?: string } | null;
  creator?: LinearUser | null;
  labels?: { nodes?: Array<{ name?: string }> } | null;
  comments?: { nodes?: Array<{ body?: string; createdAt?: string; user?: LinearUser | null; botActor?: { name?: string } | null }> } | null;
  parent?: { identifier?: string; title?: string } | null;
  team?: { key?: string } | null;
}

const ISSUE_FIELDS = `
  id identifier number title description url createdAt
  state { name type }
  creator { displayName name }
  labels(first: 50) { nodes { name } }
  parent { identifier title }
  team { key }
`;

const ISSUE_QUERY = `query RelayIssue($id: String!) {
  issue(id: $id) {
    ${ISSUE_FIELDS}
    comments(first: 100) { nodes { body createdAt user { displayName name } botActor { name } } }
  }
}`;

const LIST_QUERY = `query RelayIssues($first: Int!, $filter: IssueFilter) {
  issues(first: $first, filter: $filter, orderBy: updatedAt) {
    nodes { identifier number title url createdAt state { name } creator { displayName name } labels(first: 20) { nodes { name } } }
  }
}`;

const COMMENTS_QUERY = `query RelayIssueComments($id: String!) {
  issue(id: $id) { id url comments(first: 250) { nodes { body url } } }
}`;

const COMMENT_MUTATION = `mutation RelayComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success comment { url } }
}`;

const VIEWER_QUERY = `query RelayViewer { viewer { name displayName } organization { name } }`;

function person(user: LinearUser | null | undefined): string | null {
  const name = user?.displayName ?? user?.name;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

/**
 * Maps a Linear issue onto Relay's `Issue`. State is Linear's own name —
 * "In Progress", "Todo", "Done" — rather than a forced open/closed, except that
 * a completed or cancelled issue is reported as `closed` so the existing
 * "this issue is closed, run it anyway?" guard still applies.
 */
export function normalizeLinearIssue(node: LinearIssueNode): Issue {
  const identifier = node.identifier;
  if (typeof identifier !== 'string' || typeof node.title !== 'string') {
    throw new RelayError('Linear returned an issue without an identifier or title.', { code: 'BAD_ISSUE_PAYLOAD' });
  }
  const type = node.state?.type;
  const closed = type === 'completed' || type === 'canceled';
  const comments: IssueComment[] = (node.comments?.nodes ?? [])
    .filter((comment) => typeof comment.body === 'string' && comment.body.trim().length > 0)
    .map((comment) => ({
      author: person(comment.user) ?? comment.botActor?.name ?? 'unknown',
      createdAt: comment.createdAt ?? '',
      body: comment.body!,
    }))
    // Linear returns newest first; a conversation reads oldest first.
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  let body = node.description ?? '';
  if (node.parent?.identifier !== undefined) {
    body = `${body.trim()}\n\n_Sub-issue of ${node.parent.identifier}${node.parent.title ? `: ${node.parent.title}` : ''}._`.trim();
  }

  return {
    id: `linear:${identifier}`,
    number: null,
    key: identifier,
    title: node.title,
    body,
    url: node.url ?? '',
    state: closed ? 'closed' : (node.state?.name ?? 'open'),
    author: person(node.creator),
    labels: (node.labels?.nodes ?? []).map((label) => label.name).filter((name): name is string => typeof name === 'string'),
    repository: null,
    comments,
  };
}

export class LinearIssueProvider implements IssueProvider {
  readonly name = 'linear';
  private readonly team: string | null;
  private readonly fetcher: Fetch;
  private readonly env: NodeJS.ProcessEnv;
  private readonly pause: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(options: LinearIssueProviderOptions = {}) {
    this.team = options.team?.trim() || null;
    this.fetcher = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.env = options.env ?? process.env;
    this.pause = options.sleep ?? sleep;
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  /** Whether `ref` names a Linear issue, given this provider's default team. */
  parseRef(ref: string): string | null {
    return parseLinearRef(ref, { team: this.team });
  }

  private identifierFor(ref: string): string {
    const identifier = this.parseRef(ref);
    if (identifier === null) {
      throw new RelayError(`Could not understand Linear issue reference: ${ref}`, {
        code: 'BAD_ISSUE_REF',
        hint: 'Use an identifier like ENG-142 or a linear.app issue URL.',
      });
    }
    return identifier;
  }

  async getIssue(ref: string, options: { signal?: AbortSignal } = {}): Promise<Issue> {
    const identifier = this.identifierFor(ref);
    const data = await this.request<{ issue: LinearIssueNode | null }>(ISSUE_QUERY, { id: identifier }, options.signal);
    if (data.issue === null || data.issue === undefined) {
      throw new RelayError(`Linear issue ${identifier} was not found.`, {
        code: 'ISSUE_NOT_FOUND',
        hint: 'Check the identifier, and that the API key belongs to a member of that workspace.',
      });
    }
    return normalizeLinearIssue(data.issue);
  }

  async listIssues(filters: IssueListFilters, options: { signal?: AbortSignal } = {}): Promise<IssueSummary[]> {
    const and: object[] = [{ state: { type: { nin: ['completed', 'canceled'] } } }];
    if (this.team !== null) and.push({ team: { key: { eq: this.team.toUpperCase() } } });
    for (const label of filters.labels ?? []) and.push({ labels: { some: { name: { eqIgnoreCase: label } } } });
    if (filters.mine === true) and.push({ assignee: { isMe: { eq: true } } });
    else if (filters.assignee !== undefined && filters.assignee.length > 0) {
      and.push({ assignee: { or: [{ displayName: { eqIgnoreCase: filters.assignee } }, { email: { eqIgnoreCase: filters.assignee } }] } });
    }
    const data = await this.request<{ issues: { nodes: LinearIssueNode[] } }>(
      LIST_QUERY,
      { first: Math.min(Math.max(filters.limit ?? 30, 1), 100), filter: { and } },
      options.signal,
    );
    return (data.issues?.nodes ?? []).flatMap((node) => {
      if (typeof node.identifier !== 'string' || typeof node.title !== 'string') return [];
      return [{
        number: node.number ?? 0,
        ref: node.identifier,
        title: node.title,
        labels: (node.labels?.nodes ?? []).map((label) => label.name).filter((name): name is string => typeof name === 'string'),
        createdAt: node.createdAt ?? '',
        url: node.url ?? '',
        author: person(node.creator),
        state: node.state?.name ?? 'open',
      }];
    });
  }

  /**
   * Comments once per run. The marker is an HTML comment, which Linear may or
   * may not keep when it stores markdown, so the run id it carries is also
   * checked for on its own — a retried delivery must not comment twice.
   */
  async comment(
    ref: string,
    body: string,
    options: { signal?: AbortSignal; marker?: string } = {},
  ): Promise<{ url?: string; created: boolean }> {
    const identifier = this.identifierFor(ref);
    const existing = await this.request<{ issue: { id: string; comments: { nodes: Array<{ body?: string; url?: string }> } } | null }>(
      COMMENTS_QUERY,
      { id: identifier },
      options.signal,
    );
    if (existing.issue === null || existing.issue === undefined) {
      throw new RelayError(`Linear issue ${identifier} was not found.`, { code: 'ISSUE_NOT_FOUND' });
    }
    if (options.marker !== undefined) {
      const runId = /relay-run:\s*(\S+)/.exec(options.marker)?.[1];
      const prior = existing.issue.comments.nodes.find(
        (comment) => comment.body?.includes(options.marker!) === true || (runId !== undefined && comment.body?.includes(runId) === true),
      );
      if (prior !== undefined) return { ...(prior.url === undefined ? {} : { url: prior.url }), created: false };
    }
    const result = await this.request<{ commentCreate: { success: boolean; comment?: { url?: string } | null } }>(
      COMMENT_MUTATION,
      { issueId: existing.issue.id, body },
      options.signal,
    );
    if (result.commentCreate?.success !== true) {
      throw new RelayError(`Linear refused the comment on ${identifier}.`, { code: 'LINEAR_FAILED' });
    }
    const url = result.commentCreate.comment?.url;
    return { ...(url === undefined ? {} : { url }), created: true };
  }

  async checkAvailability(): Promise<{ available: boolean; detail: string; hint?: string }> {
    if (this.key() === undefined) {
      return {
        available: false,
        detail: `${LINEAR_KEY_VARIABLE} not set`,
        hint: `Create a personal API key at ${LINEAR_KEY_PAGE}, then \`export ${LINEAR_KEY_VARIABLE}=…\` in your shell profile.`,
      };
    }
    try {
      const data = await this.request<{ viewer: LinearUser; organization?: { name?: string } }>(VIEWER_QUERY, {});
      const who = person(data.viewer) ?? 'unknown user';
      const org = data.organization?.name;
      return { available: true, detail: `authenticated as ${who}${org ? ` (${org})` : ''}` };
    } catch (error) {
      const hint = error instanceof RelayError ? error.hint : undefined;
      return { available: false, detail: errorMessage(error), ...(hint === undefined ? {} : { hint }) };
    }
  }

  private key(): string | undefined {
    const value = this.env[LINEAR_KEY_VARIABLE]?.trim();
    return value === undefined || value.length === 0 ? undefined : value;
  }

  /**
   * One GraphQL request. Network failures, 429 and 5xx are retried with the
   * same backoff agent turns use; an auth failure never is, because a second
   * attempt with the same key reaches the same answer.
   */
  private async request<T>(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const key = this.key();
    if (key === undefined) {
      throw new RelayError(`${LINEAR_KEY_VARIABLE} is not set, so Relay cannot read Linear.`, {
        code: 'LINEAR_AUTH',
        hint: `Create a personal API key at ${LINEAR_KEY_PAGE} and export it as ${LINEAR_KEY_VARIABLE}.`,
      });
    }
    const total = this.maxRetries + 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= total; attempt += 1) {
      let response: Response;
      try {
        const timeout = AbortSignal.timeout(this.timeoutMs);
        response = await this.fetcher(LINEAR_API_URL, {
          method: 'POST',
          // Linear's personal keys go in the header bare, without `Bearer`.
          headers: { 'content-type': 'application/json', authorization: key },
          body: JSON.stringify({ query, variables }),
          signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
        });
      } catch (error) {
        if (signal?.aborted === true) throw error;
        lastError = new RelayError(`Could not reach Linear: ${errorMessage(error)}`, { code: 'LINEAR_UNREACHABLE', cause: error });
        if (attempt < total) await this.pause(retryDelayMs(attempt));
        continue;
      }

      let payload: { data?: T; errors?: Array<{ message?: string; extensions?: { code?: string; type?: string } }> } | undefined;
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        payload = undefined;
      }
      const firstError = payload?.errors?.[0];
      const code = `${firstError?.extensions?.code ?? ''} ${firstError?.extensions?.type ?? ''}`;
      if (response.status === 401 || /AUTHENTICATION|FORBIDDEN/i.test(code)) {
        throw new RelayError('Linear rejected the API key.', {
          code: 'LINEAR_AUTH',
          hint: `Check ${LINEAR_KEY_VARIABLE}; create a new key at ${LINEAR_KEY_PAGE} if it was revoked.`,
        });
      }
      if (response.status === 429 || response.status >= 500 || /RATELIMITED/i.test(code)) {
        lastError = new RelayError(`Linear answered HTTP ${response.status}${firstError?.message ? `: ${firstError.message}` : ''}`, { code: 'LINEAR_UNAVAILABLE' });
        if (attempt < total) await this.pause(retryDelayMs(attempt));
        continue;
      }
      if (firstError !== undefined) {
        const message = firstError.message ?? 'unknown error';
        // Linear's answer for a missing issue is an error rather than a null.
        if (/not found|entity not found/i.test(message)) return { issue: null } as T;
        throw new RelayError(`Linear: ${message}`, { code: 'LINEAR_FAILED' });
      }
      if (!response.ok || payload?.data === undefined) {
        throw new RelayError(`Linear answered HTTP ${response.status} with no data.`, { code: 'LINEAR_FAILED' });
      }
      return payload.data;
    }
    throw lastError ?? new RelayError('Linear request failed.', { code: 'LINEAR_FAILED' });
  }
}
