import { RelayError } from '../../util/errors.ts';
import {
  buildPlanPrompt,
  buildPlanReviewPrompt,
  buildPlanRevisionPrompt,
  buildReviewPrimingPrompt,
  discoverInstructionFiles,
  type PromptContext,
} from '../../agents/prompts.ts';
import { extractSection, beginMarker, endMarker } from '../../reviews/protocol.ts';
import { parseReview, parseFindingResponses, REVIEW_JSON_SCHEMA } from '../../reviews/parse.ts';
import { isActionable, type ReviewRound } from '../../reviews/types.ts';
import { RUN_FILES } from '../../storage/runs.ts';
import { runAgentTurn, runStructuredTurn } from '../agentRunner.ts';
import { awaitPriming, startPriming } from '../priming.ts';
import { providerNameFor, type EngineContext, type PhaseResult } from '../context.ts';

async function promptContext(context: EngineContext): Promise<PromptContext> {
  const { state } = context;
  const workspace = state.workspace;
  if (workspace === undefined) throw new RelayError('No workspace for this run.', { code: 'NO_WORKSPACE' });

  const issueMarkdown = context.issueMarkdown ?? (await context.store.readArtifact(RUN_FILES.issue));
  if (issueMarkdown === undefined) {
    throw new RelayError('The issue artifact is missing from this run.', { code: 'NO_ISSUE' });
  }
  context.issueMarkdown = issueMarkdown;

  return {
    worktreePath: workspace.path,
    branch: workspace.branch,
    issueMarkdown,
    instructionFiles: await discoverInstructionFiles(workspace.path),
  };
}

const PLAN_EXPECTATION = [beginMarker('PLAN'), '<the complete plan, in markdown>', endMarker('PLAN')].join('\n');

const REVIEW_EXPECTATION = [
  beginMarker('REVIEW'),
  '{ "decision": "approve | request_changes", "summary": "...", "findings": [ ... ] }',
  endMarker('REVIEW'),
].join('\n');

export async function planning(context: EngineContext): Promise<PhaseResult> {
  const { state, store } = context;
  const prompts = await promptContext(context);

  // The reviewer reads the codebase while the planner plans. Both need the same
  // reading, and only one of them has to be waited for.
  startPriming(context, {
    role: 'planReviewer',
    prompt: buildReviewPrimingPrompt(prompts, { subject: 'plan' }),
    phase: 'REVIEWING_PLAN',
  });

  const session = await runAgentTurn(context, {
    role: 'planner',
    prompt: buildPlanPrompt(prompts),
    capability: 'read_only',
    timeoutMs: state.config.timeouts.planningMs,
  });

  // Fall back to the whole final message if the agent omitted the markers: a
  // plan without delimiters is still a plan, and the reviewer will judge it.
  const plan = extractSection(session.text, 'PLAN') ?? session.text.trim();
  if (plan.length === 0) {
    throw new RelayError('The planner produced an empty plan.', {
      code: 'EMPTY_PLAN',
      hint: `See ${store.path(RUN_FILES.events)} for the transcript.`,
    });
  }

  await store.writeArtifact(RUN_FILES.plan, plan);
  return { next: 'REVIEWING_PLAN', note: `${plan.split('\n').length} line plan` };
}

