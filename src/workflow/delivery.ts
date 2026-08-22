import type { DeliveryPolicy } from '../storage/config.ts';
import { isBlockingAt } from '../reviews/level.ts';
import { reviewProfileOf } from '../storage/config.ts';
import type { MergeReadiness } from '../git/publish.ts';
import type { SecretScanResult } from '../git/secretScan.ts';
import {
  DELIVERY_STEPS,
  type DeliveryRecord,
  type DeliveryStep,
  type DeliveryStepRecord,
  type IssueLinkRecord,
  type RunState,
} from './state.ts';

/**
 * What delivery is allowed to do, decided before anything is done.
 *
 * Every step is the product of two things: the policy, which is the ceiling the
 * user set, and a gate, which is what the world actually permits right now. Both
 * are resolved here, in one pass, with a reason attached to everything that will
 * not run — so the phase that executes this plan never has to decide anything,
 * and the report can say *why* a step did not happen rather than leaving a gap.
 */

/** How far each policy reaches. A step runs only if its rank is within the ceiling. */
const POLICY_RANK: Record<DeliveryPolicy, number> = { none: 0, branch: 1, push: 2, pr: 3, merge: 4 };

const STEP_POLICY: Record<DeliveryStep, DeliveryPolicy> = {
  commit: 'branch',
  push: 'push',
  pullRequest: 'pr',
  merge: 'merge',
};

export interface DeliveryCapabilities {
  /** Remote to push to, or null when the repository has none. */
  remote: string | null;
  /** Whether the GitHub CLI is installed; it owns the credentials, not Relay. */
  gh: boolean;
  /** `owner/name`, when the run knows which repository it belongs to. */
  repoSlug: string | null;
  merge: MergeReadiness;
  protectedBranches?: readonly string[];
  /**
   * Set only when the base branch does not exist yet, which happens when the run
   * started from a repository with no commits: there is nothing to open a pull
   * request into until someone publishes a base.
   */
  baseMissing?: boolean;
  /**
   * What the pre-publish secret scan found, present whenever the policy would
   * take the work off this machine. A finding gates the push (and the merge:
   * a base branch is one `git push` from a remote) and delivery stops at
   * `branch` with the rule and location recorded — never the secret itself.
   * `error` means the scan could not run, which blocks the same way: nothing
   * leaves the machine unscanned.
   */
  secrets?: SecretScanResult | { error: string };
}

export interface PlannedStep {
  step: DeliveryStep;
  run: boolean;
  /** Why it will not run, or what it will do. Always set. */
  reason: string;
}

export function planDelivery(
  state: RunState,
  policy: DeliveryPolicy,
  caps: DeliveryCapabilities,
): PlannedStep[] {
  const ceiling = POLICY_RANK[policy];
  const branch = state.workspace?.branch ?? 'the run branch';
  const base = state.workspace?.baseBranch ?? state.repository.defaultBranch;

  const nothing =
    state.workspace === undefined
      ? 'this run never created a branch'
      : (state.diff?.fileCount ?? 0) === 0 && state.commit === undefined
        ? 'the run changed no files'
        : undefined;

  // What will exist by the end, whether because it already does or because a
  // step above is going to produce it. Dependencies are read from this rather
  // than from position in the list: a merge needs a commit or a pull request,
  // and a repository with no remote can still have the first of those.
  const expected: Record<DeliveryStep, boolean> = {
    commit: state.commit !== undefined,
    push: state.push !== undefined,
    pullRequest: state.pullRequest !== undefined,
    merge: state.merge !== undefined,
  };
  const why: Partial<Record<DeliveryStep, string>> = {};

  const plan: PlannedStep[] = [];
  for (const step of DELIVERY_STEPS) {
    const record = (run: boolean, reason: string): void => {
      plan.push({ step, run, reason });
      why[step] = reason;
      if (run) expected[step] = true;
    };

    const already = alreadyDone(state, step);
    if (already !== undefined) {
      record(false, already);
      continue;
    }
    if (POLICY_RANK[STEP_POLICY[step]] > ceiling) {
      record(false, `not requested (deliver: ${policy})`);
      continue;
    }
    if (nothing !== undefined) {
      record(false, nothing);
      continue;
    }

    const missing = missingDependency(step, expected, why);
    if (missing !== undefined) {
      record(false, missing);
      continue;
    }

    const gate = gateFor(step, state, caps, expected, branch, base);
    if (gate !== undefined) {
      record(false, gate);
      continue;
    }

    record(true, describe(step, caps, expected, branch, base));
  }
  return plan;
}

