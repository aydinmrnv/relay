'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, CircleDashed, FolderGit2, Plus, Trash2, TriangleAlert, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogMedia, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { PageHeader } from '@/components/app/page-header';
import { AppMark } from '@/components/marketing/primitives';
import { FadeIn } from '@/components/motion/fade-in';
import { InstallGuide } from '@/components/projects/install-guide';
import { useBrand } from '@/hooks/use-brand';
import { projectActions, useActiveProject, useProjects } from '@/hooks/use-projects';
import { useCapabilities } from '@/lib/cloud/account';
import { RUNNER_LABEL, workflowsOf } from '@/lib/projects';
import { useStudio, useWorkflows } from '@/lib/store';
import type { Project, ProjectRunner, Workflow } from '@/lib/workflow/schema';
import { startsOn } from '@/lib/workflow/starters';
import { cn } from '@/lib/utils';

/**
 * "/projects": every repository set up here, where each runs, what runs in
 * it, and whether it is installed there yet. The place to add another, change
 * where one runs, finish an install that was left for later, or remove one.
 */
export function ProjectsView() {
  const brand = useBrand();
  const projects = useProjects();
  const active = useActiveProject();
  const workflows = useWorkflows();
  const hydrated = useStudio((state) => state.hydrated);
  const [installing, setInstalling] = useState<{ project: Project; workflow: Workflow } | null>(null);
  const [removing, setRemoving] = useState<Project | null>(null);

  // The dialog shows the live workflow and project, so a tick made inside it shows at once.
  const liveProject = installing === null ? null : (projects.find((project) => project.id === installing.project.id) ?? null);
  const liveWorkflow = installing === null ? null : (workflows.find((workflow) => workflow.id === installing.workflow.id) ?? null);
  const removingCount = removing === null ? 0 : workflowsOf(removing, workflows).length;

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 pb-16 md:p-6">
      <PageHeader
        title="Projects"
        description={`A project is one repository and where its workflows run. ${brand.name} keeps each repository’s workflows and runs apart; switch between them from the top of the sidebar.`}
        actions={
          <Button nativeButton={false} render={<Link href="/projects/new" />}>
            <Plus data-icon="inline-start" /> Add a project
          </Button>
        }
      />

      {!hydrated ? null : projects.length === 0 ? (
        <FadeIn>
          <Empty className="border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderGit2 />
              </EmptyMedia>
              <EmptyTitle>No project yet</EmptyTitle>
              <EmptyDescription>Connect a repository, choose where its workflows run, and pick the first one. It takes a couple of minutes.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button nativeButton={false} render={<Link href="/projects/new" />}>
                Set up your first project <ArrowRight data-icon="inline-end" />
              </Button>
            </EmptyContent>
          </Empty>
        </FadeIn>
      ) : (
        <FadeIn className="grid gap-4">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              workflows={workflowsOf(project, workflows)}
              active={active?.id === project.id}
              onInstall={(workflow) => setInstalling({ project, workflow })}
              onRemove={() => setRemoving(project)}
            />
          ))}
        </FadeIn>
      )}

      <Dialog open={liveProject !== null && liveWorkflow !== null} onOpenChange={(open) => (open ? undefined : setInstalling(null))}>
        <DialogContent className="flex max-h-[90vh] flex-col gap-4 sm:max-w-2xl">
          {liveProject !== null && liveWorkflow !== null ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  Set up “{liveWorkflow.name}” in {liveProject.repository}
                </DialogTitle>
                <DialogDescription>What stands between this workflow and its first real run on {RUNNER_LABEL[liveProject.runner]}, in order.</DialogDescription>
              </DialogHeader>
              <div className="-mr-2 min-h-0 flex-1 overflow-y-auto pr-2">
                <InstallGuide workflow={liveWorkflow} project={liveProject} />
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog open={removing !== null} onOpenChange={(open) => (open ? undefined : setRemoving(null))}>
        <AlertDialogContent className="data-[size=default]:sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <TriangleAlert />
            </AlertDialogMedia>
            <AlertDialogTitle>Remove {removing?.repository}?</AlertDialogTitle>
            <AlertDialogDescription render={<div />} className="grid gap-2 text-left">
              <p>
                This removes the project from the studio{removingCount > 0 ? `, and deletes its ${removingCount === 1 ? 'workflow' : `${removingCount} workflows`} here with their runs, saved versions and share links` : ''}. There is no undo.
              </p>
              <p>Nothing in the repository changes: files you committed keep running there until you delete them yourself.</p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                if (removing === null) return;
                projectActions.remove(removing);
                toast.success(`Removed ${removing.repository}`);
                setRemoving(null);
              }}
            >
              <Trash2 data-icon="inline-start" /> Remove the project
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ProjectCard({ project, workflows, active, onInstall, onRemove }: { project: Project; workflows: Workflow[]; active: boolean; onInstall: (workflow: Workflow) => void; onRemove: () => void }) {
  const router = useRouter();
  const brand = useBrand();
  const cloudOffered = useCapabilities().cloudHub != null;
  const installed = workflows.some((workflow) => workflow.installedAt !== undefined);
  const onActions = project.runner === 'actions';
  const runners: ProjectRunner[] = cloudOffered || project.runner === 'cloud' ? ['actions', 'machine', 'cloud'] : ['actions', 'machine'];

  const open = () => {
    projectActions.select(project.id);
    router.push('/dashboard');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <AppMark connector="github" size={16} />
          <a href={`https://github.com/${project.repository}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono underline-offset-4 hover:underline">
            {project.repository}
            <ArrowUpRight className="size-3.5 text-muted-foreground" aria-hidden />
          </a>
          {active ? (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              In view
            </Badge>
          ) : null}
          {project.private === false ? (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              Public
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {onActions ? (
            <span className={cn('inline-flex items-center gap-1', installed && 'text-success')}>
              {installed ? <Check className="size-3.5" aria-hidden /> : <CircleDashed className="size-3.5" aria-hidden />}
              {installed ? 'Installed in the repository' : 'Not installed in the repository yet'}
            </span>
          ) : (
            <span>Runs on {project.runner === 'machine' ? 'your computer, through relay connect' : RUNNER_LABEL[project.runner]}</span>
          )}
          <span aria-hidden>·</span>
          <span>
            {workflows.length} {workflows.length === 1 ? 'workflow' : 'workflows'}
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="text-sm font-medium">Runs on</p>
          <ToggleGroup
            aria-label={`Where ${project.repository} runs`}
            value={[project.runner]}
            onValueChange={(next) => {
              const picked = next[0] as ProjectRunner | undefined;
              if (picked !== undefined && picked !== project.runner) projectActions.update(project.id, { runner: picked });
            }}
            variant="outline"
            size="sm"
            spacing={0}
          >
            {runners.map((runner) => (
              <ToggleGroupItem key={runner} value={runner} className="aria-pressed:bg-primary/10 aria-pressed:text-foreground">
                {RUNNER_LABEL[runner]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        {workflows.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground">No workflow is attached to this repository yet.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {workflows.map((workflow) => {
              const starts = startsOn(workflow, project.runner, brand);
              return (
                <li key={workflow.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <Link href={`/workflows/${workflow.id}`} className="truncate text-sm font-medium underline-offset-4 hover:underline">
                      {workflow.name}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">
                      {workflow.enabled ? starts.headline : 'Paused'}
                      {onActions && workflow.installedAt !== undefined ? ' · installed' : ''}
                    </p>
                  </div>
                  <Button size="sm" variant={onActions && workflow.installedAt === undefined ? 'default' : 'outline'} onClick={() => onInstall(workflow)}>
                    <Wrench data-icon="inline-start" /> {onActions ? (workflow.installedAt === undefined ? 'Install it' : 'Install steps') : 'Set it up'}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={open}>
            Open its dashboard <ArrowRight data-icon="inline-end" />
          </Button>
          {onActions ? (
            <Button size="sm" variant="ghost" nativeButton={false} render={<a href={`https://github.com/${project.repository}/actions`} target="_blank" rel="noreferrer" />}>
              Its runs on GitHub <ArrowUpRight data-icon="inline-end" />
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground hover:text-destructive" onClick={onRemove}>
            <Trash2 data-icon="inline-start" /> Remove
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
