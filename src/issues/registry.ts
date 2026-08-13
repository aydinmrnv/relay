import type { AuthSupport } from '../auth/delegated.ts';
import { GitHubIssueProvider } from '../github/provider.ts';
import type { IssueProvider } from '../github/types.ts';
import { LocalIssueProvider } from './local.ts';

export interface IssueProviderOptions {
  /** Directory the provider resolves a repository against. */
  cwd: string;
  defaultRepo?: { owner: string; name: string } | null;
}

/** Everything Relay needs to construct one provider and name it on the CLI. */
export interface IssueProviderRegistration {
  /** Name used on the CLI and in onboarding. */
  readonly name: string;
  readonly label: string;
  create(options: IssueProviderOptions): IssueProvider;
}

/**
 * A provider with an account behind it: something to install, something to sign
 * into, and therefore something onboarding and `relay doctor` have to check.
 *
 * The distinction is the whole reason the local provider can exist. Everything
 * that asks "is this usable yet?" asks it of a tracker; nothing asks it of a
 * markdown file.
 */
export interface IssueTrackerRegistration extends IssueProviderRegistration {
  /** Executable the provider drives, used to tell "missing" from "signed out". */
  readonly binary: string;
  /** Printed when that executable is missing. Relay shows it; the user runs it. */
  readonly installCommand: string;
  /** The provider's own auth, delegated exactly like a coding CLI's. */
  readonly auth: AuthSupport;
}

/**
 * The issue trackers Relay knows about — the same seam `AGENT_REGISTRY` provides
 * for coding CLIs, so `relay start` can ask where issues live without naming
 * GitHub.
 *
 * Linear is the obvious second entry and does not exist yet: it needs an
 * `IssueProvider` implementation of its own, which is its own piece of work.
 * When it lands it is one file under `src/issues/` plus one row here — nothing
 * that reads this array needs touching.
 */
export const ISSUE_TRACKER_REGISTRY: readonly IssueTrackerRegistration[] = [
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

/**
 * Every provider, trackers and otherwise.
 *
 * The local one has no binary, no auth and nothing to sign into, which is the
 * point: a great deal of real work has no ticket, and requiring somebody to file
 * one first is a tax on exactly the moment they are deciding whether this tool
 * is worth adopting.
 */
export const ISSUE_PROVIDER_REGISTRY: readonly IssueProviderRegistration[] = [
  ...ISSUE_TRACKER_REGISTRY,
  {
    name: 'local',
    label: 'This machine',
    create: (options) => new LocalIssueProvider({ cwd: options.cwd }),
  },
];

export function issueProviderRegistration(name: string): IssueProviderRegistration | undefined {
  return ISSUE_PROVIDER_REGISTRY.find((entry) => entry.name === name);
}

export function issueTrackerRegistration(name: string): IssueTrackerRegistration | undefined {
  return ISSUE_TRACKER_REGISTRY.find((entry) => entry.name === name);
}

/**
 * The provider a run uses when it was given a tracker reference. Config has no
 * provider setting yet because there is only one tracker to choose from; when
 * there are two, this is the one place that has to start reading it.
 *
 * A run working from a file or a prompt does not come through here at all: it
 * carries its own task, and `relay run` builds the local provider around it.
 */
export function defaultIssueProvider(options: IssueProviderOptions): IssueProvider {
  return ISSUE_TRACKER_REGISTRY[0]!.create(options);
}
