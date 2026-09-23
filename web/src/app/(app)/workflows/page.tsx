'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Copy, Download, MoreHorizontal, Plus, Trash2, Workflow as WorkflowIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { StatusBadge } from '@/components/app/status-badge';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { useBrand } from '@/hooks/use-brand';
import { useStudio, useWorkflows } from '@/lib/store';
import { getConnector, getNodeType } from '@/lib/connectors';
import { blankWorkflow } from '@/lib/workflow/templates';
import { compileWorkflow } from '@/lib/workflow/compile';
import { timeAgo } from '@/lib/format';
import type { Workflow } from '@/lib/workflow/schema';

export default function WorkflowsPage() {
  const router = useRouter();
  const brand = useBrand();
  const workflows = useWorkflows();
  const runs = useStudio((state) => state.runs);
  const hydrated = useStudio((state) => state.hydrated);
  const upsertWorkflow = useStudio((state) => state.upsertWorkflow);
  const toggleWorkflow = useStudio((state) => state.toggleWorkflow);
  const deleteWorkflow = useStudio((state) => state.deleteWorkflow);
  const duplicateWorkflow = useStudio((state) => state.duplicateWorkflow);
  const repository = useStudio((state) => state.settings.defaultRepository);
  const auth = useStudio((state) => state.settings.auth);

  const create = () => {
    const workflow = blankWorkflow(brand, repository);
    upsertWorkflow(workflow);
    router.push(`/workflows/${workflow.id}`);
  };

  const download = (workflow: Workflow) => {
    const compiled = compileWorkflow(workflow, brand, { auth });
    const bundle = compiled.files.find((file) => file.path.endsWith('-workflow.json'));
    if (bundle === undefined) return;
    const blob = new Blob([bundle.content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = bundle.path;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success(`Downloaded ${bundle.path}`);
  };

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Workflows</h1>
          <p className="text-sm text-muted-foreground">Each one is a graph: a trigger, some gates, the pipeline, and what happens after.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" nativeButton={false} render={<Link href="/templates" />}>
            From a template
          </Button>
          <Button onClick={create}>
            <Plus data-icon="inline-start" />
            New workflow
          </Button>
        </div>
      </div>

      {!hydrated ? null : workflows.length === 0 ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <WorkflowIcon />
            </EmptyMedia>
            <EmptyTitle>No workflows yet</EmptyTitle>
            <EmptyDescription>Start from a template or an empty canvas.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex gap-2">
              <Button variant="outline" nativeButton={false} render={<Link href="/templates" />}>
                Browse templates
              </Button>
              <Button onClick={create}>New workflow</Button>
            </div>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {workflows.map((workflow) => {
            const lastRun = runs.find((run) => run.workflowId === workflow.id);
            const connectorIds = [...new Set(workflow.nodes.map((node) => getNodeType(node.data.typeId)?.connectorId).filter((id): id is string => id !== undefined))];
            const trigger = workflow.nodes.map((node) => getNodeType(node.data.typeId)).find((def) => def?.kind === 'trigger');
            return (
              <Card key={workflow.id} className="group relative flex flex-col transition-shadow hover:shadow-md">
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <Link href={`/workflows/${workflow.id}`} className="min-w-0 flex-1">
                      <CardTitle className="truncate text-base">{workflow.name}</CardTitle>
                      <CardDescription className="mt-1 line-clamp-2">{workflow.description || 'No description yet.'}</CardDescription>
                    </Link>
                    <div className="flex items-center gap-1">
                      <Switch checked={workflow.enabled} onCheckedChange={(checked) => toggleWorkflow(workflow.id, checked)} aria-label="Enabled" />
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More" />}>
                          <MoreHorizontal />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => router.push(`/workflows/${workflow.id}`)}>Open</DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => {
                              const copy = duplicateWorkflow(workflow.id);
                              if (copy !== undefined) toast.success(`Duplicated as "${copy.name}"`);
                            }}
                          >
                            <Copy /> Duplicate
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => download(workflow)}>
                            <Download /> Download JSON
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => {
                              deleteWorkflow(workflow.id);
                              toast(`Deleted "${workflow.name}"`);
                            }}
                          >
                            <Trash2 /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="mt-auto flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {connectorIds.slice(0, 7).map((id) => {
                      const connector = getConnector(id);
                      return connector === undefined ? null : <ConnectorIcon key={id} connector={connector} size={14} />;
                    })}
                    {connectorIds.length > 7 ? <Badge variant="secondary">+{connectorIds.length - 7}</Badge> : null}
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span className="truncate">{trigger === undefined ? 'No trigger' : `${trigger.connector.name} · ${trigger.name}`}</span>
                    <span>{workflow.nodes.length} nodes</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    {lastRun === undefined ? <span className="text-muted-foreground">Never run</span> : <StatusBadge status={lastRun.status} />}
                    <span className="text-muted-foreground">edited {timeAgo(workflow.updatedAt)}</span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
