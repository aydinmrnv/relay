'use client';

import Link from 'next/link';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, ChevronUp, Eraser, ExternalLink, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Progress } from '@/components/ui/progress';
import { StatusBadge, STATUS_MEANING } from '@/components/app/status-badge';
import { HelpTip } from '@/components/app/help-tip';
import { TextShimmer } from '@/components/21st/text-shimmer';
import { RunTimeline } from '@/components/runs/run-timeline';
import type { Run, Workflow } from '@/lib/workflow/schema';
import { formatUsd } from '@/lib/format';

interface Props {
  run: Run | null;
  workflow: Workflow;
  running: boolean;
  open: boolean;
  onToggle: () => void;
  onCancel: () => void;
  onClear: () => void;
}

/** The strip under the canvas: what the last test run did, live while it plays. */
export function RunPanel({ run, workflow, running, open, onToggle, onCancel, onClear }: Props) {
  const statuses = run === null ? [] : Object.values(run.nodeStatus);
  const settled = statuses.filter((status) => status !== 'pending' && status !== 'running').length;
  const progress = statuses.length === 0 ? 0 : Math.round((settled / statuses.length) * 100);
  const phase = run === null ? undefined : [...run.events].reverse().find((event) => event.kind === 'phase' || event.kind === 'node-started');

  return (
    <div className="flex shrink-0 flex-col border-t bg-card">
      <div className="flex h-10 items-center gap-2.5 px-3">
        <button type="button" onClick={onToggle} className="flex items-center gap-1.5 text-xs font-semibold" aria-expanded={open}>
          {open ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          Test run
        </button>
        <HelpTip term="test-run" side="top" />
        {run === null ? (
          <span className="truncate text-xs text-muted-foreground">Press Test run to play this workflow with a sample ticket. It’s free and nothing leaves this browser.</span>
        ) : (
          <>
            <span title={run.status === 'running' ? undefined : STATUS_MEANING[run.status]}>
              <StatusBadge status={run.status} className="h-5" />
            </span>
            {running && phase !== undefined ? (
              <TextShimmer as="span" duration={1.8} className="max-w-72 truncate text-xs">
                {phase.message}
              </TextShimmer>
            ) : (
              <span className="min-w-0 truncate text-xs text-muted-foreground">{String(run.trigger.payload['title'] ?? run.trigger.label)}</span>
            )}
            {running ? <Progress value={progress} className="hidden w-28 md:flex" aria-label="Run progress" /> : null}
            <span className="ml-auto text-xs text-muted-foreground tabular-nums" title="Simulated cost: what the coding CLIs would report">
              {formatUsd(run.costUsd)}
            </span>
            {run.prUrl !== undefined ? (
              <a href={run.prUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                PR #{run.prUrl.split('/').pop()} <ExternalLink className="size-3" />
              </a>
            ) : null}
            {running ? (
              <Button size="xs" variant="outline" onClick={onCancel}>
                <Square data-icon="inline-start" className="fill-current" /> Stop
              </Button>
            ) : (
              <>
                <Button size="xs" variant="ghost" onClick={onClear} title="Remove the run colours from the canvas">
                  <Eraser data-icon="inline-start" /> Clear
                </Button>
                <Button size="xs" variant="outline" nativeButton={false} render={<Link href={`/runs/${run.id}`} />}>
                  Details
                </Button>
              </>
            )}
          </>
        )}
      </div>
      <AnimatePresence initial={false}>
        {open && run !== null ? (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 232, opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 38 }}
            className="overflow-hidden border-t"
          >
            <ScrollArea className="h-[232px]">
              <div className="p-3">
                {!running && run.summary !== undefined ? <p className="mb-3 rounded-lg border bg-muted/30 p-2.5 text-xs leading-relaxed whitespace-pre-line">{run.summary}</p> : null}
                <RunTimeline run={run} workflow={workflow} compact />
              </div>
            </ScrollArea>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
