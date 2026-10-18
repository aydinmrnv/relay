/**
 * GitHub's REST API, asked with a person's user token. Every answer that is
 * not what the caller wanted becomes an `ApiError` the studio can show as it
 * is: what GitHub refused, and what to do about it.
 */
import { ApiError } from '../errors';
import type { GitHubAppConfig } from '../env';

export interface Answer {
  status: number;
  data: unknown;
  headers: Headers;
}

/** A request to the API. GitHub's own errors come back as answers; only an unreachable GitHub throws. */
export async function ask(config: Pick<GitHubAppConfig, 'api'>, token: string, method: string, path: string, body?: unknown): Promise<Answer> {
  let response: Response;
  try {
    response = await fetch(`${config.api}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'relay-studio',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ApiError(502, 'GITHUB_UNREACHABLE', 'GitHub could not be reached. Try again in a minute.');
  }
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { status: response.status, data, headers: response.headers };
}

/** GitHub's own sentence about a refusal, when it gave one. */
export function githubMessage(answer: Answer): string | null {
  const message = (answer.data as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.trim().length > 0 ? message.trim().slice(0, 300) : null;
}

/**
 * The error for an answer that was not the one wanted. `doing` finishes the
 * sentence "GitHub refused to …", so the message says which step failed.
 */
export function refusal(answer: Answer, doing: string): ApiError {
  const said = githubMessage(answer);
  if (answer.status === 401) return new ApiError(409, 'GITHUB_RECONNECT', 'GitHub no longer accepts Relay’s sign-in. Connect GitHub again.');
  if ((answer.status === 403 || answer.status === 429) && answer.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(answer.headers.get('x-ratelimit-reset') ?? '0');
    const retryAfter = reset > 0 ? Math.max(1, Math.ceil(reset - Date.now() / 1000)) : 60;
    return new ApiError(429, 'GITHUB_RATE_LIMITED', 'GitHub asked Relay to slow down. Try again in a few minutes.', { retryAfter });
  }
  if (answer.status === 403) return new ApiError(403, 'GITHUB_FORBIDDEN', `GitHub refused to ${doing}${said === null ? '.' : `: ${said}`}`);
  if (answer.status === 404) return new ApiError(404, 'GITHUB_NOT_FOUND', `GitHub refused to ${doing}: Relay cannot see it. Add the repository to Relay on GitHub, then try again.`);
  if (answer.status === 409 || answer.status === 422) return new ApiError(409, 'GITHUB_REFUSED', `GitHub refused to ${doing}${said === null ? '.' : `: ${said}`}`);
  return new ApiError(502, 'GITHUB_ERROR', `GitHub could not ${doing} (it answered ${answer.status}). Try again in a minute.`);
}

/** Asks, and returns the body of a 2xx answer or throws what GitHub refused. */
export async function call<T>(config: Pick<GitHubAppConfig, 'api'>, token: string, method: string, path: string, doing: string, body?: unknown): Promise<T> {
  const answer = await ask(config, token, method, path, body);
  if (answer.status < 200 || answer.status >= 300) throw refusal(answer, doing);
  return answer.data as T;
}

/** `owner/name` as a path, each half encoded. */
export function repoPath(repository: string): string {
  const [owner, name] = repository.split('/');
  return `/repos/${encodeURIComponent(owner ?? '')}/${encodeURIComponent(name ?? '')}`;
}
