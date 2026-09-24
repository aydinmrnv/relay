'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { useCalmMotion } from '@/components/motion/use-calm-motion';
import { ChevronDown, FlaskConical, Play, Search, SearchX, Trash2, Workflow as WorkflowIcon, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader } from '@/components/ui/table';
import { PageHeader } from '@/components/app/page-header';
import { StatusBadge } from '@/components/app/status-badge';
import { FadeIn } from '@/components/motion/fade-in';
import { RunActionsMenu } from '@/components/runs/run-actions-menu';
import { RunResult, RunTrigger, StartedAt } from '@/components/runs/run-bits';
import { ClearRunsDialog, DeleteRunDialog } from '@/components/runs/run-dialogs';
import { LiveStep, RunStatusBadge } from '@/components/runs/run-status';
import { formatRunDuration, isLive, triggerKey, triggerTitle } from '@/components/runs/run-utils';
import { isStatusFilter, StatusTabs, type StatusFilter } from '@/components/runs/status-tabs';
import { useRunAgain } from '@/components/runs/use-run-again';
import { useNow } from '@/hooks/use-now';
import { useStudio, useWorkflows } from '@/lib/store';
import { formatUsd } from '@/lib/format';
import { validateWorkflow } from '@/lib/workflow/validate';
import type { Run } from '@/lib/workflow/schema';

const ALL = 'all';

const NONE: Record<StatusFilter, string> = {
  all: 'none is shown',
  running: 'none is playing right now',
  succeeded: 'none succeeded',
  failed: 'none failed',
  refused: 'none was refused',
  cancelled: 'none was stopped',
};

