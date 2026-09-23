'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { CircleAlert, Copy, Download, FileCode2, Loader2, MoreHorizontal, Play, Plus, Search, Trash2, Upload, Workflow as WorkflowIcon, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { PageHeader } from '@/components/app/page-header';
import { FluidTabs } from '@/components/watermelon/fluid-tabs';
import { StatusBadge } from '@/components/app/status-badge';
import { Stagger, StaggerItem } from '@/components/motion/fade-in';
import { GraphThumbnail } from '@/components/templates/graph-thumbnail';
import { ExportDialog } from '@/components/builder/export-dialog';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { useBrand } from '@/hooks/use-brand';
import { useNow } from '@/hooks/use-now';
import { useCreateWorkflow } from '@/hooks/use-create-workflow';
import { useStudio, useWorkflows } from '@/lib/store';
import { getNodeType } from '@/lib/connectors';
import { compileWorkflow } from '@/lib/workflow/compile';
import { validateWorkflow } from '@/lib/workflow/validate';
import { launchRun } from '@/lib/run-launcher';
import { saveBlob } from '@/lib/zip';
import { timeAgo } from '@/lib/format';
import type { Run, Workflow } from '@/lib/workflow/schema';
import { cn } from '@/lib/utils';

type Filter = 'all' | 'active' | 'paused' | 'attention';
type Sort = 'edited' | 'name' | 'run';

