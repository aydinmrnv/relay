import type { Issue, IssueListFilters, IssueProvider, IssueSummary } from '../github/types.ts';
import type { PromptSession } from '../ui/prompt.ts';
import { RelayError } from '../util/errors.ts';

function age(createdAt: string, now = Date.now()): string {
  const elapsed = Math.max(0, now - Date.parse(createdAt));
  if (!Number.isFinite(elapsed)) return '';
  const days = Math.floor(elapsed / 86_400_000);
  if (days > 0) return `${days}d ago`;
  const hours = Math.floor(elapsed / 3_600_000);
  return hours > 0 ? `${hours}h ago` : 'just now';
}

function row(issue: IssueSummary): string {
  const labels = issue.labels.length === 0 ? '' : `  [${issue.labels.join(', ')}]`;
  return `#${issue.number}  ${issue.title}${labels}  ${age(issue.createdAt)}`.trimEnd();
}

export async function resolvePickedIssue(
  provider: IssueProvider,
  filters: IssueListFilters,
  prompter: PromptSession,
): Promise<string | undefined> {
  if (!prompter.interactive) return undefined;
  const issues = await provider.listIssues(filters);
  if (issues === null || issues.length === 0) {
    return (await prompter.text(issues === null ? 'This provider cannot list issues. Issue number' : 'No matching open issues. Issue number', '')).trim() || undefined;
  }
  if (issues.length === 1) return String(issues[0]!.number);
  return String(await prompter.select('Choose an issue', issues.map((issue) => ({ value: issue.number, label: row(issue) })), 0));
}

export async function confirmClosedIssue(issue: Issue, yes: boolean, prompter: PromptSession): Promise<boolean> {
  if (issue.state !== 'closed' || yes) return true;
  const headline = `Issue #${issue.number ?? issue.id}`;
  if (!prompter.interactive) {
    throw new RelayError(`${headline} is closed. Pass --yes to run a closed issue.`, { code: 'CLOSED_ISSUE_NOT_CONFIRMED' });
  }
  return prompter.confirm(`${headline} is closed. Run it anyway?`, false);
}
