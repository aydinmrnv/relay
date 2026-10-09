'use client';

import { useMemo } from 'react';
import { activeProjectOf, inProject, isInstalled, projectsOf, runsIn, withActiveProject, withProject, withProjectPatch, withoutProject, workflowsOf } from '@/lib/projects';
import { useStudio, useWorkflows } from '@/lib/store';
import type { Project, ProjectRunner, Run, Workflow } from '@/lib/workflow/schema';

/** Every project, in the order they were set up. Memoised on what it is read from, so it is safe as a hook result. */
export function useProjects(): Project[] {
  const saved = useStudio((state) => state.settings.projects);
  const defaultRepository = useStudio((state) => state.settings.defaultRepository);
  const workflows = useStudio((state) => state.workflows);
  return useMemo(() => projectsOf({ projects: saved, defaultRepository }, Object.values(workflows)), [saved, defaultRepository, workflows]);
}

/** The project the studio is showing, or `null` when it is showing all of them. */
export function useActiveProject(): Project | null {
  const projects = useProjects();
  const active = useStudio((state) => state.settings.activeProject);
  return useMemo(() => activeProjectOf({ activeProject: active }, projects), [active, projects]);
}

/** The workflows of the project in view, newest first: what the dashboard, the list and the run history show. */
export function useProjectWorkflows(): Workflow[] {
  const project = useActiveProject();
  const workflows = useWorkflows();
  return useMemo(() => workflows.filter((workflow) => inProject(project, workflow)), [project, workflows]);
}

/**
 * Whether a project still has something to do before it runs on GitHub
 * Actions: it was set up on purpose, runs there, and none of its workflows is
 * in the repository yet. A project nobody set up is never nagged about.
 */
export function useNeedsInstall(project: Project | null | undefined): boolean {
  const workflows = useStudio((state) => state.workflows);
  return useMemo(() => project !== null && project !== undefined && project.runner === 'actions' && project.implied !== true && !isInstalled(project, Object.values(workflows)), [project, workflows]);
}

export function useProjectRuns(): Run[] {
  const project = useActiveProject();
  const runs = useStudio((state) => state.runs);
  const workflows = useStudio((state) => state.workflows);
  return useMemo(() => runsIn(project, runs, workflows), [project, runs, workflows]);
}

interface NewProject {
  repository: string;
  runner?: ProjectRunner;
  defaultBranch?: string;
  private?: boolean;
}

/** Adds, changes, removes and switches projects. Read from the store when called, so a handler never acts on a stale list. */
export const projectActions = {
  /** Sets a repository up (or updates it) and switches the studio to it. */
  add(input: NewProject): void {
    const { settings, workflows, updateSettings } = useStudio.getState();
    updateSettings(withProject(settings, Object.values(workflows), input));
  },
  update(id: string, patch: Partial<Pick<Project, 'runner' | 'defaultBranch' | 'private'>>): void {
    const { settings, workflows, updateSettings } = useStudio.getState();
    updateSettings(withProjectPatch(settings, Object.values(workflows), id, patch));
  },
  /** Removes a project and the workflows attached to its repository, with their runs. Nothing in the repository changes. */
  remove(project: Project): void {
    const state = useStudio.getState();
    for (const workflow of workflowsOf(project, Object.values(state.workflows))) state.deleteWorkflow(workflow.id);
    const { settings, workflows, updateSettings } = useStudio.getState();
    updateSettings(withoutProject(settings, Object.values(workflows), project.id));
  },
  select(id: string | null): void {
    const { settings, workflows, updateSettings } = useStudio.getState();
    updateSettings(withActiveProject(settings, Object.values(workflows), id));
  },
};