export default function WorkflowsPage() {
  const router = useRouter();
  const brand = useBrand();
  const now = useNow();
  const workflows = useWorkflows();
  const runs = useStudio((state) => state.runs);
  const hydrated = useStudio((state) => state.hydrated);
  const toggleWorkflow = useStudio((state) => state.toggleWorkflow);
  const deleteWorkflow = useStudio((state) => state.deleteWorkflow);
  const duplicateWorkflow = useStudio((state) => state.duplicateWorkflow);
  const importAll = useStudio((state) => state.importAll);
  const auth = useStudio((state) => state.settings.auth);
  const create = useCreateWorkflow();
  const fileInput = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('edited');
  const [exporting, setExporting] = useState<Workflow | null>(null);
  const [deleting, setDeleting] = useState<Workflow | null>(null);
  const [starting, setStarting] = useState<string | null>(null);

  const lastRun = useMemo(() => {
    const map = new Map<string, Run>();
    for (const run of runs) if (!map.has(run.workflowId)) map.set(run.workflowId, run);
    return map;
  }, [runs]);

  const errors = useMemo(() => new Map(workflows.map((workflow) => [workflow.id, validateWorkflow(workflow).errors])), [workflows]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = workflows.filter((workflow) => {
      if (filter === 'active' && !workflow.enabled) return false;
      if (filter === 'paused' && workflow.enabled) return false;
      if (filter === 'attention' && (errors.get(workflow.id) ?? 0) === 0 && !['failed', 'refused'].includes(lastRun.get(workflow.id)?.status ?? '')) return false;
      if (needle.length === 0) return true;
      const apps = workflow.nodes.map((node) => getNodeType(node.data.typeId)?.connector.name ?? '').join(' ');
      return `${workflow.name} ${workflow.description} ${workflow.repository ?? ''} ${apps}`.toLowerCase().includes(needle);
    });
    return [...list].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'run') return (lastRun.get(b.id)?.startedAt ?? '').localeCompare(lastRun.get(a.id)?.startedAt ?? '');
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }, [workflows, query, filter, sort, errors, lastRun]);

  const counts = {
    all: workflows.length,
    active: workflows.filter((workflow) => workflow.enabled).length,
    paused: workflows.filter((workflow) => !workflow.enabled).length,
    attention: workflows.filter((workflow) => (errors.get(workflow.id) ?? 0) > 0 || ['failed', 'refused'].includes(lastRun.get(workflow.id)?.status ?? '')).length,
  };

  const testRun = async (workflow: Workflow) => {
    const result = validateWorkflow(workflow);
    if (!result.ok) {
      toast.error(`“${workflow.name}” has ${result.errors} problem${result.errors === 1 ? '' : 's'} to fix first`, {
        description: result.issues.find((issue) => issue.level === 'error')?.message,
        action: { label: 'Open', onClick: () => router.push(`/workflows/${workflow.id}`) },
      });
      return;
    }
    setStarting(workflow.id);
    try {
      const run = await launchRun(workflow);
      const verb = run.status === 'succeeded' ? 'succeeded' : run.status === 'refused' ? 'was refused by a guardrail' : run.status === 'failed' ? 'failed' : run.status;
      toast[run.status === 'succeeded' ? 'success' : run.status === 'failed' ? 'error' : 'message'](`Test run ${verb}`, {
        description: `${workflow.name} · $${run.costUsd.toFixed(2)}`,
        action: { label: 'View', onClick: () => router.push(`/runs/${run.id}`) },
      });
    } finally {
      setStarting(null);
    }
  };

  const downloadJson = (workflow: Workflow) => {
    const bundle = compileWorkflow(workflow, brand, { auth }).files.find((file) => file.path.endsWith('-workflow.json'));
    if (bundle === undefined) return;
    saveBlob(new Blob([bundle.content], { type: 'application/json' }), bundle.path);
    toast.success(`Downloaded ${bundle.path}`, { description: 'Import it here or in another browser to get the same workflow.' });
  };

  const onImport = async (file: File | undefined) => {
    if (file === undefined) return;
    try {
      const result = importAll(JSON.parse(await file.text()));
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
    } catch {
      toast.error('That file is not valid JSON.');
    } finally {
      if (fileInput.current !== null) fileInput.current.value = '';
    }
  };

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <PageHeader
        title="Workflows"
        term="workflow"
        description="Each workflow is a diagram: what starts it, what checks it, what the agents do, and where the result goes. Open one to edit it on the canvas, or test-run it from here."
        actions={
          <>
            <Button variant="ghost" onClick={() => fileInput.current?.click()}>
              <Upload data-icon="inline-start" /> Import
            </Button>
            <input ref={fileInput} type="file" accept="application/json,.json" className="hidden" onChange={(event) => void onImport(event.target.files?.[0])} />
            <Button variant="outline" nativeButton={false} render={<Link href="/templates" />}>
              From a template
            </Button>
            <Button onClick={() => create.blank()}>
              <Plus data-icon="inline-start" /> New workflow
            </Button>
          </>
        }
      />

      {!hydrated ? null : workflows.length === 0 ? (
        <Empty className="flex-1 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <WorkflowIcon />
            </EmptyMedia>
            <EmptyTitle>No workflows yet</EmptyTitle>
            <EmptyDescription>A workflow starts with a trigger — a ticket assigned, a label added, a schedule — and ends with a pull request someone can review. Start from a template to see a complete one.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex flex-wrap justify-center gap-2">
              <Button nativeButton={false} render={<Link href="/templates" />}>
                Browse templates
              </Button>
              <Button variant="outline" onClick={() => create.blank()}>
                Blank canvas
              </Button>
            </div>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-72">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name, app or repository…" className="pl-8" aria-label="Search workflows" />
            </div>
            <FluidTabs
              size="sm"
              layoutId="workflow-filter"
              aria-label="Filter workflows"
              value={filter}
              onChange={(id) => setFilter(id as Filter)}
              tabs={(
                [
                  ['all', 'All'],
                  ['active', 'Active'],
                  ['paused', 'Paused'],
                  ['attention', 'Needs attention'],
                ] as const
              ).map(([id, label]) => ({
                id,
                label: (
                  <>
                    {label} <span className="ml-0.5 font-normal text-muted-foreground tabular-nums">{counts[id]}</span>
                  </>
                ),
              }))}
            />
            <Select value={sort} onValueChange={(value) => setSort(value as Sort)} items={[{ value: 'edited', label: 'Recently edited' }, { value: 'run', label: 'Recently run' }, { value: 'name', label: 'Name' }]}>
              <SelectTrigger size="sm" className="ml-auto w-40" aria-label="Sort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="edited">Recently edited</SelectItem>
                <SelectItem value="run">Recently run</SelectItem>
                <SelectItem value="name">Name</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {shown.length === 0 ? (
            <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
              No workflow matches. {query.length > 0 ? 'Try another word, or ' : ''}
              <button type="button" className="font-medium text-primary hover:underline" onClick={() => { setQuery(''); setFilter('all'); }}>
                show all
              </button>
              .
            </div>
          ) : (
            <Stagger key={`${filter}-${sort}`} className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {shown.map((workflow) => {
                const run = lastRun.get(workflow.id);
                const problems = errors.get(workflow.id) ?? 0;
                const trigger = workflow.nodes.map((node) => getNodeType(node.data.typeId)).find((def) => def?.kind === 'trigger');
                return (
                  <StaggerItem key={workflow.id}>
                    <article className="group relative flex h-full flex-col overflow-hidden rounded-xl border bg-card shadow-xs transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md">
                      <Link href={`/workflows/${workflow.id}`} className="absolute inset-0 z-0" aria-label={`Open ${workflow.name}`} />
                      <GraphThumbnail workflow={workflow} className="pointer-events-none h-28 rounded-none border-0 border-b" />
                      <div className="flex flex-1 flex-col gap-3 p-4">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <h2 className="truncate font-semibold tracking-tight">{workflow.name}</h2>
                            <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{workflow.description || 'No description yet — add one in the builder so others know what this is for.'}</p>
                          </div>
                          <DropdownMenu>
                            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More actions for ${workflow.name}`} className="relative z-10 -mt-1 -mr-1" />}>
                              <MoreHorizontal />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-52">
                              <DropdownMenuItem onClick={() => router.push(`/workflows/${workflow.id}`)}>
                                <WorkflowIcon /> Open in the builder
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => void testRun(workflow)} disabled={starting !== null}>
                                <Play /> Test run
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => setExporting(workflow)}>
                                <FileCode2 /> Export files…
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => {
                                  const copy = duplicateWorkflow(workflow.id);
                                  if (copy !== undefined) toast.success(`Duplicated as “${copy.name}”`, { description: 'The copy starts paused.' });
                                }}
                              >
                                <Copy /> Duplicate
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => downloadJson(workflow)}>
                                <Download /> Download as JSON
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem variant="destructive" onClick={() => setDeleting(workflow)}>
                                <Trash2 /> Delete…
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5 text-xs">
                          {trigger === undefined ? (
                            <Badge variant="outline" className="border-destructive/30 text-destructive">
                              No trigger
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="max-w-full gap-1.5">
                              <Zap className="fill-amber-400 text-amber-500" />
                              <ConnectorIcon connector={trigger.connector} size={10} variant="mark" />
                              <span className="truncate">{trigger.name}</span>
                            </Badge>
                          )}
                          <Badge variant="secondary" className="tabular-nums">
                            {workflow.nodes.length} nodes
                          </Badge>
                          {problems > 0 ? (
                            <Badge variant="outline" className="gap-1 border-destructive/30 bg-destructive/8 text-destructive">
                              <CircleAlert /> {problems} to fix
                            </Badge>
                          ) : null}
                          {workflow.repository ? <span className="truncate font-mono text-[11px] text-muted-foreground">{workflow.repository}</span> : null}
                        </div>

                        <div className="relative z-10 mt-auto flex items-center justify-between gap-2 border-t pt-3">
                          <label className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Switch size="sm" checked={workflow.enabled} onCheckedChange={(checked) => toggleWorkflow(workflow.id, checked)} aria-label={`${workflow.name} active`} />
                            {workflow.enabled ? 'Active' : 'Paused'}
                          </label>
                          <div className="flex min-w-0 items-center gap-2">
                            {run === undefined ? (
                              <span className="text-xs text-muted-foreground">Never run</span>
                            ) : (
                              <Link href={`/runs/${run.id}`} className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                                <StatusBadge status={run.status} className="h-5" />
                                <span className="truncate">{timeAgo(run.startedAt, now)}</span>
                              </Link>
                            )}
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Button size="icon-sm" variant="outline" aria-label={`Test run ${workflow.name}`} disabled={starting !== null} onClick={() => void testRun(workflow)} className={cn(starting === workflow.id ? 'text-primary' : '')} />
                                }
                              >
                                {starting === workflow.id ? <Loader2 className="animate-spin" /> : <Play className="fill-current" />}
                              </TooltipTrigger>
                              <TooltipContent>Test run with a sample ticket — free, simulated</TooltipContent>
                            </Tooltip>
                          </div>
                        </div>
                      </div>
                    </article>
                  </StaggerItem>
                );
              })}
            </Stagger>
          )}
        </>
      )}

      <ExportDialog workflow={exporting} open={exporting !== null} onOpenChange={(open) => (open ? undefined : setExporting(null))} />

      <AlertDialog open={deleting !== null} onOpenChange={(open) => (open ? undefined : setDeleting(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The workflow and its {runs.filter((run) => run.workflowId === deleting?.id).length} recorded test run(s) are removed from this browser. Files you already exported to a repository are not affected. Download it as JSON first if you might want it back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting === null) return;
                deleteWorkflow(deleting.id);
                toast(`Deleted “${deleting.name}”`);
                setDeleting(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
