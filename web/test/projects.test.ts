import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BRAND } from '@/lib/brand';
import { activeProjectOf, inProject, isInstalled, parseRepository, projectsOf, runsIn, withActiveProject, withProject, withProjectPatch, withoutProject, workflowsOf } from '@/lib/projects';
import { shellPath, shellQuote } from '@/lib/shell';
import type { Run, Workflow } from '@/lib/workflow/schema';
import { blankWorkflow } from '@/lib/workflow/templates';

function workflow(repository: string, patch: Partial<Workflow> = {}): Workflow {
  return { ...blankWorkflow(BRAND, repository), ...patch };
}

const NONE = { defaultRepository: '' };

test('a repository is read out of whatever somebody pastes', () => {
  assert.equal(parseRepository('acme/api'), 'acme/api');
  assert.equal(parseRepository('  acme/api  '), 'acme/api');
  assert.equal(parseRepository('https://github.com/acme/api'), 'acme/api');
  assert.equal(parseRepository('https://github.com/acme/api/'), 'acme/api');
  assert.equal(parseRepository('https://github.com/acme/api.git'), 'acme/api');
  assert.equal(parseRepository('github.com/acme/api/tree/main/src'), 'acme/api');
  assert.equal(parseRepository('https://www.github.com/acme/api?tab=readme#top'), 'acme/api');
  assert.equal(parseRepository('git@github.com:acme/api.git'), 'acme/api');
  assert.equal(parseRepository('ssh://git@github.com/acme/api.git'), 'acme/api');
  assert.equal(parseRepository('acme/next.js'), 'acme/next.js');
  assert.equal(parseRepository('ssh://git@github.com:22/acme/api.git'), 'acme/api');
  assert.equal(parseRepository('https://token@github.com/acme/api.git'), 'acme/api');
  assert.equal(parseRepository('git://github.com/acme/api'), 'acme/api');
  assert.equal(parseRepository('acme/-rf'), 'acme/-rf');
});

test('what is not a GitHub repository is refused', () => {
  for (const value of ['', 'acme', 'acme/', '/api', 'https://gitlab.com/acme/api', 'https://example.com/acme/api', 'acme api/x', 'acme/a b', 'https://github.com/acme']) {
    assert.equal(parseRepository(value), null, value);
  }
  // GitHub's own pages are not accounts, the short form is two parts, and a name a shell reads as a place is no name.
  for (const value of ['https://github.com/orgs/acme/repositories', 'https://github.com/settings/profile', 'acme/api/extra/segments', 'acme/..', 'acme/.', 'https://github.com/acme/..']) {
    assert.equal(parseRepository(value), null, value);
  }
});

test('what goes into a command somebody pastes is one argument, whatever it says', () => {
  assert.equal(shellQuote('relay:go'), 'relay:go');
  assert.equal(shellQuote('needs agent'), "'needs agent'");
  assert.equal(shellQuote('Fix $(touch /tmp/x) `id`'), "'Fix $(touch /tmp/x) `id`'");
  assert.equal(shellQuote('go"; echo PWNED; "'), `'go"; echo PWNED; "'`);
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote(''), "''");
  // A leading dash would be read as an option.
  assert.equal(shellQuote('-rf'), "'-rf'");
  assert.equal(shellPath('-rf'), './-rf');
  assert.equal(shellPath('api'), 'api');
});

test('a workspace from before projects gets them from its workflows and its default repository', () => {
  const projects = projectsOf({ defaultRepository: 'acme/web' }, [workflow('acme/api', { createdAt: '2026-01-02T00:00:00.000Z' }), workflow('Acme/API', { createdAt: '2026-01-01T00:00:00.000Z' }), workflow('')]);
  // Nobody said where these run, and they say so.
  assert.deepEqual(
    projects.map((project) => [project.id, project.runner, project.implied]),
    [
      ['acme/web', 'actions', true],
      ['acme/api', 'actions', true],
    ],
  );
  // The earliest workflow dates the project.
  assert.equal(projects[1]?.createdAt, '2026-01-01T00:00:00.000Z');
});

test('a starter workflow seeded into a guest’s browser is nobody’s project', () => {
  assert.deepEqual(projectsOf(NONE, [workflow('acme/api', { demo: true })]), []);
});

test('once projects are saved, the default repository no longer makes one, and a workflow’s repository still does', () => {
  const settings = { projects: [{ id: 'acme/api', repository: 'acme/api', runner: 'machine' as const, createdAt: '2026-01-01T00:00:00.000Z' }], defaultRepository: 'acme/old' };
  assert.deepEqual(
    projectsOf(settings, [workflow('acme/docs')]).map((project) => [project.id, project.runner]),
    [
      ['acme/api', 'machine'],
      ['acme/docs', 'actions'],
    ],
  );
});

test('saved projects that are not projects are left out, and a repository is listed once', () => {
  const saved = [{ repository: 'acme/api', runner: 'warp-drive' }, { repository: 'ACME/api', runner: 'cloud' }, { repository: 'not a repository' }, null, 'acme/api'];
  const projects = projectsOf({ projects: saved as never, defaultRepository: '' }, []);
  assert.equal(projects.length, 1);
  assert.equal(projects[0]?.runner, 'actions');
});

