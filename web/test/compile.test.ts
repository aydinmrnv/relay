import assert from 'node:assert/strict';
import { test } from 'node:test';
import yaml from 'js-yaml';
import { BRAND } from '@/lib/brand';
import { getNodeType } from '@/lib/connectors';
import { compileWorkflow, type CompiledOutput } from '@/lib/workflow/compile';
import type { Workflow, WorkflowNode } from '@/lib/workflow/schema';
import { instantiateTemplate, TEMPLATES } from '@/lib/workflow/templates';

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  env?: Record<string, string>;
  run?: string;
}

interface ActionFile {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: { relay: { if?: string; steps: Step[] } };
}

function template(id: string): Workflow {
  const workflow = instantiateTemplate(id, BRAND, 'acme/api');
  assert.ok(workflow, `template ${id} exists`);
  return workflow;
}

function actionOf(compiled: CompiledOutput): ActionFile {
  const file = compiled.files.find((entry) => entry.language === 'yaml');
  assert.ok(file, 'the export has a workflow file');
  return yaml.load(file.content) as ActionFile;
}

function step(action: ActionFile, name: string): Step {
  const found = action.jobs.relay.steps.find((entry) => entry.name === name);
  assert.ok(found, `step “${name}” is in the Action; it has: ${action.jobs.relay.steps.map((entry) => entry.name ?? entry.uses).join(' | ')}`);
  return found;
}

function node(typeId: string, id: string, config: Record<string, unknown> = {}): WorkflowNode {
  assert.ok(getNodeType(typeId), `${typeId} is in the catalog`);
  return { id, type: 'wf', position: { x: 0, y: 0 }, data: { typeId, config } };
}

function workflowOf(nodes: WorkflowNode[], edges: Array<[string, string, string?]>): Workflow {
  const now = new Date(0).toISOString();
  return {
    id: 'wf_test',
    name: 'Test workflow',
    description: '',
    nodes,
    edges: edges.map(([source, target, sourceHandle], index) => ({ id: `e${index}`, source, target, sourceHandle: sourceHandle ?? null })),
    enabled: true,
    createdAt: now,
    updatedAt: now,
    repository: 'acme/api',
  };
}

test('every template exports a workflow file that is valid YAML', () => {
  for (const meta of TEMPLATES) {
    const action = actionOf(compileWorkflow(template(meta.id)));
    assert.ok(Array.isArray(action.jobs.relay.steps) && action.jobs.relay.steps.length > 0, meta.id);
    assert.ok('workflow_dispatch' in action.on && 'repository_dispatch' in action.on, meta.id);
    for (const entry of action.jobs.relay.steps) assert.ok(entry.uses !== undefined || typeof entry.run === 'string', `${meta.id}: ${entry.name} does something`);
  }
});

test('steps run on the branch the canvas put them on, not on every run', () => {
  const action = actionOf(compileWorkflow(template('ci-fix')));
  const ready = step(action, 'Slack: Ask for review');
  const refused = step(action, 'Tell #builds it needs a person');
  assert.match(ready.if ?? '', /steps\.result\.outputs\.status == 'succeeded'/);
  assert.match(refused.if ?? '', /stopped-by == 'budget'/);
  assert.match(refused.if ?? '', /started != 'true'/);
  for (const entry of action.jobs.relay.steps.filter((candidate) => candidate.env?.['SLACK_WEBHOOK_URL'] !== undefined)) {
    assert.notEqual(entry.if, 'always()', `${entry.name} is conditional`);
  }
});

test('a step the Action cannot decide is left out and named in a warning', () => {
  const compiled = compileWorkflow(template('sentry-fix'));
  const action = actionOf(compiled);
  assert.equal(action.jobs.relay.steps.find((entry) => entry.name === 'File it for a person'), undefined);
  assert.ok(compiled.warnings.some((warning) => warning.includes('Left out of the Action') && warning.includes('File it for a person')));
});

test('the `on:` block follows the trigger', () => {
  const labelled = actionOf(compileWorkflow(template('label-run')));
  assert.deepEqual(labelled.on['issues'], { types: ['labeled'] });
  assert.match(labelled.jobs.relay.if ?? '', /github\.event\.label\.name == 'relay:go'/);

  // Nothing but a GitHub issue event can start the Action: a schedule has no issue to work on.
  const scheduled = compileWorkflow(template('dependency-upgrades'));
  const action = actionOf(scheduled);
  assert.equal(action.on['schedule'], undefined);
  assert.equal(action.on['issues'], undefined);
  assert.equal(scheduled.start.by, 'dispatch');
  assert.ok(scheduled.warnings.some((warning) => warning.startsWith('A schedule has no issue')));

  const linear = compileWorkflow(template('ticket-to-pr'));
  assert.equal(actionOf(linear).on['issues'], undefined);
  assert.ok(linear.warnings.some((warning) => warning.includes('Linear') && warning.includes('Nothing in the export listens')));
});

