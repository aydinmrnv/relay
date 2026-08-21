import { isBlockingAt } from '../reviews/level.ts';
import { reviewProfileOf } from '../storage/config.ts';
import { typoize } from '../util/typos.ts';
import { unresolvedBlockingFindings } from './delivery.ts';
import type { RunState } from './state.ts';
import { formatUsage, unpricedTurns, zeroTotals } from './usage.ts';

export function RUN_MARKER(runId: string): string {
  return `<!-- relay-run: ${runId} -->`;
}

export function buildIssueComment(state: RunState): string {
  const diff = state.diff;
  const tests = state.tests;
  const raised = state.reviews.flatMap((review) => review.kind === 'code' ? review.findings : []).filter((finding) => isBlockingAt(finding, reviewProfileOf(state.config))).length;
  const resolved = raised - unresolvedBlockingFindings(state);
  const usage = state.usage?.total ?? zeroTotals();
  const caveat = unpricedTurns(usage) > 0 ? ` (${unpricedTurns(usage)} unpriced turn(s))` : '';
  const text = [
    `Relay completed the work for this issue: ${state.issue?.title ?? state.issueRef}.`,
    `Pull request: ${state.pullRequest?.url ?? 'not created'}`,
    `Diff: ${diff?.fileCount ?? 0} file(s), +${diff?.additions ?? 0}/-${diff?.deletions ?? 0}`,
    `Tests: ${tests === undefined ? 'not run' : tests.skippedReason ?? (tests.passed ? 'passed' : `failed (exit ${tests.exitCode ?? 'unknown'})`)}`,
    `Blocking findings: ${raised} raised, ${resolved} resolved`,
    `Cost: ${formatUsage(usage)}${caveat}`,
  ].join('\n');
  const human = state.config.workflow.typos ? typoize(text, { seed: state.runId }) : text;
  return `${human}\n\n${RUN_MARKER(state.runId)}`;
}
