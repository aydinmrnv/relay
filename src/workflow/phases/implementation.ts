import { RelayError } from '../../util/errors.ts';
import {
  buildCodeReviewPrompt,
  buildCodeRevisionPrompt,
  buildImplementationPrompt,
  buildInlinePlanPrompt,
  buildReviewPrimingPrompt,
  type PromptContext,
} from '../../agents/prompts.ts';
import { assembleBrief, renderBriefArtifact } from '../../agents/brief.ts';
import { snapshotDiff, formatDiffStat, type DiffSnapshot } from '../../git/diff.ts';
import { beginMarker, endMarker, extractSection } from '../../reviews/protocol.ts';
import { parseReview, parseFindingResponses, REVIEW_JSON_SCHEMA } from '../../reviews/parse.ts';
import { isBlocking, type ReviewRound } from '../../reviews/types.ts';
import { discoverTestCommand } from '../../testing/discovery.ts';
import { reviewsCode } from '../../storage/config.ts';
import { RUN_FILES } from '../../storage/runs.ts';
import { runAgentTurn, runStructuredTurn } from '../agentRunner.ts';
import { cancelBackgroundTests, startBackgroundTests } from '../backgroundTests.ts';
import { awaitPriming, startPriming } from '../priming.ts';
import { providerNameFor, type EngineContext, type PhaseResult } from '../context.ts';

/** Cap on how much diff is pasted into a review prompt. */
const MAX_DIFF_PROMPT_CHARS = 400_000;

async function promptContext(context: EngineContext): Promise<PromptContext> {
  const workspace = context.state.workspace;
  if (workspace === undefined) throw new RelayError('No workspace for this run.', { code: 'NO_WORKSPACE' });

  const issueMarkdown = context.issueMarkdown ?? (await context.store.readArtifact(RUN_FILES.issue));
  if (issueMarkdown === undefined) {
    throw new RelayError('The issue artifact is missing from this run.', { code: 'NO_ISSUE' });
  }
  context.issueMarkdown = issueMarkdown;

  if (context.state.brief === undefined) context.state.brief = await assembleBrief(workspace.path);
  if (await context.store.readArtifact(RUN_FILES.brief) === undefined) {
    await context.store.writeArtifact(RUN_FILES.brief, renderBriefArtifact(context.state.brief));
  }

  return {
    worktreePath: workspace.path,
    branch: workspace.branch,
    issueMarkdown,
    brief: context.state.brief,
  };
}

const REVIEW_EXPECTATION = [
  beginMarker('REVIEW'),
  '{ "decision": "approve | request_changes", "summary": "...", "findings": [ { "id": "F1", "impact": "BLOCKING", ... } ] }',
  endMarker('REVIEW'),
].join('\n');

/**
 * Records what git says changed. Called after every implementation round, so
 * the reviewer always sees the real diff rather than the agent's account of it.
 */
async function captureDiff(context: EngineContext, label: string): Promise<DiffSnapshot> {
  const { state, store, signal } = context;
  const workspace = state.workspace;
  if (workspace === undefined) throw new RelayError('No workspace for this run.', { code: 'NO_WORKSPACE' });

  const snapshot = await snapshotDiff(workspace.path, workspace.baseSha, { signal });
  const patchFile = await store.savePatch(label, snapshot.patch);

  state.diff = {
    fileCount: snapshot.files.length,
    additions: snapshot.additions,
    deletions: snapshot.deletions,
    files: snapshot.files.map((file) => file.path),
    patchFile,
    at: new Date().toISOString(),
  };

  return snapshot;
}

