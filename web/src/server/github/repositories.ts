/**
 * What a connected person can reach through the GitHub App: the accounts it
 * is installed on that they belong to, and the repositories of each that
 * they can see. GitHub works this out from their own token, which is why the
 * `installation_id` GitHub adds to the return from installing is never used:
 * anyone can type one into a URL.
 */
import type { GitHubRepository, GitHubStatus } from '@/lib/github-types';
import type { GitHubAppConfig } from '../env';
import { ask, call, refusal, repoPath } from './client';

/** Enough for a picker: past this the list says it stopped, rather than taking a minute to load. */
const MAX_REPOSITORIES = 500;
const PAGE = 100;

interface RawInstallation {
  id?: unknown;
  account?: { login?: unknown; type?: unknown } | null;
}

export function toRepository(raw: Record<string, unknown>): GitHubRepository | null {
  const owner = raw['owner'] as { login?: unknown; type?: unknown } | null | undefined;
  if (typeof raw['full_name'] !== 'string' || owner === null || owner === undefined) return null;
  const permissions = (raw['permissions'] ?? {}) as Record<string, unknown>;
  return {
    repository: raw['full_name'],
    private: raw['private'] === true,
    defaultBranch: typeof raw['default_branch'] === 'string' && raw['default_branch'].length > 0 ? raw['default_branch'] : 'main',
    owner: typeof owner.login === 'string' ? owner.login : raw['full_name'].split('/')[0]!,
    ownerIsUser: owner.type === 'User',
    archived: raw['archived'] === true,
    pushedAt: typeof raw['pushed_at'] === 'string' ? raw['pushed_at'] : null,
    canPush: permissions['push'] === true || permissions['admin'] === true || permissions['maintain'] === true,
  };
}

export async function listReachable(config: GitHubAppConfig, token: string, login: string): Promise<Extract<GitHubStatus, { connected: true }>> {
  const found = await call<{ installations?: RawInstallation[] }>(config, token, 'GET', `/user/installations?per_page=${PAGE}`, 'list where Relay is installed');
  const installations = (found.installations ?? []).filter((entry): entry is RawInstallation & { id: number } => typeof entry.id === 'number');
  const repositories = new Map<string, GitHubRepository>();
  let truncated = false;
  for (const installation of installations) {
    for (let page = 1; ; page += 1) {
      if (repositories.size >= MAX_REPOSITORIES) {
        truncated = true;
        break;
      }
      const answer = await call<{ total_count?: unknown; repositories?: unknown[] }>(config, token, 'GET', `/user/installations/${installation.id}/repositories?per_page=${PAGE}&page=${page}`, 'list the repositories Relay may use');
      const batch = Array.isArray(answer.repositories) ? answer.repositories : [];
      for (const raw of batch) {
        const repository = raw !== null && typeof raw === 'object' ? toRepository(raw as Record<string, unknown>) : null;
        if (repository !== null) repositories.set(repository.repository.toLowerCase(), repository);
      }
      if (batch.length < PAGE) break;
    }
  }
  const list = [...repositories.values()].sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));
  return {
    connected: true,
    login,
    repositories: list.slice(0, MAX_REPOSITORIES),
    installations: installations.map((entry) => ({ account: typeof entry.account?.login === 'string' ? entry.account.login : '', type: entry.account?.type === 'Organization' ? ('Organization' as const) : ('User' as const) })).filter((entry) => entry.account.length > 0),
    truncated: truncated || list.length > MAX_REPOSITORIES,
  };
}

/**
 * One repository, as this person's token sees it. A repository the app is
 * not installed on answers 404 to a user token even when the person owns it:
 * that is the check that the studio only touches what they handed it.
 */
export async function reachableRepository(config: GitHubAppConfig, token: string, repository: string): Promise<GitHubRepository> {
  const answer = await ask(config, token, 'GET', repoPath(repository));
  if (answer.status !== 200 || answer.data === null || typeof answer.data !== 'object') throw refusal(answer, `open ${repository}`);
  const found = toRepository(answer.data as Record<string, unknown>);
  if (found === null) throw refusal({ ...answer, status: 404 }, `open ${repository}`);
  return found;
}

/** Who the token belongs to. */
export async function viewer(config: GitHubAppConfig, token: string): Promise<{ id: number; login: string }> {
  const user = await call<{ id?: unknown; login?: unknown }>(config, token, 'GET', '/user', 'say who is signed in');
  if (typeof user.id !== 'number' || typeof user.login !== 'string') throw refusal({ status: 502, data: null, headers: new Headers() }, 'say who is signed in');
  return { id: user.id, login: user.login };
}