test('Codex finds its sign-in where the export put it', () => {
  const file = compileWorkflow(template('label-run')).files.find((entry) => entry.language === 'yaml')!;
  assert.doesNotMatch(file.content, /CODEX_HOME/);
  assert.doesNotMatch(file.content, /env\.HOME/);
  assert.match(file.content, /\$HOME\/\.codex\/auth\.json/);
});

test('the Action is installed from a tag that exists, and nothing names an npm package nobody owns', () => {
  const compiled = compileWorkflow(template('label-run'));
  const all = compiled.files.map((file) => file.content).join('\n');
  assert.match(all, /uses: aydinmrnv\/relay@v1/);
  assert.doesNotMatch(all, /relay-orchestrator/);
  assert.doesNotMatch(all, /relay@main/);
});

test('secrets typed into node fields are in none of the exported files', () => {
  const workflow = workflowOf(
    [
      node('http.trigger.webhook', 'hook', { secret: 'whsec_PLANTED_ONE', path: 'ticket-in' }),
      node('pipeline.action.run', 'run'),
      node('http.action.request', 'call', { method: 'POST', url: 'https://api.example.com/done', headers: '{ "authorization": "Bearer PLANTED_TWO" }', body: '{"pr": "{{run.prUrl}}"}' }),
      node('linear.action.comment', 'note', { body: 'done', apiKey: 'lin_PLANTED_THREE' }),
    ],
    [['hook', 'run'], ['run', 'call'], ['run', 'note']],
  );
  const compiled = compileWorkflow(workflow);
  for (const file of compiled.files) assert.doesNotMatch(file.content, /PLANTED/, file.path);
  assert.ok(compiled.secrets.some((secret) => secret.name === 'HTTP_HEADERS'));
});

test('an HTTP request step is valid YAML and sends its headers from a secret', () => {
  const workflow = workflowOf(
    [
      node('logic.trigger.manual', 'start'),
      node('pipeline.action.run', 'run'),
      node('http.action.request', 'call', { method: 'PUT', url: 'https://api.example.com/done', headers: '{ "x-key": "abc" }', body: '{"pr": "{{run.prUrl}}"}' }),
    ],
    [['start', 'run'], ['run', 'call']],
  );
  const call = step(actionOf(compileWorkflow(workflow)), 'HTTP & webhooks: HTTP request');
  assert.match(call.run ?? '', /curl -fsS -X PUT/);
  assert.match(call.run ?? '', /content-type: application\/json/);
  assert.equal(call.env?.['URL'], 'https://api.example.com/done');
  assert.equal(call.env?.['HEADERS'], '${{ secrets.HTTP_HEADERS }}');
  assert.equal(call.env?.['BODY'], '{"pr": "${{ steps.result.outputs.pr-url }}"}');
});

test('a message keeps its line breaks, and a variable the Action cannot fill in stays visible', () => {
  const workflow = workflowOf(
    [
      node('logic.trigger.manual', 'start'),
      node('pipeline.action.run', 'run'),
      node('slack.action.post-message', 'post', { channel: '#builds', text: 'Red since {{issue.commit}} ({{issue.job}})\n{{issue.title}} ${{ secrets.GITHUB_TOKEN }}' }),
    ],
    [['start', 'run'], ['run', 'post']],
  );
  const compiled = compileWorkflow(workflow);
  const post = step(actionOf(compiled), 'Slack: Post message');
  const text = post.env?.['TEXT'] ?? '';
  assert.ok(text.includes('\n'), 'a real newline, not the two characters backslash and n');
  assert.ok(text.startsWith('Red since [issue.commit] ([issue.job])'));
  assert.ok(text.includes('${{ steps.issue.outputs.title }}'));
  assert.ok(!text.includes('${{ secrets.GITHUB_TOKEN }}'), 'typed text does not become an expression');
  assert.ok(compiled.warnings.some((warning) => warning.includes('{{issue.commit}}') && warning.includes('{{issue.job}}')));
});

test('a real run is held to the Budget gate’s per-run cap', () => {
  const config = JSON.parse(compileWorkflow(template('label-run')).files[0]!.content) as { workflow: { maxCostUsd: number | null }; unattended: { maxRunCostUsd: number | null } };
  assert.equal(config.workflow.maxCostUsd, config.unattended.maxRunCostUsd);
  assert.ok(config.workflow.maxCostUsd !== null);
});
