import { mergeBranch, pushBranch } from '../git/publish.ts';
import { createPullRequest, mergePullRequest } from '../github/pullRequest.ts';
import { draftReasons } from './delivery.ts';
import { reviewsCode } from '../storage/config.ts';
import { RUN_FILES, type RunStore } from '../storage/runs.ts';
import { formatDuration } from '../util/text.ts';
import { typoize } from '../util/typos.ts';
import { RelayError } from '../util/errors.ts';
import { commitRunWork } from './commitRun.ts';
import type { RunObserver } from './observer.ts';
import { renderSummary } from './summary.ts';
import type { MergeRecord, PullRequestRecord, PushRecord, RunState } from './state.ts';

export interface PublishContext {
  state: RunState;
  store: RunStore;
  observer: RunObserver;
  signal?: AbortSignal;
}

/**
 * The three things Relay can do with a finished run beyond committing it, each
 * one recorded in the run's own state as it happens.
 *
 * These are the only writes Relay makes outside a run's throwaway worktree, and
 * every one of them is reached from a question the user answered. Failure is
 * not swallowed here: an unauthenticated `gh` or a conflicted merge is
 * something the caller has to be able to say out loud, with the hint attached.
 */

/**
 * Commits the run's work and writes that down.
 *
 * The engine can call `commitRunWork` directly because it persists state and
 * rewrites the summary immediately afterwards anyway. A commit made mid-delivery
 * has no such moment, and a commit nobody recorded is one `relay status` keeps
 * calling unlanded — while the steps after it act as though it happened.
 */
export async function commitAndRecord(context: PublishContext): Promise<boolean> {
  const committed = await commitRunWork(context);
  if (!committed) return false;
  await persist(context);
  return true;
}

/** Pushes the run branch and records where it landed. */
export async function pushRunBranch(context: PublishContext): Promise<PushRecord> {
  const { state } = context;
  const workspace = requireWorkspace(state, 'push');

  const result = await pushBranch(state.repository.root, workspace.branch, {
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });

  const record: PushRecord = { ...result, at: new Date().toISOString() };
  state.push = record;

  context.observer.note(`Pushed ${record.branch} to ${record.remote}.`);
  await recordStep(context, 'pushed', `${record.branch} → ${record.remote}`, {
    remote: record.remote,
    branch: record.branch,
    sha: record.sha,
  });
  return record;
}

/** Opens a pull request for the run branch, or reports the one already open. */
export async function openRunPullRequest(context: PublishContext): Promise<PullRequestRecord> {
  const { state } = context;
  const workspace = requireWorkspace(state, 'open a pull request for');

  const plan = await context.store.readArtifact(RUN_FILES.plan);
  const result = await createPullRequest(pullRequestDraft(state, plan), {
    cwd: state.repository.root,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });

  const record: PullRequestRecord = {
    url: result.url,
    number: result.number,
    base: workspace.baseBranch,
    head: workspace.branch,
    createdByRun: result.created,
    at: new Date().toISOString(),
  };
  state.pullRequest = record;

  context.observer.note(result.created ? `Opened ${record.url}` : `A pull request is already open: ${record.url}`);
  await recordStep(context, 'pull_request', record.url, { url: record.url, base: record.base, head: record.head });
  return record;
}

/**
 * Lands the work on the base branch.
 *
 * Where that happens depends on where the work already is. A run that opened a
 * pull request merges it on GitHub, because merging the same change again
 * locally would leave a pull request open against commits that are already in
 * the base branch. A run that never left this machine merges here instead —
 * and only into a clean checkout that is already on the base branch.
 */
export async function mergeRunBranch(context: PublishContext): Promise<MergeRecord> {
  const { state } = context;
  const workspace = requireWorkspace(state, 'merge');
  const at = new Date().toISOString();
  const pullRequest = state.pullRequest;

  if (pullRequest !== undefined) {
    if (pullRequest.createdByRun !== true) {
      throw new RelayError('Relay refuses to merge a pull request this run did not create.', { code: 'MERGE_BLOCKED' });
    }
    const method = state.config.github.mergeMethod;
    const merged = await mergePullRequest(pullRequest.url, method, {
      cwd: state.repository.root,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });

    const record: MergeRecord = { into: pullRequest.base, via: 'pull-request', url: merged.url, at };
    state.merge = record;

    context.observer.note(`Merged ${merged.url} into ${record.into} (${method}).`);
    await recordStep(context, 'merged', `${merged.url} → ${record.into}`, {
      into: record.into,
      via: record.via,
      method,
      url: merged.url,
    });
    return record;
  }

  const result = await mergeBranch(state.repository.root, {
    branch: workspace.branch,
    into: workspace.baseBranch,
    message: mergeMessage(state),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });

  const record: MergeRecord = {
    into: result.into,
    via: 'local',
    sha: result.sha,
    fastForward: result.fastForward,
    at,
  };
  state.merge = record;

  context.observer.note(
    `Merged ${workspace.branch} into ${record.into} at ${result.sha.slice(0, 8)}` +
      `${result.fastForward ? ' (fast-forward)' : ''}.`,
  );
  await recordStep(context, 'merged', `${workspace.branch} → ${record.into}`, {
    into: record.into,
    via: record.via,
    sha: result.sha,
    fastForward: result.fastForward,
  });
  return record;
}

