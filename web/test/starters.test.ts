import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BRAND } from '@/lib/brand';
import { compileWorkflow } from '@/lib/workflow/compile';
import type { Workflow } from '@/lib/workflow/schema';
import { asksOf, buildStarter, fitWorkflow, startsOn, STARTERS, type StarterOptions } from '@/lib/workflow/starters';
import { instantiateTemplate } from '@/lib/workflow/templates';
import { validateWorkflow } from '@/lib/workflow/validate';

const OPTIONS: StarterOptions = { repository: 'acme/api', label: 'relay:go', authors: ['@octocat', ' hubot ', ''], maxRunCostUsd: 6, maxDailyCostUsd: 30, agents: 'both', review: 'standard' };

function starter(id: (typeof STARTERS)[number]['id'], options: Partial<StarterOptions> = {}): Workflow {
  const workflow = buildStarter(id, BRAND, { ...OPTIONS, ...options });
  assert.ok(workflow, `starter ${id} builds`);
  return workflow;
}

function config(workflow: Workflow, typeId: string): Record<string, unknown> {
  const node = workflow.nodes.find((entry) => entry.data.typeId === typeId);
  assert.ok(node, `${workflow.name} has ${typeId}`);
  return node.data.config;
}

test('every starter builds a workflow the validator accepts, attached to the repository', () => {
  for (const { id } of STARTERS) {
    const workflow = starter(id);
    assert.equal(workflow.repository, 'acme/api');
    assert.equal(workflow.enabled, false, 'a workflow made by setup starts paused, like any other');
    const errors = validateWorkflow(workflow).issues.filter((issue) => issue.level === 'error');
    assert.deepEqual(errors, [], `${id}: ${errors.map((issue) => issue.message).join('; ')}`);
  }
});

test('the answers land in the nodes that take them', () => {
  const workflow = starter('issue-to-pr', { label: 'ship-it', agents: 'claude', review: 'thorough' });
  assert.equal(config(workflow, 'github-issues.trigger.issue-labelled')['label'], 'ship-it');
  assert.deepEqual(config(workflow, 'gates.action.allowlist'), { ...config(workflow, 'gates.action.allowlist'), authors: 'octocat\nhubot', teams: '' });
  const budget = config(workflow, 'gates.action.budget');
  assert.equal(budget['maxRunCostUsd'], 6);
  assert.equal(budget['maxDailyCostUsd'], 30);
  const pipeline = config(workflow, 'pipeline.action.run');
  assert.deepEqual([pipeline['planner'], pipeline['planReviewer'], pipeline['implementer'], pipeline['codeReviewer'], pipeline['review']], ['claude', 'claude', 'claude', 'claude', 'thorough']);
});

test('with both agents, neither reviews its own work', () => {
  const pipeline = config(starter('issue-to-pr'), 'pipeline.action.run');
  assert.notEqual(pipeline['planner'], pipeline['planReviewer']);
  assert.notEqual(pipeline['implementer'], pipeline['codeReviewer']);
});

test('the issue starters export with nothing in the way: real logins, a repository, a budget', () => {
  for (const id of ['issue-to-pr', 'quick-fix'] as const) {
    const compiled = compileWorkflow(starter(id), BRAND);
    assert.deepEqual(compiled.blockers, [], id);
    assert.equal(compiled.start.by, 'label');
    assert.equal(compiled.start.label, 'relay:go');
    const relay = JSON.parse(compiled.files.find((file) => file.path === '.relay/config.json')!.content) as { unattended: { authors: string[]; teams: string[]; maxRunCostUsd: number; maxDailyCostUsd: number } };
    assert.deepEqual(relay.unattended.authors, ['octocat', 'hubot']);
    assert.deepEqual(relay.unattended.teams, []);
    assert.equal(relay.unattended.maxRunCostUsd, 6);
    assert.equal(relay.unattended.maxDailyCostUsd, 30);
    assert.ok(!compiled.warnings.some((warning) => /allowlist is empty|No budget gate/.test(warning)), compiled.warnings.join('\n'));
  }
});

test('the template these are cut from would not export: that is what setup is for', () => {
  const template = instantiateTemplate('label-run', BRAND, 'acme/api')!;
  assert.ok(compileWorkflow(template, BRAND).blockers.some((blocker) => /example names/.test(blocker)));
});

test('a starter with nobody on its allowlist still builds, and the export says nobody may start it', () => {
  const compiled = compileWorkflow(starter('issue-to-pr', { authors: [] }), BRAND);
  assert.ok(compiled.warnings.some((warning) => /allowlist is empty/.test(warning)));
});

test('the quick fix is one agent in one session, on the same connections', () => {
  const full = starter('issue-to-pr');
  const quick = starter('quick-fix', { agents: 'claude', label: 'relay:quick' });
  assert.equal(quick.name, 'Quick fix from an issue');
  assert.ok(!quick.nodes.some((node) => node.data.typeId === 'pipeline.action.run'));
  assert.equal(config(quick, 'pipeline.action.fast')['implementer'], 'claude');
  assert.equal(quick.edges.length, full.edges.length);
  assert.deepEqual(asksOf(quick), { label: true, allowlist: true, budget: true, review: false, agents: true });
  assert.deepEqual(asksOf(full), { label: true, allowlist: true, budget: true, review: true, agents: true });
});

test('fitting a workflow adds no gate it did not have', () => {
  const template = instantiateTemplate('dependency-upgrades', BRAND, '')!;
  const fitted = fitWorkflow(template, OPTIONS);
  assert.equal(fitted.nodes.length, template.nodes.length);
  assert.equal(fitted.repository, 'acme/api');
});

test('how a starter starts is what the runner really does', () => {
  const issue = starter('issue-to-pr');
  const onActions = startsOn(issue, 'actions', BRAND);
  assert.equal(onActions.itself, true);
  assert.match(onActions.detail, /relay:go/);

  // The exported Action works on one issue per run: a failed build or a clock does not start it there.
  for (const id of ['ci-fix', 'dependency-upgrades'] as const) {
    assert.equal(startsOn(starter(id), 'actions', BRAND).itself, false, id);
  }
  // A machine running `relay workflow serve` keeps a clock.
  assert.equal(startsOn(starter('dependency-upgrades'), 'machine', BRAND).itself, true);
});

test('the export tells a new repository to let Actions open pull requests, which GitHub leaves off', () => {
  const setup = compileWorkflow(starter('issue-to-pr'), BRAND).files.find((file) => file.path === 'SETUP.md')!.content;
  assert.match(setup, /Allow GitHub Actions to create and approve pull requests/);
  assert.match(setup, /gh api -X PUT repos\/acme\/api\/actions\/permissions\/workflow -F can_approve_pull_request_reviews=true/);
  // The fence around the command is a fence, not three escaped backticks.
  assert.ok(setup.includes('```bash\ngh api -X PUT'));
});
