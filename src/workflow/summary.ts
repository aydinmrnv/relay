import { formatFindingLine, type ReviewRound } from '../reviews/types.ts';
import { formatDuration } from '../util/text.ts';
import { phaseLabel } from './phases.ts';
import type { RunState } from './state.ts';

/**
 * Renders `summary.md`: the record of what each agent decided and why. It is
 * built from persisted state, never from an agent's self-report.
 */
export function renderSummary(state: RunState): string {
  const lines: string[] = [];
  const issue = state.issue;

  lines.push(`# Relay run ${state.runId}`);
  lines.push('');
  if (issue !== undefined) {
    lines.push(`**Issue #${issue.number}** — ${issue.title}`);
    lines.push('');
    lines.push(issue.url);
    lines.push('');
  }

  lines.push(`- Status: **${phaseLabel(state.phase)}**`);
  if (state.workspace !== undefined) {
    lines.push(`- Branch: \`${state.workspace.branch}\` (from \`${state.workspace.baseBranch}\` @ ${state.workspace.baseSha.slice(0, 8)})`);
    lines.push(`- Worktree: \`${state.workspace.path}\``);
  }
  lines.push(
    `- Agents: planner=${state.config.agents.planner}, plan reviewer=${state.config.agents.planReviewer}, ` +
      `implementer=${state.config.agents.implementer}, code reviewer=${state.config.agents.codeReviewer}`,
  );
  const elapsed = new Date(state.finishedAt ?? state.updatedAt).getTime() - new Date(state.createdAt).getTime();
  if (Number.isFinite(elapsed) && elapsed > 0) lines.push(`- Duration: ${formatDuration(elapsed)}`);
  lines.push('');

  if (state.error !== undefined) {
    lines.push('## Failure');
    lines.push('');
    lines.push(`Failed during **${phaseLabel(state.error.phase)}**: ${state.error.message}`);
    lines.push('');
  }

  lines.push('## Outcome');
  lines.push('');
  lines.push(`- Plan review rounds: ${state.rounds.planReview} (plan ${state.planApproved ? 'approved' : 'not approved'})`);
  lines.push(`- Code review rounds: ${state.rounds.codeReview}`);

  if (state.diff !== undefined) {
    lines.push(`- Changes: ${state.diff.fileCount} file(s), +${state.diff.additions} −${state.diff.deletions}`);
  } else {
    lines.push('- Changes: none recorded');
  }

  if (state.tests !== undefined) {
    if (!state.tests.discovered) {
      lines.push(`- Tests: not run (${state.tests.skippedReason ?? state.tests.reason})`);
    } else {
      lines.push(
        `- Tests: \`${state.tests.command.join(' ')}\` → ${state.tests.passed ? 'passed' : `FAILED (exit ${String(state.tests.exitCode)})`}` +
          ` in ${formatDuration(state.tests.durationMs)}`,
      );
    }
  }
  lines.push('');

  if (state.diff !== undefined && state.diff.files.length > 0) {
    lines.push('## Files changed');
    lines.push('');
    for (const file of state.diff.files.slice(0, 60)) lines.push(`- \`${file}\``);
    if (state.diff.files.length > 60) lines.push(`- … and ${state.diff.files.length - 60} more`);
    lines.push('');
  }

  const planReviews = state.reviews.filter((review) => review.kind === 'plan');
  if (planReviews.length > 0) {
    lines.push('## Plan review');
    lines.push('');
    for (const review of planReviews) lines.push(...renderRound(review));
  }

  const codeReviews = state.reviews.filter((review) => review.kind === 'code');
  if (codeReviews.length > 0) {
    lines.push('## Code review');
    lines.push('');
    for (const review of codeReviews) lines.push(...renderRound(review));
  }

  const unresolved = collectUnresolved(state);
  if (unresolved.length > 0) {
    lines.push('## Unresolved findings');
    lines.push('');
    lines.push('These were raised but not addressed in this run:');
    lines.push('');
    for (const finding of unresolved) lines.push(`- ${formatFindingLine(finding)}`);
    lines.push('');
  }

  lines.push('## Next steps');
  lines.push('');
  lines.push('Relay does not push, merge, or open pull requests. The work is on its branch only.');
  lines.push('');
  if (state.workspace !== undefined) {
    lines.push('```bash');
    lines.push(`relay diff ${state.runId}          # review the full diff`);
    lines.push(`cd ${state.workspace.path}`);
    lines.push(`git log --oneline ${state.workspace.baseBranch}..HEAD`);
    lines.push('```');
  }

  return `${lines.join('\n')}\n`;
}

function renderRound(review: ReviewRound): string[] {
  const lines: string[] = [];
  lines.push(`### Round ${review.round} — ${review.reviewer} → ${review.decision}`);
  lines.push('');
  if (review.summary !== undefined) {
    lines.push(review.summary);
    lines.push('');
  }

  if (review.findings.length === 0) {
    lines.push('_No findings._');
    lines.push('');
    return lines;
  }

  for (const finding of review.findings) {
    const response = review.responses?.find((entry) => entry.findingId === finding.id);
    const verdict = response === undefined ? '' : ` → **${response.response}**`;
    lines.push(`- ${formatFindingLine(finding)}${verdict}`);
    if (response !== undefined && response.reasoning.length > 0) {
      lines.push(`  - ${response.reasoning}`);
    }
  }
  lines.push('');
  return lines;
}

/**
 * Every finding the implementer or planner did not accept. This deliberately
 * includes non-blocking code findings, which are never routed back to an agent
 * automatically — reporting them here is the only place they reach the user.
 */
function collectUnresolved(state: RunState): ReviewRound['findings'] {
  const unresolved: ReviewRound['findings'] = [];
  for (const review of state.reviews) {
    for (const finding of review.findings) {
      const response = review.responses?.find((entry) => entry.findingId === finding.id);
      if (response?.response === 'ACCEPT') continue;
      unresolved.push(finding);
    }
  }
  return unresolved;
}
