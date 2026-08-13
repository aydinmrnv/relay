import { jsonDocument, type JsonDocument } from '../cli/json.ts';
import { usageToJson, type RunUsageJson } from '../cli/runJson.ts';
import { isTerminal, type Phase } from '../workflow/phases.ts';
import type { RunState } from '../workflow/state.ts';
import { phaseTimings } from '../workflow/timeline.ts';
import { formatUsage, unpricedTurns } from '../workflow/usage.ts';

export interface WebhookPayloadBody {
  runId: string;
  shortId: string;
  issue: { id: string | null; number: number | null; title: string; url: string; state: string } | null;
  outcome: { phase: Phase; terminal: boolean; stopped?: string; error?: string; stoppedIn?: Phase };
  phases: Array<{ phase: Phase; ms: number; visits: number }>;
  rounds: RunState['rounds'];
  diff: { fileCount: number; additions: number; deletions: number } | null;
  tests: { discovered: boolean; command: string[]; passed: boolean; exitCode: number | null; durationMs: number; timedOut: boolean; skippedReason: string | null } | null;
  cost: { usage: RunUsageJson | null; formatted: string | null; unpricedTurns: number };
  delivery: null | { policy: string; reached: string; steps: Array<{ step: string; status: string; detail: string }>; comment: { status: string; detail: string } | null };
  pullRequestUrl: string | null;
}

export type WebhookPayload = JsonDocument<WebhookPayloadBody>;

export function buildWebhookPayload(state: RunState): WebhookPayload {
  const stoppedIn = state.error?.phase ?? [...state.history].reverse().find((entry) => !isTerminal(entry.phase))?.phase;
  const usage = state.usage;
  return jsonDocument('notify', {
    runId: state.runId,
    shortId: state.shortId,
    issue: state.issue === undefined ? null : { id: state.issue.id ?? null, number: state.issue.number, title: state.issue.title, url: state.issue.url, state: state.issue.state },
    outcome: {
      phase: state.phase,
      terminal: isTerminal(state.phase),
      ...(state.stopped === undefined ? {} : { stopped: state.stopped.detail }),
      ...(state.error === undefined ? {} : { error: state.error.message }),
      ...(stoppedIn === undefined ? {} : { stoppedIn }),
    },
    phases: phaseTimings(state),
    rounds: { ...state.rounds },
    diff: state.diff === undefined ? null : { fileCount: state.diff.fileCount, additions: state.diff.additions, deletions: state.diff.deletions },
    tests: state.tests === undefined ? null : { discovered: state.tests.discovered, command: state.tests.command, passed: state.tests.passed, exitCode: state.tests.exitCode, durationMs: state.tests.durationMs, timedOut: state.tests.timedOut, skippedReason: state.tests.skippedReason ?? null },
    cost: { usage: usage === undefined ? null : usageToJson(usage), formatted: usage === undefined ? null : formatUsage(usage.total), unpricedTurns: usage === undefined ? 0 : unpricedTurns(usage.total) },
    delivery: state.delivery === undefined ? null : { policy: state.delivery.policy, reached: state.delivery.reached, steps: state.delivery.steps.map(({ step, status, detail }) => ({ step, status, detail })), comment: state.delivery.comment === undefined ? null : { status: state.delivery.comment.status, detail: state.delivery.comment.detail } },
    pullRequestUrl: state.pullRequest?.url ?? null,
  });
}