export async function reviewingPlan(context: EngineContext): Promise<PhaseResult> {
  const { state, store, observer } = context;
  const prompts = await promptContext(context);

  const plan = await store.readArtifact(RUN_FILES.plan);
  if (plan === undefined) throw new RelayError('plan.md is missing from this run.', { code: 'NO_PLAN' });

  const round = state.rounds.planReview + 1;
  const maxRounds = state.config.workflow.maxPlanReviewRounds;

  // Round 1 resumes the session the reviewer built while the planner planned;
  // later rounds resume the review itself, so the reviewer remembers what it
  // already objected to and can judge whether the revision addressed it.
  const primed = await awaitPriming(context, 'planReviewer');

  const { value: review, text } = await runStructuredTurn(context, {
    role: 'planReviewer',
    prompt: buildPlanReviewPrompt({ ...prompts, plan, round, maxRounds, primed }),
    capability: 'read_only',
    timeoutMs: state.config.timeouts.reviewMs,
    resume: true,
    outputSchema: REVIEW_JSON_SCHEMA,
    parse: parseReview,
    expectation: REVIEW_EXPECTATION,
  });

  state.rounds.planReview = round;

  const entry: ReviewRound = {
    round,
    kind: 'plan',
    reviewer: providerNameFor(context, 'planReviewer'),
    decision: review.decision,
    ...(review.summary === undefined ? {} : { summary: review.summary }),
    findings: review.findings,
    at: new Date().toISOString(),
  };
  state.reviews.push(entry);
  await store.saveReview('plan', round, { ...entry, rawFinalMessage: text });

  const actionable = review.findings.filter(isActionable);

  if (review.decision === 'approve' || actionable.length === 0) {
    state.planApproved = true;
    observer.note(`Plan approved after ${round} review round(s).`);
    return { next: 'IMPLEMENTING', note: `approved (round ${round})` };
  }

  if (round >= maxRounds) {
    // Two agents must not debate forever. Proceed with the current plan and
    // record that it was never approved so the summary says so plainly.
    state.planApproved = false;
    observer.warn(
      `Plan review limit reached (${maxRounds} rounds) with ${actionable.length} unresolved finding(s). ` +
        'Proceeding to implementation with the current plan.',
    );
    return { next: 'IMPLEMENTING', note: `round limit reached (${actionable.length} unresolved)` };
  }

  observer.note(`Reviewer requested changes: ${actionable.length} actionable finding(s).`);
  return { next: 'REVISING_PLAN', note: `${actionable.length} finding(s)` };
}

export async function revisingPlan(context: EngineContext): Promise<PhaseResult> {
  const { state, store } = context;

  const lastReview = [...state.reviews].reverse().find((entry) => entry.kind === 'plan');
  if (lastReview === undefined) {
    throw new RelayError('No plan review to revise against.', { code: 'NO_REVIEW' });
  }

  const findings = lastReview.findings.filter(isActionable);
  const round = state.rounds.planReview;

  const { value: responses, text } = await runStructuredTurn(context, {
    role: 'planner',
    prompt: buildPlanRevisionPrompt({
      findings,
      round,
      maxRounds: state.config.workflow.maxPlanReviewRounds,
      reviewerName: providerNameFor(context, 'planReviewer'),
      ...(lastReview.summary === undefined ? {} : { reviewSummary: lastReview.summary }),
    }),
    capability: 'read_only',
    timeoutMs: state.config.timeouts.planningMs,
    // The planner keeps its original session, so it still has the codebase
    // reading that produced the plan in the first place.
    resume: true,
    parse: parseFindingResponses,
    expectation: [
      beginMarker('RESPONSES'),
      '{ "responses": [ { "findingId": "F1", "response": "ACCEPT", "reasoning": "..." } ] }',
      endMarker('RESPONSES'),
      '',
      PLAN_EXPECTATION,
    ].join('\n'),
  });

  lastReview.responses = responses;

  const revisedPlan = extractSection(text, 'PLAN');
  if (revisedPlan === undefined) {
    // Every finding may have been rejected with evidence, in which case an
    // unchanged plan is a legitimate outcome rather than a failure.
    const allRejected = responses.every((response) => response.response === 'REJECT');
    if (!allRejected) {
      throw new RelayError('The planner responded to the review but did not emit a revised plan.', {
        code: 'NO_REVISED_PLAN',
        hint: `See ${store.path(RUN_FILES.events)} for the transcript.`,
      });
    }
    context.observer.warn('Planner rejected every finding; keeping the previous plan.');
  } else {
    await store.writeArtifact(RUN_FILES.plan, revisedPlan);
  }

  await store.saveDiscussion('plan', round, {
    round,
    findings,
    responses,
    planRevised: revisedPlan !== undefined,
    at: new Date().toISOString(),
  });

  const accepted = responses.filter((response) => response.response === 'ACCEPT').length;
  const rejected = responses.filter((response) => response.response === 'REJECT').length;
  context.observer.note(`Planner accepted ${accepted}, rejected ${rejected} of ${findings.length} finding(s).`);

  return { next: 'REVIEWING_PLAN', note: `accepted ${accepted}, rejected ${rejected}` };
}
