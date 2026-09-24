'use client';

import { GitBranch, GitPullRequest, ShieldAlert, XCircle } from 'lucide-react';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getConnector } from '@/lib/connectors';
import { formatDateTime, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Run } from '@/lib/workflow/schema';
import { LiveStep } from './run-status';
import { isLive, outcomeReason, prNumber, triggerKey, triggerTitle } from './run-utils';

/** Which app started the run, and the ticket it carried. */
export function RunTrigger({ run, className }: { run: Run; className?: string }) {
  const connector = getConnector(run.trigger.connectorId);
  const key = triggerKey(run);
  return (
    <span className={cn('flex min-w-0 items-center gap-2 text-sm text-muted-foreground', className)} title={`${run.trigger.label}: ${triggerTitle(run)}`}>
      {connector === undefined ? null : <ConnectorIcon connector={connector} size={14} variant="mark" className="shrink-0" />}
      {key === undefined ? null : <span className="shrink-0 font-mono text-xs">{key}</span>}
      <span className="truncate">{triggerTitle(run)}</span>
    </span>
  );
}

/**
 * What the run produced, in one line: live progress while it plays, the pull
 * request or branch when it delivered, and the reason when it did not.
 */
export function RunResult({ run, linkPr = true, className }: { run: Run; /** False inside another link, where a nested anchor is not allowed. */ linkPr?: boolean; className?: string }) {
  if (isLive(run.status)) return <LiveStep run={run} className={cn('max-w-64', className)} />;
  if (run.prUrl !== undefined && !linkPr) {
    return (
      <span className={cn('inline-flex items-center gap-1.5 text-sm font-medium text-primary', className)}>
        <GitPullRequest className="size-3.5" /> PR #{prNumber(run.prUrl)}
      </span>
    );
  }
  if (run.prUrl !== undefined) {
    return (
      <a
        href={run.prUrl}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => event.stopPropagation()}
        title="Simulated pull request: the number is made up, so GitHub will not find it"
        className={cn('inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline', className)}
      >
        <GitPullRequest className="size-3.5" /> PR #{prNumber(run.prUrl)}
      </a>
    );
  }
  if (run.status === 'failed' || run.status === 'refused') {
    const Icon = run.status === 'failed' ? XCircle : ShieldAlert;
    const reason = outcomeReason(run);
    return (
      <span className={cn('flex min-w-0 max-w-72 items-center gap-1.5 text-xs text-muted-foreground', className)} title={reason}>
        <Icon className={cn('size-3.5 shrink-0', run.status === 'failed' ? 'text-destructive' : 'text-amber-600 dark:text-warning')} />
        <span className="truncate">{reason}</span>
      </span>
    );
  }
  if (run.branch !== undefined) {
    return (
      <span className={cn('flex min-w-0 max-w-64 items-center gap-1.5 text-xs text-muted-foreground', className)} title={run.branch}>
        <GitBranch className="size-3.5 shrink-0" />
        <span className="truncate font-mono">{run.branch}</span>
      </span>
    );
  }
  return <span className={cn('text-sm text-muted-foreground', className)}>—</span>;
}

/** Relative start time, with the exact one on hover. */
export function StartedAt({ iso, now, className }: { iso: string; now: number; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn('whitespace-nowrap', className)} />}>{timeAgo(iso, now)}</TooltipTrigger>
      <TooltipContent>{formatDateTime(iso)}</TooltipContent>
    </Tooltip>
  );
}
