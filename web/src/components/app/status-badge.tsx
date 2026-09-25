import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { NodeRunStatus, RunStatus } from '@/lib/workflow/schema';

type Status = RunStatus | NodeRunStatus;

/**
 * Colour is kept for what needs a look: a run that is live (signal), one that
 * failed, and one a guardrail refused. Finishing normally is the common case,
 * so it reads in plain ink rather than competing with those.
 */
const STYLES: Record<Status, string> = {
  running: 'border-signal/30 bg-signal/10 text-signal',
  succeeded: 'border-border text-foreground',
  done: 'border-border text-foreground',
  failed: 'border-destructive/25 bg-destructive/10 text-destructive',
  refused: 'border-warning/35 bg-warning/12 text-amber-700 dark:text-warning',
  cancelled: 'border-border bg-muted text-muted-foreground',
  waiting: 'border-signal/30 bg-signal/10 text-signal',
  pending: 'border-border bg-muted text-muted-foreground',
  skipped: 'border-border bg-transparent text-muted-foreground',
};

const LABELS: Record<Status, string> = {
  running: 'Running',
  succeeded: 'Succeeded',
  done: 'Done',
  failed: 'Failed',
  refused: 'Refused',
  cancelled: 'Cancelled',
  waiting: 'Waiting',
  pending: 'Pending',
  skipped: 'Skipped',
};

/** What each run status means, for tooltips and the guide. */
export const STATUS_MEANING: Record<RunStatus, string> = {
  running: 'Playing right now.',
  succeeded: 'Every node that ran finished, and the pipeline delivered.',
  failed: 'A node failed — usually the tests, or an agent that could not finish.',
  refused: 'A guardrail said no before any money was spent: budget, allowlist, approval or kill switch.',
  cancelled: 'Stopped by you, or interrupted by closing the tab.',
  waiting: 'Paused on a human approval or a wait step.',
};

export function StatusBadge({ status, className }: { status: Status; className?: string }) {
  return (
    <Badge variant="outline" className={cn('font-medium', STYLES[status], className)}>
      {LABELS[status]}
    </Badge>
  );
}