/**
 * What a step needs to already be true. A dependency that will not happen is
 * reported with the reason it will not, so the last line of a delivery report
 * traces back to the first thing that actually went wrong.
 */
function missingDependency(
  step: DeliveryStep,
  expected: Record<DeliveryStep, boolean>,
  why: Partial<Record<DeliveryStep, string>>,
): string | undefined {
  const because = (dependency: DeliveryStep): string =>
    `no ${labelFor(dependency)}: ${why[dependency] ?? 'it did not run'}`;

  switch (step) {
    case 'commit':
      return undefined;
    case 'push':
      return expected.commit ? undefined : because('commit');
    case 'pullRequest':
      return expected.push ? undefined : because('push');
    case 'merge':
      // Either route will do: GitHub merges the pull request, or Relay merges
      // the commit here. Only a run with neither has nothing to merge.
      return expected.pullRequest || expected.commit ? undefined : because('commit');
  }
}

function alreadyDone(state: RunState, step: DeliveryStep): string | undefined {
  switch (step) {
    case 'commit':
      return state.commit === undefined ? undefined : `already committed as ${state.commit.sha.slice(0, 8)}`;
    case 'push':
      return state.push === undefined ? undefined : `already pushed to ${state.push.remote}`;
    case 'pullRequest':
      return state.pullRequest === undefined ? undefined : `already open: ${state.pullRequest.url}`;
    case 'merge':
      return state.merge === undefined ? undefined : `already merged into ${state.merge.into}`;
  }
}

function gateFor(
  step: DeliveryStep,
  state: RunState,
  caps: DeliveryCapabilities,
  expected: Record<DeliveryStep, boolean>,
  branch: string,
  base: string,
): string | undefined {
  switch (step) {
    case 'commit':
      return undefined;
    case 'push':
      if (caps.remote === null) return 'this repository has no `origin` remote';
      return secretGate(caps.secrets);
    case 'pullRequest':
      if (!caps.gh) return 'the GitHub CLI is not installed';
      if (caps.repoSlug === null) return `${branch} has no GitHub repository to open it against`;
      if (caps.baseMissing === true) return `${base} does not exist yet — ${branch} is this repository's first commit`;
      return undefined;
    case 'merge': {
      // A local merge never leaves the machine, but the base branch it lands on
      // will: a flagged change is stopped here too, for the same reason.
      const secrets = secretGate(caps.secrets);
      if (secrets !== undefined) return secrets;
      if (caps.protectedBranches?.includes(base) === true) return `${base} is a protected branch`;
      if (state.pullRequest !== undefined && state.pullRequest.createdByRun !== true) return 'this run did not create the pull request';
      {
        const blockers = mergeBlockers(state);
        if (blockers.length > 0) return blockers.join('; ');
      }
      // With a pull request in the picture the merge happens on GitHub, and
      // this machine's checkout is irrelevant to it. Only a local merge has to
      // care which branch the user is standing on.
      if (expected.pullRequest) return undefined;
      return caps.merge.ok ? undefined : (caps.merge.reason ?? `${base} cannot be merged into here`);
    }
  }
}

/**
 * Why a flagged change may not be published, as one recorded line: the rule and
 * the location of the first finding — never the matched text. The full list is
 * printed by the phase; the plan's reason is the durable record.
 */
export function secretGate(secrets: DeliveryCapabilities['secrets']): string | undefined {
  if (secrets === undefined) return undefined;
  if ('error' in secrets) return `the secret scan could not run: ${secrets.error}`;
  if (secrets.findings.length === 0) return undefined;

  const first = secrets.findings[0]!;
  const where = first.line === null ? first.file : `${first.file}:${first.line}`;
  const more = secrets.findings.length - 1;
  return `the secret scan matched ${first.rule} in ${where}${more > 0 ? ` (and ${more} more)` : ''}`;
}

/** Whether the merge would be `gh pr merge` rather than a merge in this checkout. */
export function mergesRemotely(caps: DeliveryCapabilities): boolean {
  return caps.gh && caps.remote !== null && caps.repoSlug !== null;
}

function describe(
  step: DeliveryStep,
  caps: DeliveryCapabilities,
  expected: Record<DeliveryStep, boolean>,
  branch: string,
  base: string,
): string {
  switch (step) {
    case 'commit':
      return `commit the work to ${branch}`;
    case 'push':
      return `push ${branch} to ${caps.remote ?? 'origin'}`;
    case 'pullRequest':
      return `open a pull request into ${base}`;
    case 'merge':
      return expected.pullRequest ? `merge the pull request into ${base}` : `merge ${branch} into ${base}`;
  }
}

