/**
 * Projects: the repositories somebody set Relay up for.
 *
 * A project is a repository and where its automations run. Workflows already
 * say which repository they are attached to, so that is the whole link: a
 * workflow belongs to the project with its repository, and a repository with
 * workflows is a project whether or not anybody declared one. Nothing here
 * touches React or the store, so the rules can be tested as plain functions.
 */
import { REPOSITORY_PATTERN, isRepository, type Project, type ProjectRunner, type Run, type Settings, type Workflow } from './workflow/schema';

export const RUNNER_LABEL: Record<ProjectRunner, string> = {
  actions: 'GitHub Actions',
  machine: 'Your computer',
  cloud: 'Relay Cloud',
};

const RUNNERS = new Set<string>(['actions', 'machine', 'cloud']);

/** A project's id is its repository, lowercased: GitHub treats `Acme/API` and `acme/api` as one. */
export function projectId(repository: string): string {
  return repository.trim().toLowerCase();
}

export function sameRepository(a: string | undefined | null, b: string | undefined | null): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.trim().length > 0 && projectId(a) === projectId(b);
}

/** First path segments on github.com that are GitHub's own pages, never an account. */
const NOT_AN_OWNER = new Set(['orgs', 'settings', 'marketplace', 'features', 'topics', 'sponsors', 'users', 'apps', 'notifications', 'pulls', 'issues', 'explore', 'login', 'join', 'about', 'enterprise', 'collections', 'new', 'organizations', 'search', 'codespaces']);

/**
 * `owner/name` out of whatever somebody pasted: the short form, a GitHub URL
 * with or without a path after the repository, or a git remote. `null` when
 * it is none of those. The result ends up in links and in commands people
 * copy, so a name a shell would read as something else (`..`) is refused too.
 */
export function parseRepository(input: string): string | null {
  let text = input.trim();
  if (text.length === 0 || text.length > 300) return null;
  let fromUrl = false;
  // git@github.com:owner/name.git, with or without ssh:// and a port.
  const ssh = /^(?:ssh:\/\/)?git@github\.com(?::\d+\/|[:/])(.+)$/i.exec(text);
  if (ssh !== null) {
    text = ssh[1]!;
    fromUrl = true;
  } else {
    const url = /^(?:(?:https?|git):\/\/)?(?:[^@/\s]+@)?(?:www\.)?github\.com\/(.+)$/i.exec(text);
    if (url !== null) {
      text = url[1]!;
      fromUrl = true;
    } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null;
  }
  const segments = text.split(/[?#]/)[0]!.replace(/\/+$/, '').split('/');
  // A link may go on past the repository (/tree/main/src). The short form is two parts and nothing else.
  if (segments.length < 2 || (!fromUrl && segments.length !== 2)) return null;
  const owner = segments[0]!;
  const name = segments[1]!.replace(/\.git$/i, '');
  if (NOT_AN_OWNER.has(owner.toLowerCase()) || name === '.' || name === '..' || name.length === 0) return null;
  const repository = `${owner}/${name}`;
  return REPOSITORY_PATTERN.test(repository) ? repository : null;
}

/** What was saved, kept only where it is the shape a project has: settings come back from storage and the server unchecked. */
function savedProjects(value: unknown): Project[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const projects: Project[] = [];
  for (const entry of value as unknown[]) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const repository = typeof record['repository'] === 'string' ? record['repository'].trim() : '';
    if (!isRepository(repository) || seen.has(projectId(repository))) continue;
    seen.add(projectId(repository));
    projects.push({
      id: projectId(repository),
      repository,
      runner: RUNNERS.has(String(record['runner'])) ? (record['runner'] as ProjectRunner) : 'actions',
      createdAt: typeof record['createdAt'] === 'string' ? record['createdAt'] : new Date(0).toISOString(),
      ...(typeof record['defaultBranch'] === 'string' && record['defaultBranch'].length > 0 ? { defaultBranch: record['defaultBranch'] } : {}),
      ...(typeof record['private'] === 'boolean' ? { private: record['private'] } : {}),
      ...(record['implied'] === true ? { implied: true as const } : {}),
    });
  }
  return projects;
}

/**
 * Every project: the ones set up on purpose, then any other repository a
 * workflow is attached to. A workspace from before there were projects has
 * none saved, and its default repository counts as one too.
 */
export function projectsOf(settings: Pick<Settings, 'projects' | 'defaultRepository'>, workflows: Iterable<Workflow>): Project[] {
  const saved = savedProjects(settings.projects);
  const projects = [...(saved ?? [])];
  const known = new Set(projects.map((project) => project.id));
  const implied = new Map<string, Project>();
  const imply = (repository: string | undefined, createdAt: string) => {
    if (!isRepository(repository)) return;
    const id = projectId(repository);
    if (known.has(id)) return;
    const existing = implied.get(id);
    if (existing === undefined) implied.set(id, { id, repository: repository.trim(), runner: 'actions', createdAt, implied: true });
    else if (createdAt < existing.createdAt) existing.createdAt = createdAt;
  };
  // A starter workflow a guest's browser was seeded with is nobody's project.
  for (const workflow of workflows) if (workflow.demo !== true) imply(workflow.repository, workflow.createdAt);
  if (saved === null) imply(settings.defaultRepository, new Date(0).toISOString());
  return [...projects, ...[...implied.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))];
}

