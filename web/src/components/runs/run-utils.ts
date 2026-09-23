import type { Run, RunEvent, RunStatus } from '@/lib/workflow/schema';
import { formatMs } from '@/lib/workflow/simulate';

/**
 * Small, pure readings of a run shared by the dashboard, the runs list and the
 * run page, so "what is it doing" and "why did it stop" read the same
 * everywhere.
 */

/** Runs that have not reached an outcome yet. */
export function isLive(status: RunStatus): status is 'running' | 'waiting' {
  return status === 'running' || status === 'waiting';
}

/** The ticket title when the trigger carried one, else the trigger's name. */
export function triggerTitle(run: Run): string {
  const title = run.trigger.payload['title'];
  return typeof title === 'string' && title.trim().length > 0 ? title : run.trigger.label;
}

/** The ticket key (ENG-142 and friends), when the payload has one. */
export function triggerKey(run: Run): string | undefined {
  const key = run.trigger.payload['id'] ?? run.trigger.payload['key'];
  return typeof key === 'string' && key.length > 0 ? key : undefined;
}

/**
 * What a playing run is doing right now: the pipeline phase from the latest
 * `phase` event while one is open, otherwise the node that started last.
 */
export function liveStep(run: Run): string | null {
  if (!isLive(run.status)) return null;
  for (let index = run.events.length - 1; index >= 0; index -= 1) {
    const event = run.events[index]!;
    if (event.kind === 'phase') {
      if (event.status === 'running') return event.message;
      break;
    }
    if (event.kind === 'node-finished') break;
    if (event.kind === 'message' && event.status === 'waiting') return event.message;
    if (event.kind === 'node-started') return event.message;
  }
  const started = [...run.events].reverse().find((event) => event.kind === 'node-started');
  return started?.message ?? 'Starting…';
}

/** The pipeline phase playing right now, when one is open. */
export function openPhase(run: Run): string | null {
  if (!isLive(run.status)) return null;
  const last = run.events.findLast((event) => event.kind === 'phase');
  return last?.status === 'running' ? last.message : null;
}

/** Milliseconds of simulated time the run has covered, live or finished. */
export function runDurationMs(run: Run): number {
  const end = run.finishedAt ?? run.events.at(-1)?.at ?? run.startedAt;
  return Math.max(0, new Date(end).getTime() - new Date(run.startedAt).getTime());
}

export function formatRunDuration(run: Run): string {
  const ms = runDurationMs(run);
  return ms === 0 && isLive(run.status) ? '—' : formatMs(ms);
}

/** The event that ended the run badly, when there is one. */
export function stoppingEvent(run: Run): RunEvent | undefined {
  return [...run.events].reverse().find((event) => event.status === 'failed' || event.status === 'refused');
}

/**
 * One sentence on why the run ended the way it did, in the run's own words
 * where possible: the refusal or failure message, the interruption notice, or
 * what it delivered.
 */
export function outcomeReason(run: Run): string {
  switch (run.status) {
    case 'running':
      return liveStep(run) ?? 'Playing now.';
    case 'waiting':
      return 'Paused on a human approval.';
    case 'failed':
    case 'refused':
      return stoppingEvent(run)?.message ?? run.summary ?? 'No reason was recorded.';
    case 'cancelled':
      return run.summary?.startsWith('Interrupted') === true ? run.summary : 'Stopped before it finished; nothing after that point ran.';
    case 'succeeded': {
      if (run.prUrl !== undefined) return `Opened pull request #${prNumber(run.prUrl)} from ${run.branch ?? 'its branch'}.`;
      if (run.branch !== undefined) return `The change is on ${run.branch}.`;
      return 'Every step finished. This workflow has no agent pipeline, so no code was written.';
    }
    default:
      return run.summary ?? '';
  }
}

export function prNumber(url: string): string {
  return url.split('/').pop() ?? '';
}

/** Saves a value as pretty JSON through a temporary link, like any download. */
export function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
