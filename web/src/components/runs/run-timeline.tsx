'use client';

import { useState } from 'react';
import { motion } from 'motion/react';
import { useCalmMotion } from '@/components/motion/use-calm-motion';
import {
  Ban,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  CircleDollarSign,
  FileText,
  Flag,
  Hourglass,
  Loader2,
  MessageSquare,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { getNodeType } from '@/lib/connectors';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { TextShimmer } from '@/components/21st/text-shimmer';
import type { NodeRunStatus, Run, RunEvent, RunStatus, Workflow } from '@/lib/workflow/schema';
import { formatMs } from '@/lib/workflow/simulate';
import { CompanionError, companionFetch } from '@/lib/companion/client';

/** A node's status as the timeline shows it: `stopped` is a node that was mid-way when the run was cancelled. */
type Shown = NodeRunStatus | RunStatus | 'stopped';

interface Group {
  key: string;
  nodeId: string | null;
  events: RunEvent[];
}

interface Props {
  run: Run;
  workflow?: Workflow;
  /** Dense variant for the builder's run panel: no output blocks, no offsets, no "not reached" list. */
  compact?: boolean;
  className?: string;
}

/**
 * Every node the run touched, in the order it touched them, with what each one
 * said. Updates in place while the run plays; new steps rise in as they arrive.
 */
export function RunTimeline({ run, workflow, compact = false, className }: Props) {
  const reduce = useCalmMotion();
  const nodeById = new Map((workflow?.nodes ?? []).map((node) => [node.id, node]));
  const live = run.status === 'running' || run.status === 'waiting';
  const startedAt = new Date(run.startedAt).getTime();

  // Consecutive events from the same node form one step.
  const groups: Group[] = [];
  for (const event of run.events) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.nodeId === event.nodeId) last.events.push(event);
    else groups.push({ key: `${event.nodeId ?? 'run'}-${groups.length}`, nodeId: event.nodeId, events: [event] });
  }

  // A phase's "started" line is replaced by its "finished" line; only the one still open stays.
  const lastPhaseIndex = run.events.findLastIndex((event) => event.kind === 'phase');
  // Each event's place in the run, looked up once: asking the array per line made a long run quadratic.
  const position = new Map(run.events.map((event, index) => [event, index]));
  const visible = (event: RunEvent): boolean => {
    if (event.kind === 'node-started') return false;
    if (event.kind === 'phase' && event.status === 'running') return position.get(event) === lastPhaseIndex;
    return true;
  };

  // Nodes the run never reached — the branch not taken — explain as much as the ones it did.
  // A stopped run leaves the rest `pending` rather than `skipped`, so both count as not reached.
  const touched = new Set(groups.map((group) => group.nodeId));
  const notReached =
    compact || live
      ? []
      : (workflow?.nodes ?? []).filter((node) => {
          const status = run.nodeStatus[node.id];
          return !touched.has(node.id) && (status === 'skipped' || status === 'pending') && getNodeType(node.data.typeId)?.id !== 'logic.action.note';
        });
  const notReachedWhy = run.status === 'cancelled' ? 'the run was stopped first, or took another branch' : 'the run took another branch';

  if (groups.length === 0) {
    return <p className={cn('text-sm text-muted-foreground', className)}>Waiting for the first step…</p>;
  }

  return (
    <div className={className}>
      <ol className={cn('relative flex flex-col', compact ? 'gap-2' : 'gap-1')}>
        {groups.map((group, index) => {
          const node = group.nodeId === null ? undefined : nodeById.get(group.nodeId);
          const def = node === undefined ? undefined : getNodeType(node.data.typeId);
          const finished = group.events.find((event) => event.kind === 'node-finished');
          const isRunEnd = group.nodeId === null;
          const status = shownStatus(run, group, finished, live);
          const title = isRunEnd
            ? runEndTitle(run.status)
            : (node?.data.label ?? (def === undefined ? (group.events[0]?.message ?? 'Step') : `${def.connector.name} · ${def.name}`));
          const offset = new Date(group.events[0]!.at).getTime() - startedAt;
          const lines = group.events.filter(visible).filter((event) => !(isRunEnd && event.kind === 'run-finished'));
          const endSummary = isRunEnd ? group.events.find((event) => event.kind === 'run-finished')?.detail : undefined;

          return (
            <motion.li
              key={group.key}
              initial={reduce ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="flex gap-3"
            >
              <div className="flex flex-col items-center">
                <span
                  className={cn(
                    'relative flex shrink-0 items-center justify-center rounded-full border bg-card',
                    compact ? 'size-6' : 'size-8',
                    ring(status),
                  )}
                >
                  {def === undefined ? <StatusIcon status={status} /> : <ConnectorIcon connector={def.connector} size={compact ? 12 : 14} variant="mark" />}
                  {status === 'running' || status === 'waiting' ? (
                    <span className="absolute -inset-px animate-ping rounded-full border border-signal/40 motion-reduce:hidden" />
                  ) : null}
                </span>
                {index < groups.length - 1 ? <span className="my-1 w-px flex-1 bg-border" /> : null}
              </div>

              <div className={cn('min-w-0 flex-1', compact ? 'pb-0.5' : 'pb-4')}>
                <div className={cn('flex items-center justify-between gap-2', compact ? 'min-h-6' : 'min-h-8')}>
                  <p className={cn('truncate font-medium', compact ? 'text-xs' : 'text-sm', status === 'skipped' ? 'text-muted-foreground line-through' : '')}>{title}</p>
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
                    {!compact && !isRunEnd ? <span className="hidden text-muted-foreground/70 sm:inline">+{formatMs(offset)}</span> : null}
                    {finished?.durationMs !== undefined ? <span>{formatMs(finished.durationMs)}</span> : null}
                    <StatusIcon status={status} />
                  </span>
                </div>

                {lines.length > 0 || endSummary !== undefined ? (
                  <ul className={cn('flex flex-col', compact ? 'gap-0.5' : 'mt-0.5 gap-1')}>
                    {lines.map((event) => (
                      <EventLine key={`${event.kind}-${position.get(event)}`} event={event} compact={compact} reduce={reduce === true} open={live && event.kind === 'phase' && event.status === 'running'} />
                    ))}
                    {/* A real run holding at a Human approval: the answer goes to the runner it is waiting on. */}
                    {live && group.nodeId !== null && run.nodeStatus[group.nodeId] === 'waiting'
                      ? group.events.filter((event) => event.approvalId !== undefined).slice(-1).map((event) => <ApprovalAnswer key={event.approvalId} approvalId={event.approvalId!} runner={run.machine?.runner ?? 'machine'} />)
                      : null}
                    {endSummary !== undefined && !compact ? <li className="text-xs text-pretty text-muted-foreground">{endSummary}</li> : null}
                  </ul>
                ) : null}
              </div>
            </motion.li>
          );
        })}
      </ol>

      {notReached.length > 0 ? (
        <div className="mt-2 rounded-lg border border-dashed px-3 py-2.5">
          <p className="text-xs font-medium text-muted-foreground">Not reached · {notReachedWhy}</p>
          <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
            {notReached.map((node) => {
              const def = getNodeType(node.data.typeId);
              return (
                <li key={node.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {def === undefined ? <CircleDashed className="size-3" /> : <ConnectorIcon connector={def.connector} size={12} variant="mark" colored={false} />}
                  {node.data.label ?? (def === undefined ? node.id : def.name)}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Yes or no to a run that is waiting on a person. The answer is written on
 * the runner, to the same record `relay workflow approve` writes, and the run
 * carries on within a second of it. A step that names its approvers is
 * answered by name; the name is asked for only then.
 */
function ApprovalAnswer({ approvalId, runner }: { approvalId: string; runner: 'machine' | 'cloud' }) {
  const [busy, setBusy] = useState(false);
  const [as, setAs] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const answer = async (approved: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await companionFetch(`/v1/approvals/${encodeURIComponent(approvalId)}`, { method: 'POST', runner, body: { approved, ...(as === null || as.trim().length === 0 ? {} : { as: as.trim() }) } });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      // Refused for who is asking: the step lists its approvers, so say which of them this is.
      if (caught instanceof CompanionError && caught.status === 403) setAs((current) => current ?? '');
      setError(message);
      setBusy(false);
    }
  };

  return (
    <li className="mt-1 flex flex-col gap-1.5">
      {as === null ? null : (
        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
          Answering as
          <input value={as} onChange={(event) => setAs(event.target.value)} placeholder="your login" className="h-6 w-36 rounded border bg-background px-1.5 text-[11px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50" />
        </label>
      )}
      <div className="flex items-center gap-1.5">
        <button type="button" disabled={busy} onClick={() => void answer(true)} className="h-6 rounded-md bg-foreground px-2 text-[11px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50">
          Approve
        </button>
        <button type="button" disabled={busy} onClick={() => void answer(false)} className="h-6 rounded-md border px-2 text-[11px] font-medium transition-colors hover:bg-muted disabled:opacity-50">
          Reject
        </button>
        {busy ? <Loader2 className="size-3 animate-spin text-muted-foreground" /> : null}
      </div>
      {error === null ? null : <p className="text-[11px] text-pretty text-destructive">{error}</p>}
    </li>
  );
}

function EventLine({ event, compact, reduce, open }: { event: RunEvent; compact: boolean; reduce: boolean; open: boolean }) {
  const bad = event.status === 'failed' || event.status === 'refused';
  const detail = compact ? undefined : event.detail?.trim();
  const long = detail !== undefined && (detail.includes('\n') || detail.length > 140);

  return (
    <motion.li
      initial={reduce ? false : { opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25 }}
      className="flex items-start gap-1.5 text-xs"
    >
      <EventIcon event={event} open={open} />
      <div className="min-w-0 flex-1">
        {open ? (
          <TextShimmer as="span" duration={1.8} className="text-xs">
            {event.message}
          </TextShimmer>
        ) : (
          <span className={cn('text-pretty', bad ? 'text-destructive' : 'text-muted-foreground', compact ? 'line-clamp-1' : '')}>{event.message}</span>
        )}
        {detail === undefined || detail.length === 0 ? null : long ? (
          <details className="group mt-1">
            <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded text-[11px] text-muted-foreground/80 outline-none select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
              Show output · {detail.split('\n').length} {detail.split('\n').length === 1 ? 'line' : 'lines'}
            </summary>
            <pre className="mt-1 max-h-56 overflow-auto rounded-md bg-muted/60 px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">{detail}</pre>
          </details>
        ) : (
          <p className="mt-0.5 text-[11px] text-pretty text-muted-foreground/80">{detail}</p>
        )}
      </div>
    </motion.li>
  );
}

function shownStatus(run: Run, group: Group, finished: RunEvent | undefined, live: boolean): Shown {
  if (group.nodeId === null) return run.status;
  const recorded = run.nodeStatus[group.nodeId];
  const status: NodeRunStatus = finished?.status ?? recorded ?? group.events.at(-1)?.status ?? 'running';
  // The simulator stops mid-node on cancel; that node never finishes, so say so instead of spinning forever.
  if ((status === 'running' || status === 'waiting') && !live) return 'stopped';
  return status;
}

function runEndTitle(status: RunStatus): string {
  switch (status) {
    case 'succeeded':
      return 'Run succeeded';
    case 'failed':
      return 'Run failed';
    case 'refused':
      return 'Run refused';
    case 'cancelled':
      return 'Run stopped';
    case 'waiting':
      return 'Waiting for approval';
    default:
      return 'Run';
  }
}

function ring(status: Shown): string {
  switch (status) {
    case 'done':
    case 'succeeded':
      return 'border-success/45';
    case 'failed':
      return 'border-destructive/55';
    case 'refused':
      return 'border-warning/60';
    case 'running':
    case 'waiting':
      return 'border-signal/60';
    default:
      return 'border-border';
  }
}

function StatusIcon({ status }: { status: Shown }) {
  const cls = 'size-3.5 shrink-0';
  switch (status) {
    case 'done':
    case 'succeeded':
      return <CheckCircle2 className={cn(cls, 'text-success')} aria-label="Done" />;
    case 'failed':
      return <XCircle className={cn(cls, 'text-destructive')} aria-label="Failed" />;
    case 'refused':
      return <ShieldAlert className={cn(cls, 'text-amber-600 dark:text-warning')} aria-label="Refused" />;
    case 'running':
      return <Loader2 className={cn(cls, 'animate-spin text-signal')} aria-label="Running" />;
    case 'waiting':
      return <Hourglass className={cn(cls, 'text-signal')} aria-label="Waiting" />;
    case 'stopped':
    case 'cancelled':
      return <Ban className={cn(cls, 'text-muted-foreground')} aria-label="Stopped" />;
    default:
      return <CircleDashed className={cn(cls, 'text-muted-foreground')} aria-label="Skipped" />;
  }
}

function EventIcon({ event, open }: { event: RunEvent; open: boolean }) {
  const cls = 'mt-0.5 size-3 shrink-0 text-muted-foreground';
  switch (event.kind) {
    case 'phase':
      if (open) return <Loader2 className={cn(cls, 'animate-spin text-signal')} />;
      if (event.status === 'running') return <Ban className={cls} />;
      return event.status === 'failed' ? <XCircle className={cn(cls, 'text-destructive')} /> : <CheckCircle2 className={cn(cls, 'text-success')} />;
    case 'cost':
      return <CircleDollarSign className={cn(cls, event.status === 'failed' ? 'text-destructive' : '')} />;
    case 'artifact':
      return <FileText className={cls} />;
    case 'message':
      return <MessageSquare className={cls} />;
    case 'run-finished':
      return <Flag className={cls} />;
    case 'node-finished':
      if (event.status === 'refused') return <ShieldAlert className={cn(cls, 'text-amber-600 dark:text-warning')} />;
      if (event.status === 'failed') return <XCircle className={cn(cls, 'text-destructive')} />;
      if (event.status === 'skipped') return <CircleDashed className={cls} />;
      return <CheckCircle2 className={cn(cls, 'text-success')} />;
    default:
      return <CircleDashed className={cls} />;
  }
}
