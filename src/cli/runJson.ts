import type { Landing } from '../git/commit.ts';
import type { DeliveryPolicy } from '../storage/config.ts';
import type { DeliveryStep } from '../workflow/state.ts';
import type { Decision } from '../reviews/types.ts';
import type { Phase } from '../workflow/phases.ts';
import { isTerminal, phaseLabel } from '../workflow/phases.ts';
import type { RunState } from '../workflow/state.ts';
import { runLiveness, type RunLiveness } from '../workflow/liveness.ts';
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
  liveness: RunLiveness;
  stale: boolean;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  durationMs: number | null;

  issueRef: string;
  /**
   * `number` is null for a tracker that does not number its issues, and for a
   * task that came from a file or a prompt. `id` is the provider-scoped identity
   * — `github:acme/widgets#142`, `local:fix-flaky-timeout` — and is null only on
   * runs recorded before there was more than one provider.
   */
  issue: { id: string | null; number: number | null; title: string; url: string; state: string } | null;

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

  /** Where the run's work currently lives. `unlanded` means "still only staged". */
  landing: Landing;
  unlanded: boolean;
  commit: { sha: string; branch: string; subject: string; at: string } | null;

  /**
   * Where the work went. Each is `null` until the delivery phase took that step,
   * and `delivery` explains the gaps: which steps ran, which did not, and why.
   */
  push: { remote: string; branch: string; sha: string; at: string } | null;
  pullRequest: { url: string; number: number | null; base: string; head: string; at: string } | null;
  merge: { into: string; via: 'local' | 'pull-request'; sha?: string; fastForward?: boolean; url?: string; at: string } | null;
  /** Every delivery step, including the ones that were skipped and why. */
  delivery: {
    policy: DeliveryPolicy;
    reached: DeliveryPolicy;
    steps: Array<{ step: DeliveryStep; status: 'done' | 'skipped' | 'failed'; detail: string; at: string }>;
    at: string;
    /** Whether the pull request closes an issue, or why it closes none. */
    issueLink?: { status: 'done' | 'skipped'; detail: string; at: string };
    comment?: { status: 'done' | 'skipped' | 'failed'; detail: string; url?: string; at: string };
  } | null;
  notification: RunState['notification'] | null;

  tests: {
    discovered: boolean;
    command: string[];
    /** Subdirectory the suite ran in, relative to the worktree; null at the root. */
    directory: string | null;
    passed: boolean;
    exitCode: number | null;
    durationMs: number;
    timedOut: boolean;
    skippedReason: string | null;
    at: string;
  } | null;

  usage: RunUsageJson | null;
  /**
   * Why a run ended before its work did, when the reason was not a failure:
   * a person stopped it, or it spent past `workflow.maxCostUsd`.
   */
  stopped: {
    reason: 'user' | 'budget';
    detail: string;
    at: string;
    spentUsd: number | null;
    maxCostUsd: number | null;
  } | null;
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
  /**
   * Turns that reported a price. `null` for a run recorded before Relay
   * counted them — which is not the same as zero.
   */
  pricedTurns: number | null;
}

export interface RunUsageJson {
  total: UsageTotalsJson;
  byPhase: Partial<Record<Phase, UsageTotalsJson>>;
}

export interface RunJsonOptions {
  /**
   * Landing verified against git. Omitted, it is inferred from state alone,
   * which can only report `committed` (Relay committed it), `empty`, or
   * `unknown` — never `unlanded`, since that claim needs the branch itself.
   */
  landing?: Landing;
}

/** Projects persisted run state onto the public JSON contract. */
export function runToJson(state: RunState, options: RunJsonOptions = {}): RunJson {
  const finishedAt = state.finishedAt ?? null;
  const elapsed = new Date(finishedAt ?? state.updatedAt).getTime() - new Date(state.createdAt).getTime();
  const workspace = state.workspace;
  const diff = state.diff;
  const tests = state.tests;
  const error = state.error;
  const commit = state.commit;
  const landing =
    options.landing ?? (commit !== undefined ? 'committed' : (diff?.fileCount ?? 0) === 0 ? 'empty' : 'unknown');

  return {
    runId: state.runId,
    shortId: state.shortId,
    phase: state.phase,
    phaseLabel: phaseLabel(state.phase),
    terminal: isTerminal(state.phase),
    liveness: runLiveness(state),
    stale: runLiveness(state) === 'stale',
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    finishedAt,
    durationMs: Number.isFinite(elapsed) ? elapsed : null,

    issueRef: state.issueRef,
    issue:
      state.issue === undefined
        ? null
        : {
            id: state.issue.id ?? null,
            number: state.issue.number,
            title: state.issue.title,
            url: state.issue.url,
            state: state.issue.state,
          },

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

    landing,
    unlanded: landing === 'unlanded',
    commit:
      commit === undefined
        ? null
        : { sha: commit.sha, branch: commit.branch, subject: commit.subject, at: commit.at },

    push: state.push ?? null,
    pullRequest: state.pullRequest ?? null,
    merge: state.merge ?? null,
    delivery: state.delivery ?? null,
    notification: state.notification ?? null,

    tests:
      tests === undefined
        ? null
        : {
            discovered: tests.discovered,
            command: tests.command,
            directory: tests.directory ?? null,
            passed: tests.passed,
            exitCode: tests.exitCode,
            durationMs: tests.durationMs,
            timedOut: tests.timedOut,
            skippedReason: tests.skippedReason ?? null,
            at: tests.at,
          },

    usage: state.usage === undefined ? null : usageToJson(state.usage),
    stopped:
      state.stopped === undefined
        ? null
        : {
            reason: state.stopped.reason,
            detail: state.stopped.detail,
            at: state.stopped.at,
            spentUsd: state.stopped.spentUsd ?? null,
            maxCostUsd: state.stopped.maxCostUsd ?? null,
          },
    error: error === undefined ? null : { message: error.message, phase: error.phase, code: error.code ?? null },
  };
}

/** Projects usage onto the JSON contract, pinning unpriced buckets to `null`. */
export function usageToJson(usage: RunUsage): RunUsageJson {
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
    pricedTurns: totals.pricedTurns ?? null,
  };
}