export async function implementing(context: EngineContext): Promise<PhaseResult> {
  const { state, store, observer } = context;
  const prompts = await promptContext(context);
  const inline = state.config.workflow.plan === 'inline';

  const plan = await store.readArtifact(RUN_FILES.plan);
  if (plan === undefined && !inline) {
    throw new RelayError('plan.md is missing from this run.', { code: 'NO_PLAN' });
  }

  if (!inline && !state.planApproved) {
    observer.warn('Implementing a plan that was not approved by the reviewer.');
  }

  const reviewed = reviewsCode(state.config);
  const discovery = await discoverTestCommand(prompts.worktreePath, state.config.tests.command);
  const relayRunsTests = state.config.workflow.runTests && state.config.workflow.concurrentTests;
  const promptOptions = {
    ...prompts,
    plan: plan ?? '',
    relayRunsTests,
    reviewed,
    typos: state.config.workflow.typos,
    ...(discovery.found ? { testCommand: discovery.command.command } : {}),
  };

  // The code reviewer reads the issue and the plan while the code is written,
  // so its review turn is spent on the diff rather than on the codebase. A run
  // with no review turn has nothing to read ahead for.
  if (reviewed) {
    startPriming(context, {
      role: 'codeReviewer',
      prompt: buildReviewPrimingPrompt(prompts, {
        subject: 'implementation',
        ...(plan === undefined ? {} : { plan }),
      }),
      phase: 'REVIEWING_CODE',
    });
  }

  const session = await runAgentTurn(context, {
    role: 'implementer',
    prompt: inline ? buildInlinePlanPrompt(promptOptions) : buildImplementationPrompt(promptOptions),
    capability: 'write',
    timeoutMs: state.config.timeouts.implementationMs,
  });

  await store.writeArtifact('implementation-notes.md', session.text);

  // Inline planning still produces a plan.md: it is what the code reviewer
  // reviews the diff against, and what `relay plan` prints afterwards.
  if (inline) {
    const stated = extractSection(session.text, 'PLAN');
    if (stated === undefined) {
      observer.warn('The implementer did not state a plan; the reviewer will judge the diff against the issue alone.');
    } else {
      await store.writeArtifact(RUN_FILES.plan, stated);
    }
  }

  // Verified through git, not through the agent's report.
  const snapshot = await captureDiff(context, 'implementation');

  if (snapshot.isEmpty) {
    throw new RelayError('The implementer reported success but changed no files.', {
      code: 'EMPTY_IMPLEMENTATION',
      hint: `Inspect ${store.path(RUN_FILES.events)} and the worktree at ${state.workspace?.path ?? '(unknown)'}.`,
    });
  }

  // The tree is settled and the reviewer is about to read it: the suite can run
  // against that same tree instead of waiting for the review to finish.
  startBackgroundTests(context);

  observer.note(`Implementation: ${formatDiffStat(snapshot)}`);
  if (!reviewed) {
    // Said out loud every time. A skipped review is the one thing about a fast
    // run that changes what its diff is worth, and a run that stayed quiet
    // about it looks exactly like a run that was reviewed and approved.
    observer.warn('No code review on this run: the diff was read by nobody but its author.');
    return { next: 'TESTING', note: `${formatDiffStat(snapshot)} · no code review` };
  }
  return { next: 'REVIEWING_CODE', note: formatDiffStat(snapshot) };
}

