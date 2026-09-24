'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useState } from 'react';
import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  Download,
  ExternalLink,
  FileDiff,
  FlaskConical,
  GitBranch,
  Hourglass,
  LayoutDashboard,
  MoreHorizontal,
  RotateCcw,
  SearchX,
  ShieldAlert,
  Square,
  Trash2,
  Workflow as WorkflowIcon,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { HelpTip } from '@/components/app/help-tip';
import { STATUS_MEANING } from '@/components/app/status-badge';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { FadeIn, Stagger, StaggerItem } from '@/components/motion/fade-in';
import { CopyButton } from '@/components/runs/copy-button';
import { PhaseList } from '@/components/runs/phase-list';
import { MachineRunCard, RunSourceBadge, StartedAt } from '@/components/runs/run-bits';
import { DeleteRunDialog } from '@/components/runs/run-dialogs';
import { LiveStep, RunStatusBadge } from '@/components/runs/run-status';
import { RunTimeline } from '@/components/runs/run-timeline';
import { downloadJson, formatRunDuration, isLive, openPhase, outcomeReason, prNumber, triggerKey, triggerTitle } from '@/components/runs/run-utils';
import { useRunAgain } from '@/components/runs/use-run-again';
import { useNow } from '@/hooks/use-now';
import { getConnector } from '@/lib/connectors';
import { formatUsd } from '@/lib/format';
import { canCancel, cancelRun } from '@/lib/run-launcher';
import { useStudio } from '@/lib/store';
import { cn } from '@/lib/utils';
import type { Run, RunStatus } from '@/lib/workflow/schema';
import { formatMs } from '@/lib/workflow/simulate';

