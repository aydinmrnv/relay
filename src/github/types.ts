export interface IssueComment {
  author: string;
  createdAt: string;
  body: string;
}

export interface Issue {
  /** Stable provider-scoped identifier, e.g. `github:owner/repo#142`. */
  id: string;
  number: number;
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
  checkAvailability(): Promise<{ available: boolean; detail: string; hint?: string }>;
}

/** Renders an issue as the markdown artifact agents receive and `issue.md` stores. */
export function renderIssueMarkdown(issue: Issue): string {
  const lines: string[] = [];
  lines.push(`# Issue #${issue.number}: ${issue.title}`);
  lines.push('');
  lines.push(`- URL: ${issue.url}`);
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