export default function RunsPage({ searchParams }: PageProps<'/runs'>) {
  // Links from the dashboard land pre-filtered: /runs?workflow=…&status=failed.
  const query = use(searchParams);
  const router = useRouter();
  const now = useNow();
  const reduce = useCalmMotion();
  const runs = useStudio((state) => state.runs);
  const workflowMap = useStudio((state) => state.workflows);
  const hydrated = useStudio((state) => state.hydrated);
  const workflows = useWorkflows();
  const runAgain = useRunAgain();

  const [status, setStatus] = useState<StatusFilter>(isStatusFilter(query['status']) ? query['status'] : 'all');
  const [workflowId, setWorkflowId] = useState<string>(typeof query['workflow'] === 'string' ? query['workflow'] : ALL);
  const [search, setSearch] = useState('');
  const [deleting, setDeleting] = useState<Run | undefined>(undefined);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);

  const workflowOptions = useMemo(() => {
    const names = new Map<string, string>();
    for (const run of runs) if (!names.has(run.workflowId)) names.set(run.workflowId, workflowMap[run.workflowId]?.name ?? run.workflowName);
    return [...names].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [runs, workflowMap]);

  // Workflow and text filters first; the status counts are counted inside them, so the tabs never promise rows that are not there.
  const scoped = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return runs.filter((run) => {
      if (workflowId !== ALL && run.workflowId !== workflowId) return false;
      if (needle.length === 0) return true;
      const haystack = [triggerTitle(run), triggerKey(run) ?? '', run.id, run.shortId, run.workflowName, workflowMap[run.workflowId]?.name ?? '', run.branch ?? ''].join(' ').toLowerCase();
      return haystack.includes(needle);
    });
  }, [runs, workflowId, search, workflowMap]);

  const counts = useMemo(() => {
    const result: Record<StatusFilter, number> = { all: scoped.length, running: 0, succeeded: 0, failed: 0, refused: 0, cancelled: 0 };
    for (const run of scoped) {
      if (isLive(run.status)) result.running += 1;
      else result[run.status] += 1;
    }
    return result;
  }, [scoped]);

  const visible = useMemo(() => (status === 'all' ? scoped : scoped.filter((run) => (status === 'running' ? isLive(run.status) : run.status === status))), [scoped, status]);
  const visibleSpend = visible.reduce((sum, run) => sum + run.costUsd, 0);
  const filtered = status !== 'all' || workflowId !== ALL || search.trim().length > 0;

  const testable = useMemo(() => workflows.map((workflow) => ({ workflow, errors: validateWorkflow(workflow).errors })), [workflows]);
  const firstValid = testable.find((entry) => entry.errors === 0)?.workflow;

  const clearFilters = () => {
    setStatus('all');
    setWorkflowId(ALL);
    setSearch('');
  };
  const askDelete = (run: Run) => {
    setDeleting(run);
    setDeleteOpen(true);
  };

  const testMenu =
    workflows.length === 0 ? null : (
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant={runs.length === 0 ? 'default' : 'outline'} />}>
          <FlaskConical data-icon="inline-start" /> Test a workflow <ChevronDown data-icon="inline-end" className="opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Plays it here with a sample ticket. Free.</DropdownMenuLabel>
            {testable.map(({ workflow, errors }) => (
              <DropdownMenuItem key={workflow.id} onClick={() => runAgain(workflow.id)}>
                <WorkflowIcon />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{workflow.name}</span>
                  <span className={errors > 0 ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
                    {errors > 0 ? `${errors} ${errors === 1 ? 'problem' : 'problems'} to fix in the builder first` : 'Ready to play'}
                  </span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <PageHeader
        title="Runs"
        term="run"
        description="Every test run played in this browser, newest first. Runs are simulated — nothing was called or billed — and they are stored only here. Open one for its step-by-step timeline."
        actions={
          <>
            {runs.length > 0 ? (
              <Button variant="ghost" className="text-muted-foreground" onClick={() => setClearOpen(true)}>
                <Trash2 data-icon="inline-start" /> Clear history
              </Button>
            ) : null}
            {testMenu}
          </>
        }
      />

      {!hydrated ? null : runs.length === 0 ? (
        <FadeIn className="flex flex-1">
          <Empty className="flex-1 border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Play />
              </EmptyMedia>
              <EmptyTitle>No test runs yet</EmptyTitle>
              <EmptyDescription>
                A test run plays a workflow here with a sample ticket — every node, phase, cost and refusal — without calling anything. Start one below, or press Test run in the builder.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent className="flex-row justify-center">
              {firstValid !== undefined ? (
                <Button onClick={() => runAgain(firstValid.id, { navigate: true })}>
                  <Play data-icon="inline-start" /> Test {firstValid.name}
                </Button>
              ) : null}
              <Button variant="outline" nativeButton={false} render={<Link href="/workflows" />}>
                Open workflows
              </Button>
            </EmptyContent>
          </Empty>
        </FadeIn>
      ) : (
        <FadeIn delay={0.05} className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <StatusTabs value={status} counts={counts} onChange={setStatus} />
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Select
                value={workflowId}
                onValueChange={(next) => setWorkflowId(typeof next === 'string' ? next : ALL)}
                items={[{ value: ALL, label: 'All workflows' }, ...workflowOptions]}
              >
                <SelectTrigger className="w-full sm:w-52" aria-label="Filter by workflow">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All workflows</SelectItem>
                  {workflowOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <InputGroup className="sm:w-64">
                <InputGroupAddon>
                  <Search />
                </InputGroupAddon>
                <InputGroupInput value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search ticket, run id, workflow" aria-label="Search runs" />
                {search.length > 0 ? (
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setSearch('')}>
                      <X />
                    </InputGroupButton>
                  </InputGroupAddon>
                ) : null}
              </InputGroup>
            </div>
          </div>

          {visible.length === 0 ? (
            <Empty className="border py-12">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchX />
                </EmptyMedia>
                <EmptyTitle>No runs match</EmptyTitle>
                <EmptyDescription>
                  {counts.all === 0 ? 'Nothing matches the workflow and search above.' : `${counts.all} ${counts.all === 1 ? 'run matches' : 'runs match'} the other filters, but ${NONE[status]}.`}
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" onClick={clearFilters}>
                  Clear filters
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {filtered ? `${visible.length} of ${runs.length} runs` : `${runs.length} ${runs.length === 1 ? 'run' : 'runs'}`} · {formatUsd(visibleSpend)} simulated
                {counts.running > 0 ? ` · ${counts.running} playing now` : ''}
              </p>

              {/* Cards on narrow screens: a table of eight columns does not fit a phone. */}
              <ul className="flex flex-col gap-2 md:hidden">
                {visible.map((run) => (
                  <li key={run.id} className="relative rounded-xl border bg-card p-3 transition-colors hover:bg-muted/40">
                    <Link href={`/runs/${run.id}`} className="absolute inset-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/50" aria-label={`Open run ${run.shortId} of ${run.workflowName}`} />
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{run.workflowName}</p>
                        <RunTrigger run={run} className="mt-0.5 text-xs" />
                      </div>
                      <RunActionsMenu run={run} workflowExists={workflowMap[run.workflowId] !== undefined} onDelete={() => askDelete(run)} className="relative z-10 -mt-1 -mr-1" />
                    </div>
                    <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                      <StatusBadge status={run.status} />
                      <span className="tabular-nums">
                        {formatUsd(run.costUsd)} · {formatRunDuration(run)} · <StartedAt iso={run.startedAt} now={now} className="relative z-10" />
                      </span>
                    </div>
                    {isLive(run.status) ? <LiveStep run={run} className="mt-2" /> : null}
                  </li>
                ))}
              </ul>

              <div className="hidden overflow-hidden rounded-xl border bg-card md:block">
                <Table>
                  <TableHeader>
                    <tr className="border-b bg-muted/40">
                      <TableHead className="pl-4">Status</TableHead>
                      <TableHead>Workflow</TableHead>
                      <TableHead className="hidden lg:table-cell">Trigger</TableHead>
                      <TableHead>Result</TableHead>
                      <TableHead className="text-right">Cost</TableHead>
                      <TableHead className="hidden text-right xl:table-cell">Duration</TableHead>
                      <TableHead className="text-right">Started</TableHead>
                      <TableHead className="w-12 pr-3">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </tr>
                  </TableHeader>
                  <TableBody>
                    {visible.map((run) => {
                      const exists = workflowMap[run.workflowId] !== undefined;
                      return (
                        <motion.tr
                          key={run.id}
                          initial={reduce ? false : { opacity: 0, y: -4 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.25 }}
                          onClick={() => router.push(`/runs/${run.id}`)}
                          className="group cursor-pointer border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50"
                        >
                          <TableCell className="pl-4">
                            <div className="flex flex-col items-start gap-1">
                              <RunStatusBadge status={run.status} />
                              <span className="font-mono text-[11px] text-muted-foreground">{run.shortId}</span>
                            </div>
                          </TableCell>
                          <TableCell className="max-w-56">
                            <Link href={`/runs/${run.id}`} onClick={(event) => event.stopPropagation()} className="block truncate font-medium underline-offset-4 outline-none group-hover:underline focus-visible:underline">
                              {run.workflowName}
                            </Link>
                            {!exists ? <span className="text-xs text-muted-foreground">workflow deleted</span> : null}
                          </TableCell>
                          <TableCell className="hidden max-w-72 lg:table-cell">
                            <RunTrigger run={run} />
                          </TableCell>
                          <TableCell className="max-w-72">
                            <RunResult run={run} />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{formatUsd(run.costUsd)}</TableCell>
                          <TableCell className="hidden text-right text-muted-foreground tabular-nums xl:table-cell">{formatRunDuration(run)}</TableCell>
                          <TableCell className="text-right text-muted-foreground">
                            <StartedAt iso={run.startedAt} now={now} />
                          </TableCell>
                          <TableCell className="pr-3 text-right">
                            <RunActionsMenu run={run} workflowExists={exists} onDelete={() => askDelete(run)} />
                          </TableCell>
                        </motion.tr>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </FadeIn>
      )}

      <DeleteRunDialog run={deleting} open={deleteOpen} onOpenChange={setDeleteOpen} />
      <ClearRunsDialog open={clearOpen} onOpenChange={setClearOpen} />
    </div>
  );
}
