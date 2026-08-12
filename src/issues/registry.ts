import type { AuthSupport } from '../auth/delegated.ts';
import { GitHubIssueProvider } from '../github/provider.ts';
import type { IssueProvider } from '../github/types.ts';

export interface IssueProviderOptions {
  /** Directory the provider resolves a repository against. */
  cwd: string;
  defaultRepo?: { owner: string; name: string } | null;
}

export interface IssueProviderRegistration {
  /** Name used on the CLI and in onboarding. */
  readonly name: string;
  readonly label: string;
  /** Executable the provider drives, used to tell "missing" from "signed out". */
  readonly binary: string;
  /** Printed when that executable is missing. Relay shows it; the user runs it. */
  readonly installCommand: string;
  /** The provider's own auth, delegated exactly like a coding CLI's. */
  readonly auth: AuthSupport;
  create(options: IssueProviderOptions): IssueProvider;
}

/**
 * The single list of issue trackers Relay knows about — the same seam
 * `AGENT_REGISTRY` provides for coding CLIs, so `relay start` can ask where
 * issues live without naming GitHub.
 *
 * Linear is the obvious second entry and does not exist yet: it needs an
 * `IssueProvider` implementation of its own, which is its own piece of work.
 * When it lands it is one file under `src/issues/` plus one row here — nothing
 * that reads this array needs touching.
 */
export const ISSUE_PROVIDER_REGISTRY: readonly IssueProviderRegistration[] = [
  {
    name: 'github',
    label: 'GitHub',
    binary: 'gh',
    installCommand: 'brew install gh   # or see https://cli.github.com',
    auth: {
      status: { command: 'gh', args: ['auth', 'status'] },
      login: { command: 'gh', args: ['auth', 'login'] },
    },
    create: (options) =>
      new GitHubIssueProvider({
        cwd: options.cwd,
        defaultRepo: options.defaultRepo ?? null,
      }),
  },
];

export function issueProviderRegistration(name: string): IssueProviderRegistration | undefined {
  return ISSUE_PROVIDER_REGISTRY.find((entry) => entry.name === name);
}

/**
 * The provider a run uses today. Config has no provider setting yet because
 * there is only one to choose from; when there are two, this is the one place
 * that has to start reading it.
 */
export function defaultIssueProvider(options: IssueProviderOptions): IssueProvider {
  return ISSUE_PROVIDER_REGISTRY[0]!.create(options);
}
