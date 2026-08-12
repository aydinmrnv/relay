import type { Decision } from '../reviews/types.ts';
import type { Phase } from '../workflow/phases.ts';
import { isTerminal, phaseLabel } from '../workflow/phases.ts';
import type { RunState } from '../workflow/state.ts';
import type { RunUsage, UsageTotals } from '../workflow/usage.ts';

/**
 * The machine-readable shape of a run, for `relay status --json`.
 *
 * Absent facts are `null` rather than omitted keys, so a consumer can index
 * every field without guarding, and the schema does not change shape between a
 * run that has a diff and one that does not. Nothing here is colourized: the
 * payload is built from state, never from the strings the terminal view paints.
 */
export interface RunJson {
  runId: string;
  shortId: string;
  phase: Phase;
  phaseLabel: string;
  terminal: boolean;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  durationMs: number | null;

  issueRef: string;
  issue: { number: number; title: string; url: string; state: string } | null;

  repository: { owner: string | null; name: string | null; defaultBranch: string };
  branch: string | null;
  workspace: { path: string; branch: string; baseBranch: string; baseSha: string } | null;

  agents: Record<string, string>;
  planApproved: boolean;
  rounds: { planReview: number; codeReview: number; maxPlanReview: number; maxCodeReview: number };
  reviews: Array<{ kind: 'plan' | 'code'; round: number; reviewer: string; decision: Decision; findings: number; at: string }>;

  diff: {
    fileCount: number;
    additions: number;
    deletions: number;
    files: string[];
    patchFile: string;
    at: string;
  } | null;

  tests: {
    discovered: boolean;
    command: string[];
    passed: boolean;
    exitCode: number | null;
    durationMs: number;
    timedOut: boolean;
    skippedReason: string | null;
    at: string;
  } | null;

  usage: RunUsageJson | null;
  error: { message: string; phase: Phase; code: string | null } | null;
}

/**
 * Usage totals as JSON. `costUsd` is `null`, not an omitted key, for a bucket
 * nothing priced — Codex publishes no cost, so a Codex-only run has real token
 * counts and no price. `null` says "not reported" where `0` would say "free".
 */
export interface UsageTotalsJson {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  turns: number;
}

export interface RunUsageJson {
  total: UsageTotalsJson;
  byPhase: Partial<Record<Phase, UsageTotalsJson>>;
}

/** Projects persisted run state onto the public JSON contract. */
export function runToJson(state: RunState): RunJson {
  const finishedAt = state.finishedAt ?? null;
  const elapsed = new Date(finishedAt ?? state.updatedAt).getTime() - new Date(state.createdAt).getTime();
  const workspace = state.workspace;
  const diff = state.diff;
  const tests = state.tests;
  const error = state.error;

  return {
    runId: state.runId,
    shortId: state.shortId,
    phase: state.phase,
    phaseLabel: phaseLabel(state.phase),
    terminal: isTerminal(state.phase),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    finishedAt,
    durationMs: Number.isFinite(elapsed) ? elapsed : null,

    issueRef: state.issueRef,
    issue:
      state.issue === undefined
        ? null
        : { number: state.issue.number, title: state.issue.title, url: state.issue.url, state: state.issue.state },

    repository: {
      owner: state.repository.owner,
      name: state.repository.name,
      defaultBranch: state.repository.defaultBranch,
    },
    branch: workspace?.branch ?? null,
    workspace:
      workspace === undefined
        ? null
        : {
            path: workspace.path,
            branch: workspace.branch,
            baseBranch: workspace.baseBranch,
            baseSha: workspace.baseSha,
          },

    agents: Object.fromEntries(
      Object.entries(state.config.agents).map(([role, provider]) => [
        role,
        state.agents[role as keyof typeof state.agents]?.provider ?? provider,
      ]),
    ),
    planApproved: state.planApproved,
    rounds: {
      planReview: state.rounds.planReview,
      codeReview: state.rounds.codeReview,
      maxPlanReview: state.config.workflow.maxPlanReviewRounds,
      maxCodeReview: state.config.workflow.maxCodeReviewRounds,
    },
    reviews: state.reviews.map((review) => ({
      kind: review.kind,
      round: review.round,
      reviewer: review.reviewer,
      decision: review.decision,
      findings: review.findings.length,
      at: review.at,
    })),

    diff:
      diff === undefined
        ? null
        : {
            fileCount: diff.fileCount,
            additions: diff.additions,
            deletions: diff.deletions,
            files: diff.files,
            patchFile: diff.patchFile,
            at: diff.at,
          },

    tests:
      tests === undefined
        ? null
        : {
            discovered: tests.discovered,
            command: tests.command,
            passed: tests.passed,
            exitCode: tests.exitCode,
            durationMs: tests.durationMs,
            timedOut: tests.timedOut,
            skippedReason: tests.skippedReason ?? null,
            at: tests.at,
          },

    usage: state.usage === undefined ? null : usageToJson(state.usage),
    error: error === undefined ? null : { message: error.message, phase: error.phase, code: error.code ?? null },
  };
}

/** Projects usage onto the JSON contract, pinning unpriced buckets to `null`. */
function usageToJson(usage: RunUsage): RunUsageJson {
  return {
    total: totalsToJson(usage.total),
    byPhase: Object.fromEntries(
      Object.entries(usage.byPhase).map(([phase, totals]) => [phase, totalsToJson(totals)]),
    ) as Partial<Record<Phase, UsageTotalsJson>>,
  };
}

function totalsToJson(totals: UsageTotals): UsageTotalsJson {
  return {
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    costUsd: totals.costUsd ?? null,
    turns: totals.turns,
  };
}
