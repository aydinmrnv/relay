export interface IssueComment {
  author: string;
  createdAt: string;
  body: string;
}

export interface Issue {
  /** Stable provider-scoped identifier, e.g. `github:owner/repo#142`, `local:fix-flaky-timeout`. */
  id: string;
  /**
   * The tracker's own number, or null when the tracker has none to give. A file
   * on disk and a `--prompt` have no number; neither will Linear's `ENG-142`.
   * Everything downstream reads identity from `id` and naming from the title.
   */
  number: number | null;
  /**
   * The tracker's own human key when it has one that is not a number —
   * Linear's `ENG-142`. Branch names, pull-request titles and the closing
   * line use it, which is what lets the tracker link the work back by itself.
   */
  key?: string;
  title: string;
  body: string;
  url: string;
  state: string;
  author: string | null;
  labels: string[];
  repository: { owner: string; name: string } | null;
  comments: IssueComment[];
}

export interface IssueListFilters {
  labels?: string[];
  assignee?: string;
  mine?: boolean;
  limit?: number;
}

export interface IssueSummary {
  number: number;
  /** What to pass back to `getIssue` when it is not the number: `ENG-142`. */
  ref?: string;
  title: string;
  labels: string[];
  createdAt: string;
  url: string;
  author: string | null;
  state: string;
}

/**
 * The seam Linear (or Jira, or a local file) plugs into later. Nothing above
 * this interface knows that GitHub or the `gh` CLI exist.
 */
export interface IssueProvider {
  readonly name: string;
  /** Accepts whatever the user typed: `142`, `#142`, or a full issue URL. */
  getIssue(ref: string, options?: { signal?: AbortSignal }): Promise<Issue>;
  listIssues(filters: IssueListFilters, options?: { signal?: AbortSignal }): Promise<IssueSummary[] | null>;
  comment?(
    ref: string,
    body: string,
    options?: { signal?: AbortSignal; marker?: string },
  ): Promise<{ url?: string; created: boolean }>;
  /**
   * Takes a label off an issue. `relay serve` calls this *before* it starts the
   * run it decided to start, so a server that dies between the two restarts
   * into a repository that no longer asks for the work twice.
   *
   * Returns false when the label was not there to remove, which is how two
   * servers racing for the same issue tell the loser from the winner.
   */
  removeLabel?(ref: string, label: string, options?: { signal?: AbortSignal }): Promise<boolean>;
  /**
   * Who last put this label on, or null when the tracker keeps no such record.
   *
   * This is the authorisation question for everything unattended: the person
   * who applied the label is the person who spent the money, and a tracker that
   * cannot say who that was is a tracker Relay refuses to act on.
   */
  labelActor?(ref: string, label: string, options?: { signal?: AbortSignal }): Promise<string | null>;
  /**
   * The first of these `org/team` slugs the login belongs to, or null for none.
   * Absent on trackers with no notion of a team, which is not an error — an
   * allowlist that names teams simply matches nobody there.
   */
  teamMembership?(
    login: string,
    teams: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<string | null>;
  checkAvailability(): Promise<{ available: boolean; detail: string; hint?: string }>;
}

/** Renders an issue as the markdown artifact agents receive and `issue.md` stores. */
export function renderIssueMarkdown(issue: Issue): string {
  const lines: string[] = [];
  lines.push(issue.number !== null ? `# Issue #${issue.number}: ${issue.title}` : issue.key !== undefined ? `# ${issue.key}: ${issue.title}` : `# ${issue.title}`);
  lines.push('');
  // A task written on this machine has no URL to print, and a blank one reads
  // like a fetch that half-failed.
  if (issue.url.length > 0) lines.push(`- URL: ${issue.url}`);
  lines.push(`- State: ${issue.state}`);
  if (issue.author !== null) lines.push(`- Author: ${issue.author}`);
  if (issue.labels.length > 0) lines.push(`- Labels: ${issue.labels.join(', ')}`);
  if (issue.repository !== null) lines.push(`- Repository: ${issue.repository.owner}/${issue.repository.name}`);
  lines.push('');
  lines.push('## Description');
  lines.push('');
  lines.push(issue.body.trim().length > 0 ? issue.body.trim() : '_No description provided._');

  if (issue.comments.length > 0) {
    lines.push('');
    lines.push(`## Comments (${issue.comments.length})`);
    for (const comment of issue.comments) {
      lines.push('');
      lines.push(`### ${comment.author} — ${comment.createdAt}`);
      lines.push('');
      lines.push(comment.body.trim());
    }
  }

  return `${lines.join('\n')}\n`;
}
