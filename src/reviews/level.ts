/**
 * How hard the agents are asked to look.
 *
 * Review depth is the one dial on this workflow that trades wall-clock and
 * tokens for confidence, and until now it was spread across four unrelated
 * config keys plus a `--fast` flag that set two of them. A level is those knobs
 * under one name, chosen once and understood everywhere: the flag, the config
 * file, the chat composer and the run header all say `thorough` and mean the
 * same five numbers.
 *
 * The levels are deliberately few and deliberately ordered. A dial with eleven
 * positions is a dial nobody moves, and a dial whose positions do not obviously
 * rank is one people set wrong.
 */
import type { PlanMode } from '../storage/config.ts';
import { SEVERITIES, type ReviewFinding, type Severity } from './types.ts';

export const REVIEW_LEVELS = ['none', 'light', 'standard', 'thorough', 'exhaustive'] as const;
export type ReviewLevel = (typeof REVIEW_LEVELS)[number];

export function isReviewLevel(value: unknown): value is ReviewLevel {
  return typeof value === 'string' && (REVIEW_LEVELS as readonly string[]).includes(value);
}

/** Where a severity sits on the scale, so two of them can be compared. */
export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

export interface ReviewProfile {
  level: ReviewLevel;
  /** One line, for a menu: what this level buys and what it costs. */
  headline: string;
  plan: PlanMode;
  reviewCode: boolean;
  maxPlanReviewRounds: number;
  maxCodeReviewRounds: number;
  /**
   * The severity at which a code-review finding sends the diff back on its own,
   * whatever the reviewer classified it as. This is the level's real teeth: a
   * thorough run returns medium-severity findings a lighter run would only
   * report.
   */
  returnsAt: Severity;
  /**
   * The lowest severity at which the reviewer's own `BLOCKING` is still honoured.
   * The reviewer read the code, so its judgement outranks the scale — but only
   * down to here, which is what stops a nitpick marked BLOCKING from costing a
   * revision round on a light review.
   */
  blockingFloor: Severity;
  /** The severity a plan-review finding must reach before the planner answers it. */
  planAnswersAt: Severity;
  /** Cap on findings per review. A long tail costs a round and buys nothing. */
  findingBudget: number;
  /** Extra instructions handed to a reviewer at this level, verbatim. */
  emphasis: readonly string[];
}

/**
 * The one place the numbers live.
 *
 * `standard` is the shipped default and reproduces exactly what Relay did
 * before levels existed: plan review, code review, two rounds each, and a diff
 * that comes back on high-severity findings.
 */
export const REVIEW_PROFILES: Readonly<Record<ReviewLevel, ReviewProfile>> = {
  none: {
    level: 'none',
    headline: 'no review at all — one agent plans and implements, and the tests are the only check',
    plan: 'inline',
    reviewCode: false,
    maxPlanReviewRounds: 0,
    maxCodeReviewRounds: 0,
    // Nothing reviews, so nothing can come back. Kept at the top of the scale
    // rather than left undefined, so every profile answers the same questions.
    returnsAt: 'critical',
    blockingFloor: 'critical',
    planAnswersAt: 'critical',
    findingBudget: 0,
    emphasis: [],
  },
  light: {
    level: 'light',
    headline: 'one code-review round, blocking bugs only — the fastest run that still gets read',
    plan: 'inline',
    reviewCode: true,
    maxPlanReviewRounds: 0,
    maxCodeReviewRounds: 1,
    returnsAt: 'critical',
    blockingFloor: 'high',
    planAnswersAt: 'high',
    findingBudget: 5,
    emphasis: [
      'This is a light review. Report only what you would stop a merge for: correctness bugs, data loss, ',
      'security holes, and requirements the diff does not meet. Style, naming, structure and ideas for ',
      'later are out of scope on this run — leaving them out is the job, not a shortcut.',
    ],
  },
  standard: {
    level: 'standard',
    headline: 'plan review and code review, two rounds each — the default',
    plan: 'review',
    reviewCode: true,
    maxPlanReviewRounds: 2,
    maxCodeReviewRounds: 2,
    returnsAt: 'high',
    blockingFloor: 'medium',
    planAnswersAt: 'medium',
    findingBudget: 10,
    emphasis: [],
  },
  thorough: {
    level: 'thorough',
    headline: 'three rounds each, and medium-severity findings come back too',
    plan: 'review',
    reviewCode: true,
    maxPlanReviewRounds: 3,
    maxCodeReviewRounds: 3,
    returnsAt: 'medium',
    blockingFloor: 'low',
    planAnswersAt: 'low',
    findingBudget: 15,
    emphasis: [
      'This is a thorough review, so the bar is lower than usual: a medium-severity finding is returned to ',
      'the implementer, not merely noted. Go past the happy path — concurrency, error and cancellation ',
      'paths, resource cleanup, boundary values, and what this change does to callers it did not touch.',
    ],
  },
  exhaustive: {
    level: 'exhaustive',
    headline: 'four rounds each, every finding answered — for changes that must not be wrong',
    plan: 'review',
    reviewCode: true,
    maxPlanReviewRounds: 4,
    maxCodeReviewRounds: 4,
    returnsAt: 'low',
    blockingFloor: 'low',
    planAnswersAt: 'low',
    findingBudget: 25,
    emphasis: [
      'This is an exhaustive review: every finding you report is returned to the implementer and must be ',
      'answered, so report everything you can defend and nothing you cannot.',
      'Read beyond the diff — the callers of what changed, the tests that cover it, the invariants it ',
      'assumes, the documentation that describes it, and the behaviour on the paths nobody exercises: ',
      'errors, cancellation, retries, concurrency, resource exhaustion and backwards compatibility.',
    ],
  },
};

