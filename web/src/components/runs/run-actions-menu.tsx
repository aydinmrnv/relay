'use client';

import { useRouter } from 'next/navigation';
import { ExternalLink, MoreHorizontal, PanelRightOpen, RotateCcw, Square, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { canCancel, cancelRun } from '@/lib/run-launcher';
import type { Run } from '@/lib/workflow/schema';
import { cn } from '@/lib/utils';
import { isLive, prNumber } from './run-utils';
import { useRunAgain } from './use-run-again';

interface Props {
  run: Run;
  /** False when the run's workflow was deleted, so there is nothing to play again. */
  workflowExists: boolean;
  onDelete: () => void;
  className?: string;
}

/** Everything you can do to one run, from a row in a list. */
export function RunActionsMenu({ run, workflowExists, onDelete, className }: Props) {
  const router = useRouter();
  const runAgain = useRunAgain();
  // Gated on status as well: the launcher's controller map is not reactive,
  // but the run's status is, so the item disappears the moment it finishes.
  const cancellable = isLive(run.status) && canCancel(run.id);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for run ${run.shortId}`} className={cn('text-muted-foreground', className)} />}
        onClick={(event) => event.stopPropagation()}
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      {/* The menu is portalled, but React still bubbles its clicks to the row; stop them here. */}
      <DropdownMenuContent align="end" className="w-60" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuItem onClick={() => router.push(`/runs/${run.id}`)}>
          <PanelRightOpen /> Open run
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!workflowExists} onClick={() => runAgain(run.workflowId, { payload: run.trigger.payload })}>
          <RotateCcw />
          <span className="flex flex-col">
            Run again
            <span className="text-xs text-muted-foreground">{workflowExists ? 'Same ticket, current version of the workflow' : 'Its workflow was deleted'}</span>
          </span>
        </DropdownMenuItem>
        {run.prUrl !== undefined ? (
          <DropdownMenuItem onClick={() => window.open(run.prUrl, '_blank', 'noopener,noreferrer')}>
            <ExternalLink />
            <span className="flex flex-col">
              Open pull request #{prNumber(run.prUrl)}
              <span className="text-xs text-muted-foreground">{run.source === 'machine' ? `Opened by the run on ${run.machine?.host ?? 'your machine'}` : 'Simulated: the number is made up'}</span>
            </span>
          </DropdownMenuItem>
        ) : null}
        {cancellable ? (
          <DropdownMenuItem onClick={() => cancelRun(run.id)}>
            <Square /> Stop this run
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onDelete}>
          <Trash2 /> Delete run…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
