import { slugify } from '../util/text.ts';

/**
 * What a run's branch and worktree are named after.
 *
 * A tracker that numbers its issues contributes the number, which is what every
 * Relay branch has been named after so far — `relay/142-x7f2q3` is unchanged and
 * stays unchanged. A tracker that numbers nothing contributes a slug of the
 * title instead: `relay/fix-flaky-timeout-x7f2q3`. Nothing downstream can tell
 * the two apart, which is the point — a local spec file, a `--prompt` and
 * Linear's `ENG-142` all need the same thing from this.
 */
export type IssueIdentity = number | string;

/** The narrow view of an issue that naming and display need. */
export interface NamedIssue {
  /** The tracker's own number, or null for a tracker that does not number issues. */
  number: number | null;
  title: string;
}

/**
 * The identity a branch and a worktree are built from.
 *
 * Collision-safety is not this function's job and never was: two runs on the
 * same issue — or the same spec file — differ by the run's short id, which every
 * caller appends. What this guarantees is only that the part derived from the
 * issue is stable, safe, and the same for the same issue.
 */
export function issueIdentity(issue: NamedIssue): IssueIdentity {
  return issue.number ?? slugify(issue.title, 'issue');
}

/**
 * How a run names its issue in output: `#142 Title` for a tracker that numbers
 * its issues, and the title alone for one that does not. A `#null` in a terminal
 * is worse than no number at all.
 */
export function issueHeadline(issue: NamedIssue): string {
  return issue.number === null ? issue.title : `#${issue.number} ${issue.title}`;
}

/**
 * What a person would call the change this issue produced — the subject line of
 * a commit, the title of a pull request. A trailing number is a cross-reference,
 * so it is there when there is something to reference and absent, rather than
 * `(#null)`, when there is not.
 */
export function issueTitle(issue: NamedIssue): string {
  return issue.number === null ? issue.title : `${issue.title} (#${issue.number})`;
}
