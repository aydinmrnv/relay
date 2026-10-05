import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { BRAND } from '@/lib/brand';
import { NODE_TYPES } from '@/lib/connectors';
import { nodeSupport, REAL_NODE_TYPES, testRunsOnly } from '@/lib/workflow/engine/support';
import { evaluateFilter } from '@/lib/workflow/engine/expression';
import { isSimulatedOnly, readiness, realRunGaps } from '@/lib/workflow/readiness';
import { simulateRun } from '@/lib/workflow/simulate';
import type { Workflow, WorkflowNode } from '@/lib/workflow/schema';
import { instantiateTemplate, TEMPLATES } from '@/lib/workflow/templates';

// What the engine and the studio must agree on lives in the CLI (`src/graph/`)
// and is copied here byte for byte. A copy that drifted would have a test run
// take a branch a real run does not, or the canvas call a step real that the
// engine skips.
const SHARED = ['expression.ts', 'support.ts'];

test('the studio’s copies of the engine’s shared files are the engine’s, byte for byte', async () => {
  for (const name of SHARED) {
    const [ours, theirs] = await Promise.all([readFile(new URL(`../src/lib/workflow/engine/${name}`, import.meta.url), 'utf8'), readFile(new URL(`../../src/graph/${name}`, import.meta.url), 'utf8')]);
    assert.equal(ours, theirs, `web/src/lib/workflow/engine/${name} has drifted from src/graph/${name}: run \`npm run sync:studio\` at the repository root`);
  }
});

test('every step the engine calls real is a step the catalog has', () => {
  const catalog = new Set(NODE_TYPES.map((def) => def.id));
  assert.deepEqual(REAL_NODE_TYPES.filter((type) => !catalog.has(type)), [], 'a node type on the engine’s table that the studio cannot draw');
});

test('only what nothing can perform is badged “test runs only”', () => {
  const badged = NODE_TYPES.filter((def) => isSimulatedOnly(def.id)).map((def) => def.id);
  assert.deepEqual(badged, ['logic.action.transform']);
  // An app Relay has no connection to is not that: a real run hands the step to the person's bridge, or says it skipped it.
  const zendesk = NODE_TYPES.find((def) => def.connectorId === 'zendesk' && def.kind === 'action')!;
  assert.deepEqual([nodeSupport(zendesk.id).real, nodeSupport(zendesk.id).bridge, testRunsOnly(zendesk.id)], [false, true, false]);
  for (const real of ['gates.action.approval', 'http.trigger.webhook', 'logic.action.condition', 'logic.action.filter', 'logic.action.ai-step', 'schedule.action.delay', 'pipeline.action.estimate']) {
    assert.equal(nodeSupport(real).real, true, real);
  }
});

function template(id: string): Workflow {
  const workflow = instantiateTemplate(id, BRAND, 'acme/api');
  assert.ok(workflow, id);
  return workflow;
}

test('each template says how it starts, and which of its steps a real run does not perform itself', () => {
  const starts = Object.fromEntries(TEMPLATES.map((meta) => [meta.id, readiness(template(meta.id)).unattended]));
  assert.deepEqual(
    starts,
    {
      'ticket-to-pr': true,
      'label-run': true,
      'ci-fix': true,
      'sentry-fix': true,
      'support-fix': false,
      'slack-to-pr': false,
      'backlog-triage': true,
      'code-scanning-fix': true,
      'dependency-upgrades': true,
      'flag-cleanup': false,
    },
    'what relay workflow serve can keep: a schedule, a label, and the webhooks GitHub, Linear and Sentry sign. Zendesk, Slack and LaunchDarkly are not read yet',
  );
  assert.match(readiness(template('ticket-to-pr')).detail, /point Linear’s webhook at it/);
  assert.match(readiness(template('support-fix')).detail, /Nothing listens for Zendesk events yet/);
  // Linear ticket to pull request: every step is performed, by Linear's API and a Slack webhook.
  assert.deepEqual(realRunGaps(template('ticket-to-pr')), []);
  for (const meta of TEMPLATES) for (const gap of realRunGaps(template(meta.id))) assert.equal(gap.bridge, true, `${meta.id}: ${gap.name} can at least be handed to a bridge`);
});

test('a test run evaluates a Filter the way a real run does', async () => {
  const node = (typeId: string, id: string, config: Record<string, unknown> = {}): WorkflowNode => ({ id, type: 'wf', position: { x: 0, y: 0 }, data: { typeId, config } });
  const workflow = (expression: string): Workflow => ({
    id: 'wf_filter',
    name: 'Filter',
    description: '',
    nodes: [node('logic.trigger.manual', 'start'), node('logic.action.filter', 'filter', { expression }), node('pipeline.action.run', 'run')],
    edges: [{ id: 'e1', source: 'start', target: 'filter' }, { id: 'e2', source: 'filter', target: 'run' }],
    enabled: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  });
  const payload = { id: 'ENG-1', title: 'Fix it', labels: ['bug'], priority: 'high' };
  const run = (expression: string) => simulateRun(workflow(expression), { speed: 'instant', brand: BRAND, seed: 7, payload });

  const passed = await run('issue.labels contains "bug" && issue.priority == "high"');
  assert.deepEqual([passed.nodeStatus['filter'], passed.nodeStatus['run']], ['done', 'done']);
  const stopped = await run('issue.priority == "low"');
  assert.deepEqual([stopped.nodeStatus['filter'], stopped.nodeStatus['run']], ['done', 'skipped']);
  assert.match(stopped.events.find((event) => event.nodeId === 'filter' && event.kind === 'node-finished')?.message ?? '', /Did not pass/);
  const broken = await run('issue.priority ==');
  assert.deepEqual([broken.nodeStatus['filter'], broken.status], ['failed', 'failed']);
  assert.deepEqual(evaluateFilter('issue.priority == "high"', { issue: payload }), { ok: true, value: true });
});
