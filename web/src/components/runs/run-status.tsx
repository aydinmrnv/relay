'use client';

import { StatusBadge, STATUS_MEANING } from '@/components/app/status-badge';
import { TextShimmer } from '@/components/21st/text-shimmer';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { Run, RunStatus } from '@/lib/workflow/schema';
import { liveStep } from './run-utils';

/** The status chip, with what the status means on hover or focus. */
export function RunStatusBadge({ status, className }: { status: RunStatus; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn('inline-flex', className)} />}>
        <StatusBadge status={status} />
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64">
        {STATUS_MEANING[status]}
      </TooltipContent>
    </Tooltip>
  );
}

/** What a playing run is doing right now, shimmering so it reads as live. */
export function LiveStep({ run, className }: { run: Run; className?: string }) {
  const step = liveStep(run);
  if (step === null) return null;
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 text-xs', className)} aria-live="polite">
      <TextShimmer as="span" duration={1.8} className="truncate">
        {step}
      </TextShimmer>
    </span>
  );
}
