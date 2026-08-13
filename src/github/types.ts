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
  title: string;
  body: string;
  url: string;
  state: string;
  author: string | null;
  labels: string[];
  repository: { owner: string; name: string } | null;
  comments: IssueComment[];
}

/**
 * The seam Linear (or Jira, or a local file) plugs into later. Nothing above
 * this interface knows that GitHub or the `gh` CLI exist.
 */
export interface IssueProvider {
  readonly name: string;
  /** Accepts whatever the user typed: `142`, `#142`, or a full issue URL. */
  getIssue(ref: string, options?: { signal?: AbortSignal }): Promise<Issue>;
  comment?(
    ref: string,
    body: string,
    options?: { signal?: AbortSignal; marker?: string },
  ): Promise<{ url?: string; created: boolean }>;
  checkAvailability(): Promise<{ available: boolean; detail: string; hint?: string }>;
}

/** Renders an issue as the markdown artifact agents receive and `issue.md` stores. */
export function renderIssueMarkdown(issue: Issue): string {
  const lines: string[] = [];
  lines.push(issue.number === null ? `# ${issue.title}` : `# Issue #${issue.number}: ${issue.title}`);
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