export async function reviewingCode(context: EngineContext): Promise<PhaseResult> {
  const { state, store, observer } = context;
  const prompts = await promptContext(context);

  // Inline planning writes plan.md from the implementer's own account of what
  // it did; an implementer that skipped it leaves the issue as the only spec.
  const plan = (await store.readArtifact(RUN_FILES.plan)) ?? '(no written plan — review the diff against the issue)';

  const workspace = state.workspace;
  if (workspace === undefined) throw new RelayError('No workspace for this run.', { code: 'NO_WORKSPACE' });

  const snapshot = await snapshotDiff(workspace.path, workspace.baseSha, {
    maxPatchChars: MAX_DIFF_PROMPT_CHARS,
    signal: context.signal,
  });
  if (snapshot.truncated) {
    observer.warn('The diff is large and was truncated for the reviewer prompt.');
  }

  const round = state.rounds.codeReview + 1;
  const maxRounds = state.config.workflow.maxCodeReviewRounds;
  const primed = await awaitPriming(context, 'codeReviewer');

  const { value: review, text } = await runStructuredTurn(context, {
    role: 'codeReviewer',
    prompt: buildCodeReviewPrompt({
      ...prompts,
      plan,
      diff: snapshot.patch,
      diffStat: formatDiffStat(snapshot),
      round,
      maxRounds,
      primed,
      planApproved: state.planApproved,
      testsRunning: context.backgroundTests !== undefined,
    }),
    capability: 'read_only',
    timeoutMs: state.config.timeouts.reviewMs,
    resume: true,
    outputSchema: REVIEW_JSON_SCHEMA,
    parse: parseReview,
    expectation: REVIEW_EXPECTATION,
  });

  state.rounds.codeReview = round;

  const entry: ReviewRound = {
    round,
    kind: 'code',
    reviewer: providerNameFor(context, 'codeReviewer'),
    implementer: providerNameFor(context, 'implementer'),
    decision: review.decision,
    ...(review.summary === undefined ? {} : { summary: review.summary }),
    findings: review.findings,
    at: new Date().toISOString(),
  };
  state.reviews.push(entry);
  await store.saveReview('code', round, { ...entry, rawFinalMessage: text });

  // Only blocking findings go back automatically; the rest are reported to the
  // user in the summary so they stay visible without costing a round.
  const blocking = review.findings.filter(isBlocking);

  if (review.decision === 'approve' || blocking.length === 0) {
    observer.note(`Code review passed after ${round} round(s) (${review.findings.length} total finding(s)).`);
    return { next: 'TESTING', note: `approved (round ${round})` };
  }

  if (round >= maxRounds) {
    observer.warn(
      `Code review limit reached (${maxRounds} rounds) with ${blocking.length} unresolved blocking finding(s).`,
    );
    return { next: 'TESTING', note: `round limit reached (${blocking.length} blocking unresolved)` };
  }

  // The implementer is about to edit the tree the suite is running against, so
  // that run is abandoned rather than allowed to report on a moving target.
  await cancelBackgroundTests(context);

  observer.note(`Code review requested changes: ${blocking.length} blocking finding(s).`);
  return { next: 'REVISING_CODE', note: `${blocking.length} blocking` };
}

export async function revisingCode(context: EngineContext): Promise<PhaseResult> {
  const { state, store, observer } = context;

  const lastReview = [...state.reviews].reverse().find((entry) => entry.kind === 'code');
  if (lastReview === undefined) throw new RelayError('No code review to revise against.', { code: 'NO_REVIEW' });

  const blocking = lastReview.findings.filter(isBlocking);
  const round = state.rounds.codeReview;

  const { value: responses } = await runStructuredTurn(context, {
    role: 'implementer',
    prompt: buildCodeRevisionPrompt({
      findings: blocking,
      round,
      maxRounds: state.config.workflow.maxCodeReviewRounds,
      reviewerName: providerNameFor(context, 'codeReviewer'),
      relayRunsTests: state.config.workflow.runTests && state.config.workflow.concurrentTests,
      typos: state.config.workflow.typos,
      ...(lastReview.summary === undefined ? {} : { reviewSummary: lastReview.summary }),
    }),
    capability: 'write',
    timeoutMs: state.config.timeouts.implementationMs,
    // Resume the implementer's session: it wrote this code and still has the
    // reasoning behind it in context.
    resume: true,
    parse: parseFindingResponses,
    expectation: [
      beginMarker('RESPONSES'),
      '{ "responses": [ { "findingId": "F1", "response": "ACCEPT", "reasoning": "..." } ] }',
      endMarker('RESPONSES'),
    ].join('\n'),
  });

  lastReview.responses = responses;

  const snapshot = await captureDiff(context, `revision-round-${round}`);
  // A settled tree again: the suite can run against it during the next review.
  startBackgroundTests(context);

  await store.saveDiscussion('code', round, {
    round,
    findings: blocking,
    responses,
    diffAfter: { files: snapshot.files.length, additions: snapshot.additions, deletions: snapshot.deletions },
    at: new Date().toISOString(),
  });

  const accepted = responses.filter((response) => response.response === 'ACCEPT').length;
  const rejected = responses.filter((response) => response.response === 'REJECT').length;
  observer.note(
    `Implementer accepted ${accepted}, rejected ${rejected} of ${blocking.length} blocking finding(s). ` +
      `Now ${formatDiffStat(snapshot)}.`,
  );

  return { next: 'REVIEWING_CODE', note: `accepted ${accepted}, rejected ${rejected}` };
}
