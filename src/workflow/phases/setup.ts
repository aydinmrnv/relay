import { RelayError } from '../../util/errors.ts';
import { renderIssueMarkdown } from '../../github/types.ts';
import { issueHeadline, issueIdentity } from '../../issues/identity.ts';
import { createWorktree, worktreeExists } from '../../git/worktree.ts';
import { discoverRepository } from '../../git/repository.ts';
import { RUN_FILES } from '../../storage/runs.ts';
import type { EngineContext, PhaseResult } from '../context.ts';
import { assembleBrief, renderBriefArtifact } from '../../agents/brief.ts';
import { describeWithheld, unattendedEnvironment } from '../../unattended/environment.ts';
import { trustedComments, unattendedOf } from '../../unattended/policy.ts';

async function ensureBrief(context: EngineContext, worktreePath: string): Promise<void> {
  if (context.state.brief === undefined) context.state.brief = await assembleBrief(worktreePath);
  if (await context.store.readArtifact(RUN_FILES.brief) === undefined) {
    await context.store.writeArtifact(RUN_FILES.brief, renderBriefArtifact(context.state.brief));
  }
}

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

  // Said once, up front, and by name: an agent that cannot find `GH_TOKEN` is
  // a confusing failure unless the run has already said it took it away.
  const withheld = unattendedEnvironment(state);
  if (withheld !== undefined && withheld.names.length > 0) {
    observer.note(
      `Unattended: ${withheld.names.length} secret-looking environment variable(s) are withheld from the agents ` +
        `and the test suite (${describeWithheld(withheld.names)}). Each CLI keeps its own sign-in; ` +
        'unattended.allowEnv lets others through.',
    );
  }

  const assignments = roles.map((role) => `${role}=${state.config.agents[role]}`).join('  ');
  return { next: 'FETCHING_ISSUE', note: assignments };
}

export async function fetchingIssue(context: EngineContext): Promise<PhaseResult> {
  const { state, store, issueProvider, observer, signal } = context;

  const fetched = await issueProvider.getIssue(state.issueRef, { signal });

  // A run nobody is watching reads the comments of people it has a reason to
  // trust and no others. A run somebody started reads all of them: that person
  // chose the issue, and is there to see what the agents make of it.
  let issue = fetched;
  let omitted = '';
  if (state.trigger !== undefined) {
    const comments = trustedComments(unattendedOf(state.config), fetched, state.trigger.actor);
    if (comments.dropped > 0) {
      issue = { ...fetched, comments: comments.kept };
      const who = comments.droppedAuthors.join(', ');
      observer.note(
        `Unattended: ${comments.dropped} comment(s) from outside the allowlist were not given to the agents (${who}).`,
      );
      omitted =
        `\n_${comments.dropped} comment(s) on this issue are not shown here. This run started without a person, ` +
        `so it reads only comments from people on the repository's allowlist or with write access to it; ` +
        `the rest (from ${who}) were left out._\n`;
    }
  }
  const markdown = `${renderIssueMarkdown(issue)}${omitted}`;

  await store.writeArtifact(RUN_FILES.issue, markdown);
  context.issueMarkdown = markdown;

  state.issue = { id: issue.id, number: issue.number, ...(issue.key === undefined ? {} : { key: issue.key }), title: issue.title, url: issue.url, state: issue.state };
  if (issue.repository !== null) {
    state.repository.owner ??= issue.repository.owner;
    state.repository.name ??= issue.repository.name;
  }

  return { next: 'CREATING_WORKSPACE', note: issueHeadline(issue) };
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
    await ensureBrief(context, state.workspace.path);
    return { next, note: `reusing ${state.workspace.path}` };
  }

  const repo = await discoverRepository(state.repository.root);

  if (repo.isDirty) {
    observer.warn(
      `Your working tree has ${repo.dirtyFiles.length} uncommitted change(s). ` +
        'Relay works in a separate worktree, so they are untouched — but they are not part of this run.',
    );
  }

  const issue = state.issue;
  if (issue === undefined) {
    throw new RelayError('Cannot create a workspace before the issue has been fetched.', { code: 'NO_ISSUE' });
  }

  const baseBranch = state.config.workflow.baseBranch.length > 0 ? state.config.workflow.baseBranch : repo.defaultBranch;

  const worktree = await createWorktree({
    repo,
    // A numbered issue names its branch after the number, exactly as before; a
    // task without one names it after the title.
    issue: issueIdentity(issue),
    runShortId: state.shortId,
    baseBranch,
    branchPrefix: state.config.workflow.branchPrefix,
    signal,
  });

  state.workspace = worktree;
  await ensureBrief(context, worktree.path);
  observer.note(`Worktree ${worktree.path}`);
  observer.note(
    worktree.fromEmptyRepository === true
      ? `Branch ${worktree.branch} from an empty tree — this repository has no commits, so this run makes its first`
      : `Branch ${worktree.branch} from ${worktree.baseBranch} (${worktree.baseSha.slice(0, 8)})`,
  );

  return { next, note: worktree.branch };
}
