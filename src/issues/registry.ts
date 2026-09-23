import type { AuthSupport } from '../auth/delegated.ts';
import { GitHubIssueProvider, parseIssueRef } from '../github/provider.ts';
import type { Issue, IssueListFilters, IssueProvider, IssueSummary } from '../github/types.ts';
import type { IssueTrackerName, RelayConfig } from '../storage/config.ts';
import { LINEAR_KEY_PAGE, LINEAR_KEY_VARIABLE, LinearIssueProvider, parseLinearRef } from './linear.ts';
import { LocalIssueProvider } from './local.ts';

export interface IssueProviderOptions {
  /** Directory the provider resolves a repository against. */
  cwd: string;
  defaultRepo?: { owner: string; name: string } | null;
  /** The repository's `issues` config: which tracker a bare number means. */
  issues?: Partial<RelayConfig['issues']> | undefined;
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
  readonly name: IssueTrackerName;
  /**
   * Executable the provider drives, used to tell "missing" from "signed out".
   * Absent for a tracker Relay talks to over HTTP, where there is nothing to
   * install.
   */
  readonly binary?: string;
  /** Printed when that executable is missing. Relay shows it; the user runs it. */
  readonly installCommand?: string;
  /** The provider's own auth, delegated exactly like a coding CLI's. */
  readonly auth?: AuthSupport;
  /**
   * For a tracker with no CLI to sign into: the environment variable its key
   * is read from and the page that issues one. Relay names both and prompts
   * for neither.
   */
  readonly credential?: { variable: string; page: string };
  /**
   * Whether this tracker understands `ref` without a default team or repo to
   * lean on — `ENG-142` is Linear's on sight, `142` is nobody's in particular.
   */
  readonly claimsRef: (ref: string) => boolean;
}

/**
 * The issue trackers Relay knows about — the same seam `AGENT_REGISTRY` provides
 * for coding CLIs, so `relay start` can ask where issues live without naming
 * GitHub.
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
    claimsRef: (ref) => {
      // A bare number is claimed too: it has meant a GitHub issue since the
      // first release, and the router asks Linear first only when config says so.
      try {
        parseIssueRef(ref);
        return true;
      } catch {
        return false;
      }
    },
    create: (options) =>
      new GitHubIssueProvider({
        cwd: options.cwd,
        defaultRepo: options.defaultRepo ?? null,
      }),
  },
  {
    name: 'linear',
    label: 'Linear',
    credential: { variable: LINEAR_KEY_VARIABLE, page: LINEAR_KEY_PAGE },
    claimsRef: (ref) => parseLinearRef(ref) !== null,
    create: (options) => new LinearIssueProvider({ team: options.issues?.team ?? null }),
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
 * Whether any tracker would understand `ref`, without making one throw to find
 * out. The command layer asks this rather than parsing references itself, so a
 * new tracker's syntax is recognised everywhere the moment its row exists.
 */
export function isTrackerRef(ref: string): boolean {
  return ISSUE_TRACKER_REGISTRY.some((entry) => entry.claimsRef(ref));
}

/**
 * The provider a run uses when it was given a tracker reference: every tracker
 * at once, each reference routed to the one that owns it.
 *
 * `ENG-142` and a linear.app URL go to Linear, `owner/repo#142` and a GitHub URL
 * to GitHub, and a bare `142` to whichever `issues.provider` names — GitHub
 * unless the repository said otherwise. With `issues.provider: github`, nothing
 * about existing behaviour changes.
 */
export function defaultIssueProvider(options: IssueProviderOptions): IssueProvider {
  return new RoutingIssueProvider(options);
}

export class RoutingIssueProvider implements IssueProvider {
  readonly name: string;
  private readonly primaryName: IssueTrackerName;
  private readonly built = new Map<IssueTrackerName, IssueProvider>();
  private readonly options: IssueProviderOptions;

  constructor(options: IssueProviderOptions) {
    this.options = options;
    this.primaryName = options.issues?.provider ?? 'github';
    this.name = this.primaryName;
  }

  /** The tracker a bare reference, a listing and `relay doctor` mean. */
  get primary(): IssueProvider {
    return this.provider(this.primaryName);
  }

  provider(name: IssueTrackerName): IssueProvider {
    let provider = this.built.get(name);
    if (provider === undefined) {
      provider = issueTrackerRegistration(name)!.create(this.options);
      this.built.set(name, provider);
    }
    return provider;
  }

  /** Which tracker owns this reference. */
  route(ref: string): IssueTrackerName {
    const team = this.options.issues?.team ?? null;
    if (parseLinearRef(ref) !== null) return 'linear';
    if (this.primaryName === 'linear' && parseLinearRef(ref, { team }) !== null) return 'linear';
    return 'github';
  }

  getIssue(ref: string, options?: { signal?: AbortSignal }): Promise<Issue> {
    return this.provider(this.route(ref)).getIssue(ref, options);
  }

  listIssues(filters: IssueListFilters, options?: { signal?: AbortSignal }): Promise<IssueSummary[] | null> {
    return this.primary.listIssues(filters, options);
  }

  async comment(
    ref: string,
    body: string,
    options?: { signal?: AbortSignal; marker?: string },
  ): Promise<{ url?: string; created: boolean }> {
    const target = this.provider(this.route(ref));
    if (target.comment === undefined) throw new Error(`${target.name} cannot comment on issues`);
    return target.comment(ref, body, options);
  }

  async removeLabel(ref: string, label: string, options?: { signal?: AbortSignal }): Promise<boolean> {
    const target = this.provider(this.route(ref));
    if (target.removeLabel === undefined) throw new Error(`${target.name} cannot remove labels`);
    return target.removeLabel(ref, label, options);
  }

  /** A tracker with no record of who labelled what answers null — which unattended mode treats as a refusal. */
  async labelActor(ref: string, label: string, options?: { signal?: AbortSignal }): Promise<string | null> {
    const target = this.provider(this.route(ref));
    return target.labelActor === undefined ? null : target.labelActor(ref, label, options);
  }

  async teamMembership(login: string, teams: readonly string[], options?: { signal?: AbortSignal }): Promise<string | null> {
    const target = this.primary;
    return target.teamMembership === undefined ? null : target.teamMembership(login, teams, options);
  }

  checkAvailability(): Promise<{ available: boolean; detail: string; hint?: string }> {
    return this.primary.checkAvailability();
  }
}
