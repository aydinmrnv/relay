'use client';

/**
 * The GitHub account a signed-in person connected, as the studio sees it:
 * who they are on GitHub and the repositories the app reaches. Loaded once
 * per page and shared, so setup and the install steps do not each ask.
 * The token itself never leaves the server.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { toast } from 'sonner';
import { useAccount, useCapabilities } from '@/lib/cloud/account';
import { api } from '@/lib/cloud/sync';
import type { GitHubRepository, GitHubStatus, PullRequestState, SetupPullRequestInput, SetupPullRequestResult } from '@/lib/github-types';
import { sameRepository } from '@/lib/projects';

export interface GitHubState {
  /** `off`: this deployment does not offer it, or nobody is signed in. */
  status: 'off' | 'loading' | 'disconnected' | 'connected' | 'error';
  login: string | null;
  repositories: GitHubRepository[];
  installations: Array<{ account: string; type: 'User' | 'Organization' }>;
  truncated: boolean;
  error: string | null;
}

const EMPTY: GitHubState = { status: 'off', login: null, repositories: [], installations: [], truncated: false, error: null };

export const useGitHubStore = create<GitHubState>()(() => EMPTY);

let loading: Promise<void> | null = null;

/** Asks the server again: after connecting, installing, or when somebody says the list is wrong. */
export function refreshGitHub(): Promise<void> {
  loading ??= (async () => {
    if (useGitHubStore.getState().status !== 'connected') useGitHubStore.setState({ status: 'loading', error: null });
    try {
      const answer = await api<GitHubStatus>('/api/github');
      useGitHubStore.setState(answer.connected ? { status: 'connected', login: answer.login, repositories: answer.repositories, installations: answer.installations, truncated: answer.truncated, error: null } : { ...EMPTY, status: 'disconnected' });
    } catch (error) {
      useGitHubStore.setState({ status: 'error', error: error instanceof Error ? error.message : 'GitHub could not be asked.' });
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** What `?github=` on the way back from github.com means, said once. */
const OUTCOMES: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: 'GitHub is connected' },
  installed: { ok: true, text: 'Your repositories are updated' },
  denied: { ok: false, text: 'GitHub was not connected: the request was cancelled on GitHub.' },
  expired: { ok: false, text: 'That GitHub sign-in had expired or was started elsewhere. Try again.' },
  error: { ok: false, text: 'GitHub could not be connected. Try again in a minute.' },
  unavailable: { ok: false, text: 'Connecting GitHub is not switched on for this studio.' },
  'slow-down': { ok: false, text: 'Too many attempts. Wait a few minutes, then try again.' },
};

function readOutcome(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const outcome = url.searchParams.get('github');
  if (outcome === null) return;
  url.searchParams.delete('github');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  const said = OUTCOMES[outcome];
  if (said === undefined) return;
  if (said.ok) toast.success(said.text);
  else toast.error(said.text);
}

/** The connected account, loaded the first time anything on the page asks. `off` where it is not offered. */
export function useGitHub(): GitHubState {
  const offered = useCapabilities().github === true;
  const signedIn = useAccount((state) => state.status === 'signed-in');
  const state = useGitHubStore();
  useEffect(() => {
    if (!offered || !signedIn) return;
    readOutcome();
    if (useGitHubStore.getState().status === 'off') void refreshGitHub();
  }, [offered, signedIn]);
  return offered && signedIn ? state : EMPTY;
}

/** The repository as the connected account reaches it, or `undefined`. */
export function reachableRepository(state: GitHubState, repository: string | null | undefined): GitHubRepository | undefined {
  return state.status === 'connected' ? state.repositories.find((entry) => sameRepository(entry.repository, repository)) : undefined;
}

/** Signing in to the app, then back to `next` on this site. A navigation, not a fetch. */
export function connectGitHubHref(next: string): string {
  return `/api/github/connect?next=${encodeURIComponent(next)}`;
}

/** Installing the app, or choosing more repositories for it, then back to `next`. */
export function installGitHubHref(next: string): string {
  return `/api/github/install?next=${encodeURIComponent(next)}`;
}

/** Where the browser is now, to come back to. */
export function hereHref(): string {
  return typeof window === 'undefined' ? '/projects' : `${window.location.pathname}${window.location.search}`;
}

export async function disconnectGitHub(): Promise<void> {
  await api('/api/github', { method: 'DELETE' });
  useGitHubStore.setState({ ...EMPTY, status: 'disconnected' });
}

export function openSetupPullRequest(input: SetupPullRequestInput): Promise<SetupPullRequestResult> {
  return api<SetupPullRequestResult>('/api/github/pulls', { method: 'POST', body: input });
}

export function readPullRequest(repository: string, number: number): Promise<PullRequestState> {
  return api<PullRequestState>(`/api/github/pulls?repository=${encodeURIComponent(repository)}&number=${number}`);
}

/**
 * The setup pull request last opened for a workflow, kept in this browser so
 * the install steps can show it and ask whether it was merged. Only its
 * number and link: nothing that would matter to anyone who read it.
 */
export interface SavedPullRequest {
  repository: string;
  number: number;
  url: string;
  /** How the agents signed in when it was opened: the workflow file is written for one way. */
  signIn: string;
}

const pullKey = (workflowId: string) => `relay:setup-pr:${workflowId}`;

export function readSavedPullRequest(workflowId: string): SavedPullRequest | null {
  try {
    const raw = window.localStorage.getItem(pullKey(workflowId));
    const parsed = raw === null ? null : (JSON.parse(raw) as Partial<SavedPullRequest>);
    return parsed !== null && typeof parsed.number === 'number' && typeof parsed.url === 'string' && typeof parsed.repository === 'string' ? { repository: parsed.repository, number: parsed.number, url: parsed.url, signIn: typeof parsed.signIn === 'string' ? parsed.signIn : '' } : null;
  } catch {
    return null;
  }
}

export function savePullRequest(workflowId: string, pull: SavedPullRequest | null): void {
  try {
    if (pull === null) window.localStorage.removeItem(pullKey(workflowId));
    else window.localStorage.setItem(pullKey(workflowId), JSON.stringify(pull));
  } catch {
    // No storage: the pull request is still on GitHub, and opening it again finds it.
  }
}