export default function RunDetailPage({ params }: PageProps<'/runs/[id]'>) {
  const { id } = use(params);
  const router = useRouter();
  const now = useNow();
  const run = useStudio((state) => state.runs.find((candidate) => candidate.id === id));
  const workflow = useStudio((state) => (run === undefined ? undefined : state.workflows[run.workflowId]));
  const hydrated = useStudio((state) => state.hydrated);
  const speed = useStudio((state) => state.settings.simulationSpeed);
  const runAgain = useRunAgain();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);

  if (!hydrated || leaving) return null;
  if (run === undefined) return <RunNotFound />;

  const live = isLive(run.status);
  const machine = run.source === 'machine' ? run.machine : undefined;
  // Gated on status too: the launcher's controller map is not reactive, the run's status is.
  const cancellable = live && canCancel(run.id);
  const connector = getConnector(run.trigger.connectorId);
  const key = triggerKey(run);
  const payload = JSON.stringify(run.trigger.payload, null, 2);
  const fieldCount = Object.keys(run.trigger.payload).length;

  const stop = () => {
    if (cancelRun(run.id)) toast('Stopping the run', { description: 'It finishes the step it is on and records what happened so far.' });
  };

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <FadeIn className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="flex min-w-0 items-start gap-3">
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" nativeButton={false} render={<Link href="/runs" />} aria-label="Back to all runs" className="mt-0.5" />}>
              <ArrowLeft />
            </TooltipTrigger>
            <TooltipContent>All runs</TooltipContent>
          </Tooltip>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <h1 className="truncate text-2xl font-semibold tracking-tight">{run.workflowName}</h1>
              <RunStatusBadge status={run.status} />
              <span className="font-mono text-xs text-muted-foreground">{run.shortId}</span>
            </div>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              <span className="flex min-w-0 items-center gap-1.5">
                {connector === undefined ? null : <ConnectorIcon connector={connector} size={14} variant="mark" />}
                {run.trigger.label}
              </span>
              {machine === undefined ? null : (
                <>
                  <span aria-hidden>·</span>
                  <RunSourceBadge run={run} />
                </>
              )}
              <span aria-hidden>·</span>
              <span>
                started <StartedAt iso={run.startedAt} now={now} className="text-foreground" />
              </span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">{live ? `${formatRunDuration(run)} so far` : `took ${formatRunDuration(run)}`}</span>
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {cancellable ? (
            <Button variant="destructive" onClick={stop}>
              <Square data-icon="inline-start" /> Stop run
            </Button>
          ) : null}
          {workflow !== undefined ? (
            <Tooltip>
              <TooltipTrigger render={<Button variant={live ? 'outline' : 'default'} onClick={() => runAgain(workflow.id, { payload: run.trigger.payload, navigate: true })} />}>
                <RotateCcw data-icon="inline-start" /> Run again
              </TooltipTrigger>
              <TooltipContent className="max-w-64">
                Plays the current version of {workflow.name} with the same ticket as a test run. Free; nothing is called.{machine === undefined ? '' : ' To run it for real again, use Run on this machine in the builder.'}
              </TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger render={<span tabIndex={0} className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/50" />}>
                <Button disabled>
                  <RotateCcw data-icon="inline-start" /> Run again
                </Button>
              </TooltipTrigger>
              <TooltipContent>Its workflow was deleted, so there is nothing to play.</TooltipContent>
            </Tooltip>
          )}
          {workflow !== undefined ? (
            <Button variant="outline" nativeButton={false} render={<Link href={`/workflows/${workflow.id}`} />}>
              <WorkflowIcon data-icon="inline-start" /> Open workflow
            </Button>
          ) : null}
          {run.prUrl !== undefined ? (
            <Tooltip>
              <TooltipTrigger render={<Button variant="outline" nativeButton={false} render={<a href={run.prUrl} target="_blank" rel="noreferrer" />} />}>
                PR #{prNumber(run.prUrl)} <ExternalLink data-icon="inline-end" />
              </TooltipTrigger>
              <TooltipContent className="max-w-64">{machine === undefined ? 'Simulated: the test run made this number up, so GitHub will not find it.' : `Opened by the run on ${machine.host}.`}</TooltipContent>
            </Tooltip>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="More actions" />}>
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={() => downloadJson(`run-${run.shortId}.json`, run)}>
                <Download /> Download run JSON
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2 /> Delete run…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </FadeIn>

      <FadeIn delay={0.04}>
        <Outcome run={run} speed={speed} />
      </FadeIn>

      <Stagger className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StaggerItem>
          <Fact
            icon={<CircleDollarSign />}
            label="Cost"
            help={<HelpTip term="cost" />}
            value={formatUsd(run.costUsd)}
            hint={
              live
                ? `Counting as it plays · ${run.phases.length} ${run.phases.length === 1 ? 'phase' : 'phases'} so far`
                : run.phases.length === 0 && run.costUsd === 0
                  ? 'No agent work, so nothing to pay for'
                  : `${machine === undefined ? 'Simulated' : 'Reported by the CLIs'} · ${run.phases.length} ${run.phases.length === 1 ? 'phase' : 'phases'}`
            }
          />
        </StaggerItem>
        <StaggerItem>
          <Fact
            icon={<FileDiff />}
            label="Diff"
            value={
              run.diff === undefined ? (
                '—'
              ) : (
                <span>
                  <span className="text-success">+{run.diff.additions}</span> <span className="text-destructive">−{run.diff.deletions}</span>
                </span>
              )
            }
            hint={run.diff === undefined ? (live ? 'Nothing written yet' : 'No code was written') : `${run.diff.files} files · ${machine === undefined ? 'simulated, ' : ''}counted from git`}
          />
        </StaggerItem>
        <StaggerItem>
          <Fact
            icon={run.tests === undefined ? <FlaskConical /> : run.tests.passed ? <CheckCircle2 className="text-success" /> : <XCircle className="text-destructive" />}
            label="Tests"
            value={run.tests === undefined ? (live ? 'Pending' : 'Not run') : run.tests.passed ? 'Passed' : 'Failed'}
            hint={run.tests === undefined ? (live ? 'Not reached yet' : 'The pipeline did not reach the test phase') : `${run.tests.command} · ${formatMs(run.tests.durationMs)}${machine === undefined ? ' · simulated' : ''}`}
          />
        </StaggerItem>
        <StaggerItem>
          <Fact
            icon={<GitBranch />}
            label={run.prUrl !== undefined ? 'Pull request' : 'Branch'}
            value={run.prUrl !== undefined ? `#${prNumber(run.prUrl)}` : (run.branch ?? '—')}
            hint={
              run.prUrl !== undefined
                ? (run.branch ?? 'opened')
                : run.branch !== undefined
                  ? live
                    ? 'The work in progress lives here'
                    : 'Committed, not published'
                  : live
                    ? 'Not created yet'
                    : 'No branch was created'
            }
            mono={run.prUrl === undefined && run.branch !== undefined}
          />
        </StaggerItem>
      </Stagger>

      <div className="grid items-start gap-6 lg:grid-cols-5">
        <FadeIn delay={0.08} className="lg:col-span-3">
          <Card>
            <CardHeader>
              <CardTitle>Timeline</CardTitle>
              <CardDescription>
                Every node the run touched, in order, with what it did. {live ? 'Updating live.' : machine === undefined ? 'Offsets are simulated time since the start.' : 'Offsets are time since the start.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <RunTimeline run={run} workflow={workflow} />
            </CardContent>
          </Card>
        </FadeIn>

        <FadeIn delay={0.12} className="flex flex-col gap-6 lg:col-span-2">
          {machine === undefined ? null : <MachineRunCard machine={machine} />}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                Pipeline phases <HelpTip term="phase" />
              </CardTitle>
              <CardDescription>
                {run.phases.length > 0 || openPhase(run) !== null
                  ? machine === undefined
                    ? 'Where the time and money went, agent by agent. Simulated from realistic ranges.'
                    : 'Where the time and money went, agent by agent, as the coding CLIs reported it.'
                  : live
                    ? 'Phases appear here as the pipeline reaches them.'
                    : run.status === 'cancelled'
                      ? 'The run was stopped before the pipeline finished a phase.'
                      : 'The agent pipeline did not run: this workflow has none, or a gate stopped the run before it.'}
              </CardDescription>
            </CardHeader>
            {run.phases.length > 0 || openPhase(run) !== null ? (
              <CardContent>
                <PhaseList phases={run.phases} current={openPhase(run)} />
              </CardContent>
            ) : null}
          </Card>

          <Collapsible render={<Card />}>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                Trigger payload <HelpTip term="trigger" />
              </CardTitle>
              <CardDescription className="truncate">{key === undefined ? triggerTitle(run) : `${key} · ${triggerTitle(run)}`}</CardDescription>
              <CardAction>
                <CopyButton value={payload} label="Copy payload JSON" />
              </CardAction>
            </CardHeader>
            <CardContent>
              <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-md text-left text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
                <ChevronRight className="size-3.5 transition-transform group-data-panel-open:rotate-90" />
                <span className="group-data-panel-open:hidden">Show the {fieldCount} fields the trigger handed over</span>
                <span className="hidden group-data-panel-open:inline">Hide payload</span>
              </CollapsibleTrigger>
              <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out data-ending-style:h-0 data-starting-style:h-0">
                <pre className="mt-3 max-h-80 overflow-auto rounded-lg bg-muted/60 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{payload}</pre>
              </CollapsibleContent>
            </CardContent>
          </Collapsible>
        </FadeIn>
      </div>

      <DeleteRunDialog
        run={run}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={() => {
          setLeaving(true);
          toast.success(`Deleted run ${run.shortId}`);
          router.push('/runs');
        }}
      />
    </div>
  );
}

const OUTCOME_STYLE: Record<RunStatus, { box: string; icon: React.ReactNode; title: string }> = {
  running: { box: 'border-primary/25 bg-primary/5', icon: <span className="size-2 animate-pulse rounded-full bg-primary" />, title: 'Playing now' },
  waiting: { box: 'border-info/25 bg-info/5', icon: <Hourglass className="size-4 text-info" />, title: 'Waiting' },
  succeeded: { box: 'border-success/25 bg-success/5', icon: <CheckCircle2 className="size-4 text-success" />, title: 'Succeeded' },
  failed: { box: 'border-destructive/25 bg-destructive/5', icon: <XCircle className="size-4 text-destructive" />, title: 'Failed' },
  refused: { box: 'border-warning/35 bg-warning/8', icon: <ShieldAlert className="size-4 text-amber-600 dark:text-warning" />, title: 'Refused' },
  cancelled: { box: 'border-border bg-muted/40', icon: <Ban className="size-4 text-muted-foreground" />, title: 'Stopped' },
};

/** The outcome in words: what the status means in general, and what happened in this run. */
function Outcome({ run, speed }: { run: Run; speed: string }) {
  const style = OUTCOME_STYLE[run.status];
  const live = isLive(run.status);
  return (
    <div role="status" className={cn('flex items-start gap-3 rounded-xl border px-4 py-3.5', style.box)}>
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">{style.icon}</span>
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium text-pretty">
          {style.title}.{' '}
          <span className="font-normal text-muted-foreground">
            {run.status === 'running' ? 'The timeline, phases and cost below fill in as each step finishes.' : STATUS_MEANING[run.status]}
          </span>
        </p>
        {live ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
            <LiveStep run={run} className="text-sm" />
            <span className="text-xs">
              · {speed} speed (
              <Link href="/settings#appearance" className="underline underline-offset-2 hover:text-foreground">
                change
              </Link>
              )
            </span>
          </div>
        ) : (
          <p className="mt-1 text-pretty text-foreground/90">{outcomeReason(run)}</p>
        )}
      </div>
    </div>
  );
}