export function labelFor(step: DeliveryStep): string {
  switch (step) {
    case 'commit':
      return 'commit';
    case 'push':
      return 'push';
    case 'pullRequest':
      return 'pull request';
    case 'merge':
      return 'merge';
  }
}

/**
 * The step that explains why delivery stopped short, if it did.
 *
 * "Already done" and "not requested" are outcomes, not shortfalls — only a step
 * the world refused is worth reporting, and only the first one, because every
 * step after it inherited that same reason.
 */
export function shortfall(delivery: DeliveryRecord | undefined): DeliveryStepRecord | undefined {
  if (delivery === undefined || delivery.reached === delivery.policy) return undefined;

  return delivery.steps.find(
    (record) =>
      record.status === 'failed' ||
      (record.status === 'skipped' &&
        !record.detail.startsWith('already') &&
        !record.detail.startsWith('not requested')),
  );
}

/**
 * Whether the pull request this run opened closes an issue.
 *
 * Not a delivery step: it is one line in a body, it gates nothing, and it can
 * never be the reason a run stopped short. It is recorded the way a skipped step
 * is because it fails the same way — quietly, and identically to success —
 * unless something says out loud that there was no issue to close.
 */
export function issueLinkFor(state: RunState): Omit<IssueLinkRecord, 'at'> | undefined {
  if (state.pullRequest === undefined) return undefined;

  const issue = state.issue;
  if (issue === undefined) return { status: 'skipped', detail: 'this run has no issue' };
  if (issue.number === null) {
    return { status: 'skipped', detail: `${state.issueRef} has no tracker issue to close` };
  }
  return { status: 'done', detail: `closes #${issue.number}` };
}

/**
 * How far the run got, expressed in the same vocabulary as the policy — so
 * "asked for pr, reached push" is one comparison rather than four.
 */
export function reachedPolicy(state: RunState): DeliveryPolicy {
  if (state.merge !== undefined) return 'merge';
  if (state.pullRequest !== undefined) return 'pr';
  if (state.push !== undefined) return 'push';
  if (state.commit !== undefined) return 'branch';
  return 'none';
}

/**
 * Whether a pull request should open as a draft.
 *
 * Delivery is autonomous, which makes this the honest half of it: a change
 * whose tests failed, or that still carries blocking findings nobody answered,
 * is still worth opening — it is the evidence of the run — but it must not
 * arrive looking ready to merge.
 */
export function draftReasons(state: RunState): string[] {
  const reasons: string[] = [];

  if (state.tests?.discovered === true && !state.tests.passed) {
    reasons.push(state.tests.timedOut ? 'the tests timed out' : 'the tests failed');
  }
  if (unresolvedBlockingFindings(state) > 0) {
    const count = unresolvedBlockingFindings(state);
    reasons.push(`${count} blocking review finding(s) were never accepted`);
  }
  if (!state.planApproved && state.config.workflow.plan === 'review') {
    reasons.push('the plan was never approved');
  }
  return reasons;
}

/** Evidence required before Relay is allowed to perform the irreversible step. */
export function mergeBlockers(state: RunState): string[] {
  const reasons: string[] = [];
  if (!(state.tests?.discovered === true && state.tests.passed === true)) {
    reasons.push(state.tests?.discovered === true ? 'the tests failed' : 'tests were not verifiably run');
  }
  if (unresolvedBlockingFindings(state) > 0) reasons.push('blocking review findings remain unresolved');
  if (!state.planApproved && state.config.workflow.plan === 'review') reasons.push('the plan was never approved');
  return reasons;
}

export function resolveCeiling(
  config: RunState['config'],
  flags: { commit?: boolean; push?: boolean; pr?: boolean; merge?: boolean } = {},
): DeliveryPolicy {
  if (flags.commit === true) return 'branch';
  if (flags.merge === true || config.github.autoMerge) return 'merge';
  if (flags.pr === true || config.github.autoPr) return 'pr';
  if (flags.push === true || config.github.autoPush) return 'push';
  return 'branch';
}

/** Blocking code-review findings the implementer did not accept. */
export function unresolvedBlockingFindings(state: RunState): number {
  const profile = reviewProfileOf(state.config);
  let count = 0;
  for (const review of state.reviews) {
    if (review.kind !== 'code') continue;
    for (const finding of review.findings) {
      if (!isBlockingAt(finding, profile)) continue;
      const response = review.responses?.find((entry) => entry.findingId === finding.id);
      if (response?.response !== 'ACCEPT') count += 1;
    }
  }
  return count;
}
