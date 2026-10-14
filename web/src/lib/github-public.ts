/**
 * What GitHub tells anyone about a repository, asked from the browser with no
 * token. Relay holds no GitHub credential, so this is all it can see: a public
 * repository answers, and a private one looks exactly like one that does not
 * exist. Every caller has to treat "could not see it" as an ordinary answer,
 * never as an error: a private repository is a perfectly good place to run.
 *
 * Unauthenticated requests are limited to sixty an hour per address, which is
 * plenty for setting a project up and nothing to build polling on.
 */

const API = 'https://api.github.com';
const HEADERS = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };

export interface PublicRepository {
  /** `owner/name`, in the capitalisation GitHub has it. */
  repository: string;
  description: string | null;
  defaultBranch: string;
  /** Whether the owner is a person rather than an organisation: a person can start their own runs. */
  ownerIsUser: boolean;
  owner: string;
  archived: boolean;
  fork: boolean;
  pushedAt: string | null;
}

export type RepositoryLookup =
  | { state: 'public'; repository: PublicRepository }
  /** GitHub says there is nothing there for a signed-out visitor: private, or mistyped. */
  | { state: 'unseen' }
  /** No answer worth trusting: offline, or past the hourly limit. */
  | { state: 'unknown'; reason: 'rate-limited' | 'offline' };

function toRepository(data: Record<string, unknown>): PublicRepository | null {
  const owner = data['owner'] as Record<string, unknown> | null | undefined;
  if (typeof data['full_name'] !== 'string' || owner === null || owner === undefined) return null;
  return {
    repository: data['full_name'],
    description: typeof data['description'] === 'string' && data['description'].trim().length > 0 ? data['description'].trim() : null,
    defaultBranch: typeof data['default_branch'] === 'string' ? data['default_branch'] : 'main',
    ownerIsUser: owner['type'] === 'User',
    owner: typeof owner['login'] === 'string' ? owner['login'] : data['full_name'].split('/')[0]!,
    archived: data['archived'] === true,
    fork: data['fork'] === true,
    pushedAt: typeof data['pushed_at'] === 'string' ? data['pushed_at'] : null,
  };
}

async function ask(path: string, signal?: AbortSignal): Promise<{ status: number; data: unknown } | null> {
  try {
    const response = await fetch(`${API}${path}`, { headers: HEADERS, signal, cache: 'no-store' });
    const data: unknown = await response.json().catch(() => null);
    return { status: response.status, data };
  } catch {
    return null;
  }
}

function failure(answer: { status: number } | null): { state: 'unknown'; reason: 'rate-limited' | 'offline' } {
  return { state: 'unknown', reason: answer !== null && (answer.status === 403 || answer.status === 429) ? 'rate-limited' : 'offline' };
}

/** Looks a repository up by `owner/name`. */
export async function lookupRepository(repository: string, signal?: AbortSignal): Promise<RepositoryLookup> {
  const [owner, name] = repository.split('/');
  const answer = await ask(`/repos/${encodeURIComponent(owner ?? '')}/${encodeURIComponent(name ?? '')}`, signal);
  if (answer === null) return failure(answer);
  if (answer.status === 404) return { state: 'unseen' };
  if (answer.status !== 200 || answer.data === null || typeof answer.data !== 'object') return failure(answer);
  const found = toRepository(answer.data as Record<string, unknown>);
  return found === null ? { state: 'unseen' } : { state: 'public', repository: found };
}

/** A person's or an organisation's public repositories, most recently pushed first. Empty when there are none to see. */
export async function listPublicRepositories(login: string, signal?: AbortSignal): Promise<PublicRepository[]> {
  const answer = await ask(`/users/${encodeURIComponent(login)}/repos?sort=pushed&per_page=30&type=owner`, signal);
  if (answer === null || answer.status !== 200 || !Array.isArray(answer.data)) return [];
  return (answer.data as unknown[])
    .map((entry) => (entry !== null && typeof entry === 'object' ? toRepository(entry as Record<string, unknown>) : null))
    .filter((entry): entry is PublicRepository => entry !== null && !entry.archived);
}

export type FileCheck = 'present' | 'missing' | 'unknown';

/** Whether a file is on a public repository's branch. `unknown` for a repository GitHub will not show, and for no answer at all. */
export async function repositoryHasFile(repository: string, path: string, branch: string | undefined, signal?: AbortSignal): Promise<FileCheck> {
  const [owner, name] = repository.split('/');
  const ref = branch === undefined ? '' : `?ref=${encodeURIComponent(branch)}`;
  const answer = await ask(`/repos/${encodeURIComponent(owner ?? '')}/${encodeURIComponent(name ?? '')}/contents/${path.split('/').map(encodeURIComponent).join('/')}${ref}`, signal);
  if (answer === null) return 'unknown';
  if (answer.status === 200) return 'present';
  return answer.status === 404 ? 'missing' : 'unknown';
}