export const DEFAULT_REVIEW_LEVEL: ReviewLevel = 'standard';

export function reviewProfile(level: ReviewLevel): ReviewProfile {
  return REVIEW_PROFILES[level];
}

/** The workflow keys a level owns. Everything else about a run is untouched. */
export interface LeveledWorkflow {
  plan: PlanMode;
  reviewCode: boolean;
  maxPlanReviewRounds: number;
  maxCodeReviewRounds: number;
}

/** Writes a level's numbers onto a workflow, in place. */
export function applyReviewLevel<T extends LeveledWorkflow>(workflow: T, level: ReviewLevel): T {
  const profile = reviewProfile(level);
  workflow.plan = profile.plan;
  workflow.reviewCode = profile.reviewCode;
  workflow.maxPlanReviewRounds = profile.maxPlanReviewRounds;
  workflow.maxCodeReviewRounds = profile.maxCodeReviewRounds;
  return workflow;
}

/**
 * Which level a workflow is at, read from the knobs rather than the label.
 *
 * Two things need this. A run recorded before levels existed has no `review`
 * key, and describing it as "standard" when its config says otherwise would be
 * a lie about history. And a config that sets the individual keys by hand is
 * entitled to do that — it is simply not at a level, and `null` is how the UI
 * learns to print `custom` instead of a name it made up.
 */
export function levelOf(workflow: Partial<LeveledWorkflow>): ReviewLevel | null {
  const reviewCode = workflow.reviewCode !== false;
  for (const level of REVIEW_LEVELS) {
    const profile = REVIEW_PROFILES[level];
    if (
      profile.plan === (workflow.plan ?? 'review') &&
      profile.reviewCode === reviewCode &&
      profile.maxPlanReviewRounds === workflow.maxPlanReviewRounds &&
      profile.maxCodeReviewRounds === workflow.maxCodeReviewRounds
    ) {
      return level;
    }
  }
  return null;
}

/** A workflow, as far as review depth is concerned. */
export type ReviewShape = Partial<LeveledWorkflow> & { review?: ReviewLevel };

/**
 * The profile a run is judged by: the severity bars, the finding budget and the
 * instructions its reviewers get.
 *
 * The declared level wins outright. Someone who pins `maxCodeReviewRounds: 3`
 * on a standard run asked for one more round, not for a lower severity bar, and
 * inferring the second from the first would change what comes back to the
 * implementer without anyone having asked. Derivation is only for run snapshots
 * recorded before levels existed, which have no label to read.
 */
export function profileFor(workflow: ReviewShape): ReviewProfile {
  return reviewProfile(workflow.review ?? levelOf(workflow) ?? DEFAULT_REVIEW_LEVEL);
}

/**
 * Whether a code-review finding goes back to the implementer for another round.
 *
 * Severity settles it above the level's `returnsAt` bar; below that, the
 * reviewer's own `BLOCKING` still counts, down to the level's floor. Everything
 * else is reported to the person reading the run and costs nothing.
 */
export function isBlockingAt(finding: ReviewFinding, profile: ReviewProfile): boolean {
  const rank = severityRank(finding.severity);
  if (rank >= severityRank(profile.returnsAt)) return true;
  return finding.impact === 'BLOCKING' && rank >= severityRank(profile.blockingFloor);
}

/** Whether a plan-review finding is one the planner has to answer. */
export function isActionableAt(finding: ReviewFinding, profile: ReviewProfile): boolean {
  return severityRank(finding.severity) >= severityRank(profile.planAnswersAt) || finding.impact === 'BLOCKING';
}

/**
 * `plan 2 · code 2 · returns high+`, for a status line.
 *
 * The rounds come from the workflow rather than from the profile, because a
 * `--max-code-rounds` on top of a level is exactly the case where the two
 * disagree — and the line is there to say what this run will really do.
 */
export function describeReview(workflow: ReviewShape): string {
  const profile = profileFor(workflow);
  const plan = workflow.plan ?? profile.plan;
  const reviewCode = workflow.reviewCode ?? profile.reviewCode;
  if (plan !== 'review' && !reviewCode) return 'nothing reviews this run';

  const parts = [
    plan === 'review' ? `plan ${workflow.maxPlanReviewRounds ?? profile.maxPlanReviewRounds}` : 'no plan review',
    reviewCode ? `code ${workflow.maxCodeReviewRounds ?? profile.maxCodeReviewRounds}` : 'no code review',
  ];
  if (reviewCode) parts.push(`returns ${profile.returnsAt}+`);
  return parts.join(' · ');
}

/**
 * The name to print for a workflow: the level, and whether anything was tuned
 * on top of it. `standard (tuned)` is more honest than either half alone.
 */
export function reviewLevelName(workflow: ReviewShape): string {
  const declared = workflow.review ?? levelOf(workflow) ?? DEFAULT_REVIEW_LEVEL;
  return levelOf(workflow) === declared ? declared : `${declared} (tuned)`;
}
