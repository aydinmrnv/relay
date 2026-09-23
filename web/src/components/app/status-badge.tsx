import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { NodeRunStatus, RunStatus } from '@/lib/workflow/schema';

type Status = RunStatus | NodeRunStatus;

const STYLES: Record<Status, { chip: string; dot: string }> = {
  running: { chip: 'border-primary/25 bg-primary/10 text-primary', dot: 'bg-primary animate-pulse' },
  succeeded: { chip: 'border-success/25 bg-success/10 text-success', dot: 'bg-success' },
  done: { chip: 'border-success/25 bg-success/10 text-success', dot: 'bg-success' },
  failed: { chip: 'border-destructive/25 bg-destructive/10 text-destructive', dot: 'bg-destructive' },
  refused: { chip: 'border-warning/30 bg-warning/12 text-amber-700 dark:text-warning', dot: 'bg-warning' },
  cancelled: { chip: 'border-border bg-muted text-muted-foreground', dot: 'bg-muted-foreground/60' },
  waiting: { chip: 'border-info/25 bg-info/10 text-info', dot: 'bg-info animate-pulse' },
  pending: { chip: 'border-border bg-muted text-muted-foreground', dot: 'bg-muted-foreground/40' },
  skipped: { chip: 'border-border bg-transparent text-muted-foreground', dot: 'bg-muted-foreground/30' },
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
  const style = STYLES[status];
  return (
    <Badge variant="outline" className={cn('gap-1.5 font-medium', style.chip, className)}>
      <span className={cn('size-1.5 rounded-full', style.dot)} />
      {LABELS[status]}
    </Badge>
  );
}
