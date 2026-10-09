'use client';

import Link from 'next/link';
import { Check, ChevronsUpDown, FolderGit2, Layers, Plus, Settings2 } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { AppMark } from '@/components/marketing/primitives';
import { projectActions, useActiveProject, useProjects } from '@/hooks/use-projects';
import { RUNNER_LABEL } from '@/lib/projects';
import { useStudio } from '@/lib/store';

/**
 * Which repository the studio is showing, at the top of the sidebar. The
 * dashboard, the workflows and the runs all follow it, and a new workflow
 * attaches to the one in view.
 */
export function ProjectSwitcher() {
  const { isMobile } = useSidebar();
  const hydrated = useStudio((state) => state.hydrated);
  const projects = useProjects();
  const active = useActiveProject();

  // Before the saved studio is read there is no telling whether there are projects, so nothing claims there are none.
  if (!hydrated) return null;

  if (projects.length === 0) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" render={<Link href="/projects/new" />} tooltip="Connect a repository">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-dashed">
              <Plus className="size-4" />
            </span>
            <span className="grid flex-1 text-left leading-tight">
              <span className="truncate text-sm font-medium">Connect a repository</span>
              <span className="truncate text-xs text-muted-foreground">Set up your first project</span>
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  const [owner, name] = active === null ? ['', ''] : active.repository.split('/');
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuButton size="lg" className="data-popup-open:bg-sidebar-accent" tooltip={active === null ? 'All projects' : active.repository} aria-label="Switch project" />}>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background">{active === null ? <Layers className="size-4" /> : <AppMark connector="github" size={15} />}</span>
            <span className="grid flex-1 text-left leading-tight">
              <span className="truncate text-sm font-medium">{active === null ? 'All projects' : name}</span>
              <span className="truncate text-xs text-muted-foreground">{active === null ? `${projects.length} ${projects.length === 1 ? 'repository' : 'repositories'}` : `${owner} · ${RUNNER_LABEL[active.runner]}`}</span>
            </span>
            <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side={isMobile ? 'bottom' : 'right'} align="start" className="w-64">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Projects</DropdownMenuLabel>
              {projects.map((project) => (
                <DropdownMenuItem key={project.id} onClick={() => projectActions.select(project.id)}>
                  <FolderGit2 />
                  <span className="grid min-w-0 flex-1 leading-tight">
                    <span className="truncate font-mono text-xs">{project.repository}</span>
                    <span className="truncate text-xs text-muted-foreground">{RUNNER_LABEL[project.runner]}</span>
                  </span>
                  {active?.id === project.id ? <Check className="ml-auto" /> : null}
                </DropdownMenuItem>
              ))}
              {projects.length > 1 ? (
                <DropdownMenuItem onClick={() => projectActions.select(null)}>
                  <Layers /> All projects
                  {active === null ? <Check className="ml-auto" /> : null}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem render={<Link href="/projects/new" />}>
                <Plus /> Add a project
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/projects" />}>
                <Settings2 /> Manage projects
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