/** The project the studio is showing, or `null` for all of them. */
export function activeProjectOf(settings: Pick<Settings, 'activeProject'>, projects: Project[]): Project | null {
  if (typeof settings.activeProject !== 'string') return null;
  return projects.find((project) => project.id === settings.activeProject) ?? null;
}

/**
 * Whether a workflow shows under a project. One attached to no repository yet
 * shows under every project: it is waiting for one. The starter workflows a
 * guest's browser is seeded with are examples, not anybody's work, and show
 * only where everything does.
 */
export function inProject(project: Project | null, workflow: Pick<Workflow, 'repository' | 'demo'>): boolean {
  if (project === null) return true;
  if (workflow.demo === true) return false;
  if (!isRepository(workflow.repository)) return true;
  return sameRepository(workflow.repository, project.repository);
}

/** A project's own workflows: the ones attached to its repository, not the ones still waiting for one. */
export function workflowsOf(project: Project, workflows: Iterable<Workflow>): Workflow[] {
  return [...workflows].filter((workflow) => sameRepository(workflow.repository, project.repository));
}

/** Whether any of a project's workflows has its files in the repository. Each workflow has files of its own, so each is installed by itself. */
export function isInstalled(project: Project, workflows: Iterable<Workflow>): boolean {
  return workflowsOf(project, workflows).some((workflow) => workflow.installedAt !== undefined);
}

/** The runs to show under a project: those of its workflows, and those a runner made in its repository for a workflow since deleted. */
export function runsIn(project: Project | null, runs: Run[], workflows: Record<string, Workflow>): Run[] {
  if (project === null) return runs;
  return runs.filter((run) => {
    const workflow = workflows[run.workflowId];
    if (workflow !== undefined) return inProject(project, workflow);
    return sameRepository(run.machine?.repository, project.repository);
  });
}

type ProjectSettings = Pick<Settings, 'projects' | 'activeProject' | 'defaultRepository'>;

/** The same project, as one somebody set up rather than one read off a workflow. */
function setUp(project: Project): Project {
  const next = { ...project };
  delete next.implied;
  return next;
}

/**
 * Sets a repository up as a project, or changes the one that is already
 * there, and makes it the project the studio is showing. New workflows
 * attach to the project in view, which is what `defaultRepository` holds.
 */
export function withProject(
  settings: ProjectSettings,
  workflows: Iterable<Workflow>,
  input: { repository: string; runner?: ProjectRunner; defaultBranch?: string; private?: boolean },
  now = new Date().toISOString(),
): ProjectSettings {
  const repository = input.repository.trim();
  const id = projectId(repository);
  const all = projectsOf(settings, workflows);
  const existing = all.find((project) => project.id === id);
  const next: Project = {
    // Set up on purpose now, whatever it was before.
    ...setUp(existing ?? { id, repository, runner: 'actions', createdAt: now }),
    ...(input.runner === undefined ? {} : { runner: input.runner }),
    ...(input.defaultBranch === undefined ? {} : { defaultBranch: input.defaultBranch }),
    ...(input.private === undefined ? {} : { private: input.private }),
  };
  return { projects: existing === undefined ? [...all, next] : all.map((project) => (project.id === id ? next : project)), activeProject: id, defaultRepository: next.repository };
}

/** Changes one project where it stands, without switching the studio to it. Somebody deciding where it runs has set it up. */
export function withProjectPatch(settings: ProjectSettings, workflows: Iterable<Workflow>, id: string, patch: Partial<Pick<Project, 'runner' | 'defaultBranch' | 'private'>>): ProjectSettings {
  const all = projectsOf(settings, workflows);
  return { projects: all.map((project) => (project.id === id ? { ...setUp(project), ...patch } : project)), activeProject: settings.activeProject ?? null, defaultRepository: settings.defaultRepository };
}

/** Takes a project out. Its workflows are the caller's to delete first: one left attached would bring the project straight back. */
export function withoutProject(settings: ProjectSettings, workflows: Iterable<Workflow>, id: string): ProjectSettings {
  const remaining = projectsOf(settings, workflows).filter((project) => project.id !== id);
  const wasActive = settings.activeProject === id;
  const wasDefault = projectId(settings.defaultRepository) === id;
  return {
    projects: remaining,
    activeProject: wasActive ? null : (settings.activeProject ?? null),
    defaultRepository: wasDefault ? (remaining[0]?.repository ?? '') : settings.defaultRepository,
  };
}

/** Shows one project, or all of them with `null`. New workflows attach to the one in view. */
export function withActiveProject(settings: ProjectSettings, workflows: Iterable<Workflow>, id: string | null): ProjectSettings {
  const all = projectsOf(settings, workflows);
  const project = id === null ? null : (all.find((entry) => entry.id === id) ?? null);
  return { projects: all, activeProject: project?.id ?? null, defaultRepository: project?.repository ?? settings.defaultRepository };
}