function Fact({ icon, label, help, value, hint, mono = false }: { icon: React.ReactNode; label: string; help?: React.ReactNode; value: React.ReactNode; hint: string; mono?: boolean }) {
  return (
    <Card size="sm" className="h-full">
      <CardHeader>
        <CardDescription className="flex items-center gap-1.5 [&_svg:not([class*='size-'])]:size-3.5">
          {icon}
          {label}
          {help}
        </CardDescription>
        <CardTitle className={mono ? 'truncate font-mono text-sm leading-7' : 'text-xl font-semibold'}>{value}</CardTitle>
      </CardHeader>
      <CardContent className="truncate text-xs text-muted-foreground" title={hint}>
        {hint}
      </CardContent>
    </Card>
  );
}

function RunNotFound() {
  return (
    <div className="flex flex-1 p-4 md:p-6">
      <FadeIn className="flex flex-1">
        <Empty className="flex-1 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchX />
            </EmptyMedia>
            <EmptyTitle>This run is not in this browser</EmptyTitle>
            <EmptyDescription>
              Runs live only in the browser that played them. This one may have been deleted, cleared with the history, or removed along with its workflow.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row justify-center">
            <Button nativeButton={false} render={<Link href="/runs" />}>
              <ArrowLeft data-icon="inline-start" /> All runs
            </Button>
            <Button variant="outline" nativeButton={false} render={<Link href="/dashboard" />}>
              <LayoutDashboard data-icon="inline-start" /> Dashboard
            </Button>
          </EmptyContent>
        </Empty>
      </FadeIn>
    </div>
  );
}
