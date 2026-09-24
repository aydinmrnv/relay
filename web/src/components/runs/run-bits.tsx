'use client';

import { GitBranch, GitPullRequest, Laptop, ShieldAlert, XCircle } from 'lucide-react';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { getConnector } from '@/lib/connectors';
import { formatDateTime, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { MachineRunInfo, Run } from '@/lib/workflow/schema';
import { CopyButton } from './copy-button';
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
        title={run.source === 'machine' ? `Opened by the run on ${run.machine?.host ?? 'your machine'}` : 'Simulated pull request: the number is made up, so GitHub will not find it'}
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

/** "Real, on this machine" — for the runs that were not played back. Nothing for a test run, which is the default. */
export function RunSourceBadge({ run, className }: { run: Run; className?: string }) {
  if (run.source !== 'machine') return null;
  return (
    <Badge variant="outline" className={cn('h-5 gap-1 border-primary/30 bg-primary/8 text-[10px] font-medium text-primary', className)} title={`Ran for real on ${run.machine?.host ?? 'your machine'}${run.machine?.repository ? `, in ${run.machine.repository}` : ''}`}>
      <Laptop className="size-3" aria-hidden /> {run.machine?.host ?? 'Your machine'}
    </Badge>
  );
}

/** Where a machine run's full record lives, as the commands that read it. */
export function MachineRunCard({ machine }: { machine: MachineRunInfo }) {
  const commands = machine.runId === null ? [] : [`relay status ${machine.runId}`, `relay diff ${machine.runId}`, `relay plan ${machine.runId}`, `relay logs ${machine.runId}`];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Laptop className="size-4 text-muted-foreground" aria-hidden /> On {machine.host}
        </CardTitle>
        <CardDescription className="text-pretty">
          {machine.task.kind === 'issue' ? `Issue ${machine.task.ref}` : 'A described task'}
          {machine.repository === null ? '' : `, in ${machine.repository}`}. The engine keeps the plan, every review, the patches and the event log there{machine.runId === null ? ', but it stopped before naming the run.' : ':'}
        </CardDescription>
      </CardHeader>
      {commands.length === 0 ? null : (
        <CardContent className="grid gap-1.5">
          {commands.map((command) => (
            <span key={command} className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 py-1 pr-1 pl-2.5 font-mono text-xs">
              <span className="truncate">{command}</span>
              <CopyButton value={command} label={`Copy: ${command}`} />
            </span>
          ))}
        </CardContent>
      )}
    </Card>
  );
}