test('adding a project switches the studio to it, and adding it again updates it in place', () => {
  const first = withProject({ defaultRepository: '' }, [], { repository: 'acme/api', runner: 'actions', defaultBranch: 'trunk', private: false }, '2026-02-01T00:00:00.000Z');
  assert.equal(first.activeProject, 'acme/api');
  assert.equal(first.defaultRepository, 'acme/api');
  assert.deepEqual(first.projects, [{ id: 'acme/api', repository: 'acme/api', runner: 'actions', createdAt: '2026-02-01T00:00:00.000Z', defaultBranch: 'trunk', private: false }]);

  const second = withProject(first, [], { repository: 'acme/web', runner: 'machine' });
  assert.deepEqual(second.projects?.map((project) => project.id), ['acme/api', 'acme/web']);
  assert.equal(second.activeProject, 'acme/web');

  const again = withProject(second, [], { repository: 'Acme/API', runner: 'cloud' });
  assert.deepEqual(again.projects?.map((project) => [project.id, project.runner, project.createdAt]), [
    ['acme/api', 'cloud', '2026-02-01T00:00:00.000Z'],
    ['acme/web', 'machine', second.projects?.[1]?.createdAt],
  ]);
  // What GitHub said about it the first time is kept when the second time says nothing.
  assert.equal(again.projects?.[0]?.defaultBranch, 'trunk');
});

test('a project is changed without switching to it', () => {
  const settings = withProject(withProject({ defaultRepository: '' }, [], { repository: 'acme/api' }), [], { repository: 'acme/web' });
  const patched = withProjectPatch(settings, [], 'acme/api', { runner: 'machine' });
  assert.equal(patched.activeProject, 'acme/web');
  assert.equal(patched.projects?.[0]?.runner, 'machine');
});

test('a project read off a workflow stays a guess until somebody sets it up', () => {
  const legacy = [workflow('acme/api')];
  // Looking at it is not setting it up: the note survives being saved.
  const viewed = withActiveProject({ defaultRepository: '' }, legacy, 'acme/api');
  assert.equal(viewed.projects?.[0]?.implied, true);
  assert.equal(projectsOf(viewed, legacy)[0]?.implied, true);
  // Saying where it runs is, and so is going through setup for it.
  assert.equal(withProjectPatch(viewed, legacy, 'acme/api', { runner: 'machine' }).projects?.[0]?.implied, undefined);
  assert.equal(withProject(viewed, legacy, { repository: 'acme/api' }).projects?.[0]?.implied, undefined);
});

test('a project is installed when one of its own workflows is', () => {
  const settings = withProject({ defaultRepository: '' }, [], { repository: 'acme/api' });
  const project = projectsOf(settings, [])[0]!;
  assert.equal(isInstalled(project, [workflow('acme/api'), workflow('acme/web', { installedAt: '2026-03-01T00:00:00.000Z' })]), false);
  assert.equal(isInstalled(project, [workflow('acme/api'), workflow('ACME/api', { installedAt: '2026-03-01T00:00:00.000Z' })]), true);
});

test('the project in view decides which workflows and runs show, and where new workflows attach', () => {
  const api = workflow('acme/api');
  const web = workflow('acme/web');
  const loose = workflow('');
  const all = [api, web, loose];
  const settings = withActiveProject({ defaultRepository: '' }, all, 'acme/web');
  assert.equal(settings.defaultRepository, 'acme/web');
  const projects = projectsOf(settings, all);
  const active = activeProjectOf(settings, projects);
  assert.equal(active?.id, 'acme/web');
  // A workflow attached to nothing is waiting for a repository, so it shows under every project, and belongs to none.
  assert.deepEqual(all.filter((entry) => inProject(active, entry)), [web, loose]);
  // An example a guest's browser was seeded with is not waiting for anything.
  assert.equal(inProject(active, workflow('', { demo: true })), false);
  assert.equal(inProject(null, workflow('', { demo: true })), true);
  assert.deepEqual(workflowsOf(active!, all), [web]);

  const run = (id: string, workflowId: string, repository?: string): Run =>
    ({ id, workflowId, ...(repository === undefined ? {} : { machine: { repository } }) }) as Run;
  const runs = [run('r1', api.id), run('r2', web.id), run('r3', 'wf_deleted', 'acme/web'), run('r4', 'wf_deleted', 'acme/api'), run('r5', 'wf_deleted')];
  const map = { [api.id]: api, [web.id]: web };
  assert.deepEqual(runsIn(active, runs, map).map((entry) => entry.id), ['r2', 'r3']);
  assert.equal(runsIn(null, runs, map).length, 5);

  const everything = withActiveProject(settings, all, null);
  assert.equal(everything.activeProject, null);
  assert.equal(activeProjectOf(everything, projects), null);
  // Showing all of them does not forget where new workflows were going.
  assert.equal(everything.defaultRepository, 'acme/web');
});

test('a project id that is no longer there shows everything rather than nothing', () => {
  assert.equal(activeProjectOf({ activeProject: 'acme/gone' }, projectsOf(NONE, [workflow('acme/api')])), null);
});

test('removing a project falls back to another one for new workflows', () => {
  const settings = withProject(withProject({ defaultRepository: '' }, [], { repository: 'acme/api' }), [], { repository: 'acme/web' });
  const removed = withoutProject(settings, [], 'acme/web');
  assert.deepEqual(removed.projects?.map((project) => project.id), ['acme/api']);
  assert.equal(removed.activeProject, null);
  assert.equal(removed.defaultRepository, 'acme/api');
  const none = withoutProject(removed, [], 'acme/api');
  assert.deepEqual(none.projects, []);
  assert.equal(none.defaultRepository, '');
});