/**
 * The pull request Relay opens: the run's own evidence, not the implementer's
 * account of its work. Everything in the body is read from state, so it says
 * what happened rather than what an agent said happened.
 *
 * A run whose tests failed, whose plan was never approved, or that still
 * carries blocking findings nobody answered opens as a **draft**, with those
 * reasons at the top. Delivery is automatic; looking ready to merge is not.
 */
export function pullRequestDraft(state: RunState, approvedPlan?: string): {
  title: string;
  body: string;
  base: string;
  head: string;
  repo?: string;
  draft?: boolean;
} {
  const workspace = requireWorkspace(state, 'open a pull request for');
  const issue = state.issue;
  const drafting = draftReasons(state);

  const lines = [
    issue === undefined
      ? `Work for issue ${state.issueRef}, implemented by Relay run \`${state.runId}\`.`
      : `Implemented by Relay run \`${state.runId}\`.`,
    '',
    ...(drafting.length === 0
      ? []
      : [`> **Opened as a draft:** ${drafting.join('; ')}.`, '']),
    `- Plan review: ${state.rounds.planReview} round(s), plan ${state.planApproved ? 'approved' : 'not approved'}`,
    reviewsCode(state.config)
      ? `- Code review: ${state.rounds.codeReview} round(s) by ${state.config.agents.codeReviewer}`
      : '- Code review: **none** — no second model read this diff',
    `- Implemented by: ${state.config.agents.implementer}`,
  ];

  if (state.diff !== undefined) {
    lines.push(`- Changes: ${state.diff.fileCount} file(s), +${state.diff.additions} −${state.diff.deletions}`);
    lines.push('', '### Diff stat', '', '```text', ...state.diff.files, '```');
  }

  if (approvedPlan !== undefined && approvedPlan.trim().length > 0) {
    const cap = 12_000;
    const plan = approvedPlan.length > cap ? `${approvedPlan.slice(0, cap)}\n\n… plan truncated …` : approvedPlan;
    lines.push('', '### Approved plan', '', '<details><summary>Show plan</summary>', '', plan.trim(), '', '</details>');
  }

  const codeReviews = state.reviews.filter((review) => review.kind === 'code' && review.findings.length > 0);
  lines.push('', '### Review findings & resolutions', '');
  if (codeReviews.length === 0) lines.push('No code-review findings.');
  for (const review of codeReviews) {
    for (const finding of review.findings) {
      const response = review.responses?.find((item) => item.findingId === finding.id);
      lines.push(`- **${finding.id} (${finding.severity})** ${finding.summary}`);
      lines.push(`  - Resolution: ${response?.response ?? 'UNRESOLVED'}${response?.reasoning ? ` — ${response.reasoning}` : ''}`);
    }
  }

  const tests = state.tests;
  if (tests !== undefined) {
    lines.push(
      tests.discovered
        ? `- Tests: \`${tests.command.join(' ')}\` ${tests.passed ? 'passed' : `FAILED (exit ${String(tests.exitCode)})`}` +
            ` in ${formatDuration(tests.durationMs)}`
        : `- Tests: not run (${tests.skippedReason ?? tests.reason})`,
    );
  }

  if (issue !== undefined) {
    lines.push('', `Closes #${issue.number}`);
  }

  const repo =
    state.repository.owner !== null && state.repository.name !== null
      ? `${state.repository.owner}/${state.repository.name}`
      : undefined;

  // `--tuff`: seeded on the run id, so re-running delivery for the same run
  // produces the same pull request rather than a differently-mistyped one.
  const write = (text: string): string =>
    state.config.workflow.typos ? typoize(text, { seed: state.runId }) : text;

  return {
    title: write(
      issue === undefined ? `Relay: work for issue ${state.issueRef}` : `${issue.title} (#${issue.number})`,
    ),
    body: `${write(lines.join('\n'))}\n`,
    base: workspace.baseBranch,
    head: workspace.branch,
    ...(repo === undefined ? {} : { repo }),
    ...(drafting.length === 0 ? {} : { draft: true }),
  };
}

function mergeMessage(state: RunState): string {
  const branch = state.workspace?.branch ?? 'the run branch';
  const subject =
    state.issue === undefined
      ? `Merge ${branch} (Relay run ${state.runId})`
      : `Merge ${branch}: ${state.issue.title} (#${state.issue.number})`;
  const message = `${subject}\n\nImplemented by Relay run ${state.runId}.\n`;
  return state.config.workflow.typos ? typoize(message, { seed: state.runId }) : message;
}

function requireWorkspace(state: RunState, action: string): NonNullable<RunState['workspace']> {
  const workspace = state.workspace;
  if (workspace === undefined) {
    throw new RelayError(`Run ${state.runId} never created a branch, so there is nothing to ${action}.`, {
      code: 'NO_WORKSPACE',
    });
  }
  return workspace;
}

/**
 * Persists what just happened. State and `summary.md` move together: the
 * summary is the run's record, and a record that omits a push is worse than no
 * record at all.
 */
async function recordStep(
  context: PublishContext,
  type: string,
  message: string,
  data: Record<string, unknown>,
): Promise<void> {
  const { state, store } = context;
  await store.logEvent({
    timestamp: new Date().toISOString(),
    runId: state.runId,
    phase: state.phase,
    agent: null,
    type,
    message,
    data,
  });
  await persist(context);
}

async function persist({ state, store }: PublishContext): Promise<void> {
  await store.writeArtifact(RUN_FILES.summary, renderSummary(state));
  await store.saveState(state);
}
