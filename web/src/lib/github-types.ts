/**
 * What the studio's GitHub routes send and answer (`app/api/github/`), shared
 * by the server and the browser. Nothing here is a credential: the token a
 * person connected stays on the server.
 */

/** A repository the connected account can reach through the GitHub App. */
export interface GitHubRepository {
  /** `owner/name`, in GitHub's capitalisation. */
  repository: string;
  private: boolean;
  defaultBranch: string;
  owner: string;
  /** A person rather than an organisation: a person can start their own runs. */
  ownerIsUser: boolean;
  archived: boolean;
  pushedAt: string | null;
  /** Whether the person may push there. Without it the setup pull request cannot be opened. */
  canPush: boolean;
}

export type GitHubStatus =
  | { connected: false }
  | {
      connected: true;
      login: string;
      /** Everything the app is installed on that this person can reach, most recently pushed first. */
      repositories: GitHubRepository[];
      /** The accounts the app is installed on. None yet means nothing to list. */
      installations: Array<{ account: string; type: 'User' | 'Organization' }>;
      /** True when the list stopped at its cap: there are more than it shows. */
      truncated: boolean;
    };

/** A file the setup pull request adds or replaces. Only Relay's own paths are accepted (see `server/github/setup-pr.ts`). */
export interface SetupFile {
  path: string;
  content: string;
}

export interface SetupPullRequestInput {
  repository: string;
  /** What the pull request is for, in its title: the workflow's name. */
  name: string;
  files: SetupFile[];
  /** The label that starts a run, made in the repository if it is not there yet. */
  label?: string;
  /** The repository secrets the workflow reads, by name, so the pull request can say which to add. */
  secrets?: string[];
}

export type SetupFileStatus = 'added' | 'changed' | 'unchanged';

export type SetupPullRequestResult =
  /** Every file is already on the default branch as it would be written: nothing to open. */
  | { state: 'up-to-date'; defaultBranch: string; files: Array<{ path: string; status: SetupFileStatus }> }
  | {
      state: 'opened' | 'updated';
      number: number;
      url: string;
      branch: string;
      defaultBranch: string;
      files: Array<{ path: string; status: SetupFileStatus }>;
      /** What became of the start label: made now, there already, or not made (the app may not touch issues). */
      label: 'created' | 'exists' | 'skipped' | 'none';
    };

export interface PullRequestState {
  number: number;
  url: string;
  state: 'open' | 'closed' | 'merged';
}
