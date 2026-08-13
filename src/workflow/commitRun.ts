import { harnessRegistration } from '../agents/index.ts';
import { commitWorktree, type CoAuthor } from '../git/commit.ts';
import { ROLES } from '../storage/config.ts';
import type { RunStore } from '../storage/runs.ts';
import { errorMessage } from '../util/errors.ts';
import { formatDuration } from '../util/text.ts';
import { typoize } from '../util/typos.ts';
import { issueTitle } from '../issues/identity.ts';
import type { RunObserver } from './observer.ts';
import type { RunState } from './state.ts';

export interface CommitRunContext {
  state: RunState;
  store: RunStore;
  observer: RunObserver;
  signal?: AbortSignal;
}

/**
 * Captures a completed run's work in a local commit on its own branch.
 *
 * Relay otherwise leaves a staged index behind, which any `git worktree prune`
 * or stray `git reset` discards silently. Committing publishes nothing — the
 * branch is local, unpushed and not merged into anything — but it makes the
 * work survivable, which the guarantee about shared state never covered.
 *
 * A failure to commit never fails the run: the diff is still in the worktree,
 * which is exactly where it would have been anyway.
 */
export async function commitRunWork(context: CommitRunContext): Promise<boolean> {
  const { state, store, observer } = context;
  const workspace = state.workspace;
  if (workspace === undefined) return false;

  const subject = commitSubject(state);
  try {
    const result = await commitWorktree(workspace.path, {
      subject,
      body: commitBody(state),
      coAuthors: contributingAgents(state),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });

    if (result === undefined) {
      observer.note('Nothing to commit: the run changed no files.');
      return false;
    }

    state.commit = { sha: result.sha, branch: workspace.branch, subject, at: result.at };
    observer.note(`Committed ${result.sha.slice(0, 8)} on ${workspace.branch} (local only — nothing was pushed).`);
    await store.logEvent({
      timestamp: result.at,
      runId: state.runId,
      phase: state.phase,
      agent: null,
      type: 'committed',
      message: subject,
      data: { sha: result.sha, branch: workspace.branch },
    });
    return true;
  } catch (error) {
    observer.warn(`Could not commit the run's work: ${errorMessage(error)}`);
    observer.note(`The changes are still staged in ${workspace.path}.`);
    return false;
  }
}

function commitSubject(state: RunState): string {
  const issue = state.issue;
  const subject = issue === undefined ? `Relay: work for issue ${state.issueRef}` : issueTitle(issue);
  return humanWriting(state, subject);
}

/**
 * `--tuff`: the message this run leaves in git history, mistyped the way its
 * author would have. Seeded on the run id so the same run always writes the
 * same message — a commit and the pull request that quotes it must match.
 */
function humanWriting(state: RunState, text: string): string {
  return state.config.workflow.typos ? typoize(text, { seed: state.runId }) : text;
}

/** The body records the run's evidence, not the agent's description of its code. */
function commitBody(state: RunState): string[] {
  const lines = [
    `Implemented by Relay run ${state.runId}.`,
    `Plan review: ${state.rounds.planReview} round(s), plan ${state.planApproved ? 'approved' : 'not approved'}.`,
    `Code review: ${state.rounds.codeReview} round(s).`,
  ];

  const tests = state.tests;
  if (tests !== undefined) {
    lines.push(
      tests.discovered
        ? `Tests: \`${tests.command.join(' ')}\` ${tests.passed ? 'passed' : `FAILED (exit ${String(tests.exitCode)})`}` +
            ` in ${formatDuration(tests.durationMs)}.`
        : `Tests: not run (${tests.skippedReason ?? tests.reason}).`,
    );
  }
  if (state.issue !== undefined && state.issue.url.length > 0) lines.push(`Issue: ${state.issue.url}`);

  return [humanWriting(state, lines.join('\n'))];
}

/** One trailer per agent that actually took a turn, in role order. */
export function contributingAgents(state: RunState): CoAuthor[] {
  const authors = new Map<string, CoAuthor>();
  for (const role of ROLES) {
    const binding = state.agents[role];
    if (binding?.sessionId === undefined) continue;
    const registration = harnessRegistration(binding.provider);
    if (registration === undefined || authors.has(registration.name)) continue;
    authors.set(registration.name, { ...registration.coAuthor });
  }
  return [...authors.values()];
}
