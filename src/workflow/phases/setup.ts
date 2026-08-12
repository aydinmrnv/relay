import { RelayError } from '../../util/errors.ts';
import { renderIssueMarkdown } from '../../github/types.ts';
import { createWorktree, worktreeExists } from '../../git/worktree.ts';
import { discoverRepository } from '../../git/repository.ts';
import { RUN_FILES } from '../../storage/runs.ts';
import type { EngineContext, PhaseResult } from '../context.ts';

/** Resolves roles to installed harnesses before anything expensive happens. */
export async function initializing(context: EngineContext): Promise<PhaseResult> {
  const { state, harnesses, observer } = context;

  const roles = ['planner', 'planReviewer', 'implementer', 'codeReviewer'] as const;
  const needed = new Set(roles.map((role) => state.config.agents[role]));

  for (const provider of needed) {
    const harness = harnesses[provider];
    if (harness === undefined) {
      throw new RelayError(`No harness is registered for agent "${provider}".`, { code: 'UNKNOWN_AGENT' });
    }
    const availability = await harness.checkAvailability();
    if (!availability.available) {
      throw new RelayError(`${provider} is not available: ${availability.detail}`, {
        code: 'AGENT_UNAVAILABLE',
        ...(availability.hint === undefined ? {} : { hint: availability.hint }),
      });
    }
    observer.note(`${provider} ${availability.detail}`);
  }

  const assignments = roles.map((role) => `${role}=${state.config.agents[role]}`).join('  ');
  return { next: 'FETCHING_ISSUE', note: assignments };
}

export async function fetchingIssue(context: EngineContext): Promise<PhaseResult> {
  const { state, store, issueProvider, signal } = context;

  const issue = await issueProvider.getIssue(state.issueRef, { signal });
  const markdown = renderIssueMarkdown(issue);

  await store.writeArtifact(RUN_FILES.issue, markdown);
  context.issueMarkdown = markdown;

  state.issue = { number: issue.number, title: issue.title, url: issue.url, state: issue.state };
  if (issue.repository !== null) {
    state.repository.owner ??= issue.repository.owner;
    state.repository.name ??= issue.repository.name;
  }

  if (issue.state === 'closed') {
    context.observer.warn(`Issue #${issue.number} is closed. Continuing anyway.`);
  }

  return { next: 'CREATING_WORKSPACE', note: `#${issue.number} ${issue.title}` };
}

/**
 * Creates the run's isolated worktree. The user's checkout is only read: their
 * branch, index and files are never touched, which is why a dirty working tree
 * is a warning rather than an error.
 */
export async function creatingWorkspace(context: EngineContext): Promise<PhaseResult> {
  const { state, observer, signal } = context;

  // Inline planning has no planner turn to run: the implementer plans in its
  // own session, so the run goes straight from a worktree to writing code.
  const next = state.config.workflow.plan === 'inline' ? 'IMPLEMENTING' : 'PLANNING';

  if (state.workspace !== undefined && (await worktreeExists(state.workspace.path))) {
    return { next, note: `reusing ${state.workspace.path}` };
  }

  const repo = await discoverRepository(state.repository.root);

  if (repo.isDirty) {
    observer.warn(
      `Your working tree has ${repo.dirtyFiles.length} uncommitted change(s). ` +
        'Relay works in a separate worktree, so they are untouched — but they are not part of this run.',
    );
  }

  const issueNumber = state.issue?.number;
  if (issueNumber === undefined) {
    throw new RelayError('Cannot create a workspace before the issue has been fetched.', { code: 'NO_ISSUE' });
  }

  const baseBranch = state.config.workflow.baseBranch.length > 0 ? state.config.workflow.baseBranch : repo.defaultBranch;

  const worktree = await createWorktree({
    repo,
    issueNumber,
    runShortId: state.shortId,
    baseBranch,
    branchPrefix: state.config.workflow.branchPrefix,
    signal,
  });

  state.workspace = worktree;
  observer.note(`Worktree ${worktree.path}`);
  observer.note(`Branch ${worktree.branch} from ${worktree.baseBranch} (${worktree.baseSha.slice(0, 8)})`);

  return { next, note: worktree.branch };
}
