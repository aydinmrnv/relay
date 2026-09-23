import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { NodeRunStatus, RunStatus } from '@/lib/workflow/schema';

const STYLES: Record<RunStatus | NodeRunStatus, string> = {
  running: 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-300',
  succeeded: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  done: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  failed: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-300',
  refused: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  cancelled: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300',
  waiting: 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300',
  pending: 'border-border bg-muted text-muted-foreground',
  skipped: 'border-border bg-transparent text-muted-foreground line-through',
};

const LABELS: Partial<Record<RunStatus | NodeRunStatus, string>> = {
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

export function StatusBadge({ status, className }: { status: RunStatus | NodeRunStatus; className?: string }) {
  return (
    <Badge variant="outline" className={cn('gap-1.5 font-medium', STYLES[status], className)}>
      {status === 'running' ? <span className="size-1.5 animate-pulse rounded-full bg-current" /> : null}
      {LABELS[status] ?? status}
    </Badge>
  );
}
