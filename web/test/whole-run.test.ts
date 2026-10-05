import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BRAND } from '@/lib/brand';
import { getNodeType, NODE_TYPES } from '@/lib/connectors';
import { createMachineRun, MachineRunFold } from '@/lib/companion/machine-run';
import type { RunStreamRecord, RunTask } from '@/lib/companion/types';
import { compileWorkflow } from '@/lib/workflow/compile';
import type { Run, Workflow, WorkflowNode } from '@/lib/workflow/schema';
import { simulateRun } from '@/lib/workflow/simulate';
import { nodeSupport } from '@/lib/workflow/engine/support';
import { instantiateTemplate, TEMPLATES } from '@/lib/workflow/templates';

/**
 * The whole path a real run takes, end to end across the two packages: the
 * studio compiles a canvas, the CLI's own executor walks what was compiled
 * (with the world played by a list), and the studio folds the lines the
 * executor printed back onto the canvas. If the three disagree about a node,
 * a handle or a record, it shows here.
 */
type Records = Array<Record<string, unknown>>;
interface Engine {
  parseGraph: (value: unknown) => unknown;
  executeGraph: (graph: unknown, event: unknown, effects: unknown, options?: unknown) => Promise<{ status: string; exitCode: number }>;
  manualEvent: (task: RunTask, now: Date) => unknown;
}
const [types, executor, events] = await Promise.all(['types', 'executor', 'events'].map((name) => import(new URL(`../../src/graph/${name}.ts`, import.meta.url).href)));
const engine = { ...types, ...executor, ...events } as Engine;

const NOW = new Date('2026-10-05T10:00:00.000Z');
const PR = 'https://github.com/acme/api/pull/143';

interface World {
  records: Records;
  posted: Array<{ url: string; body: unknown }>;
  linear: string[];
}

function effects(made: World, options: { env?: Record<string, string>; approve?: boolean } = {}): unknown {
  return {
    now: () => NOW,
    sleep: async () => undefined,
    signal: new AbortController().signal,
    env: options.env ?? {},
    fetch: async (url: string, init: { body: string }) => {
      made.posted.push({ url, body: JSON.parse(init.body) });
      return new Response('ok', { status: 200 });
    },
    emit: (record: Record<string, unknown>) => made.records.push(record),
    stopReason: async () => null,
    spend: async () => ({ spentUsd: 0, runs: 0, unpriced: 0, inFlight: 0 }),
    estimate: async () => null,
    teamOf: async () => null,
    approval: async (_ask: unknown, announce: (how: string) => void) => {
      announce('Approve with relay workflow approve ap-test1234.');
      return { approved: options.approve !== false, by: 'lead', reason: 'answered' };
    },
    runPipeline: async ({ onLine }: { onLine: (line: Record<string, unknown>) => void }) => {
      const at = NOW.toISOString();
      const run = {
        runId: '20261005T100000-abc234',
        shortId: 'abc234',
        branch: 'relay/eng-142',
        agents: { planner: 'claude', planReviewer: 'codex', implementer: 'codex', codeReviewer: 'claude' },
        issue: { title: 'Fix the flaky timeout', url: 'https://linear.app/acme/issue/ENG-142' },
        diff: { fileCount: 3, additions: 40, deletions: 7 },
        tests: { command: ['npm', 'test'], passed: true, discovered: true, durationMs: 9000, skippedReason: null },
        pullRequest: { url: PR, number: 143 },
        delivery: { policy: 'pr', reached: 'pr', steps: [{ step: 'commit', status: 'done' }, { step: 'push', status: 'done' }, { step: 'pullRequest', status: 'done' }] },
        usage: { total: { costUsd: 1.84 }, byPhase: { PLANNING: { costUsd: 0.5 } } },
      };
      for (const line of [
        { type: 'run_started', at, runId: run.runId, shortId: run.shortId, agents: run.agents },
        { type: 'phase_started', at, phase: 'PLANNING', phaseLabel: 'Planning', detail: null },
        { type: 'phase_completed', at, phase: 'PLANNING', phaseLabel: 'Planning', durationMs: 120_000, status: 'done' },
        { type: 'phase_started', at, phase: 'DELIVERING', phaseLabel: 'Delivering', detail: null },
        { type: 'phase_completed', at, phase: 'DELIVERING', phaseLabel: 'Delivering', durationMs: 4000, status: 'done' },
        { type: 'summary', at, exitCode: 0, run },
      ]) onLine({ schema: 1, command: 'run', ...line });
      return { exitCode: 0, error: null, run };
    },
    aiStep: async () => ({ ok: true, text: 'fixable', agent: 'Claude Code' }),
    gh: async () => ({ ok: true, stdout: '', stderr: '' }),
    linear: async (query: string) => {
      made.linear.push(query.split('(')[0]!.trim());
      if (query.startsWith('query Issue')) return { issue: { id: 'uuid-1', team: { states: { nodes: [{ id: 's1', name: 'In Review' }] } } } };
      return { attachmentCreate: { success: true }, issueUpdate: { success: true }, commentCreate: { success: true } };
    },
  };
}

/** Compiles, runs in the engine, and folds what the engine printed back into a studio run. */
async function runWhole(workflow: Workflow, task: RunTask, options: Parameters<typeof effects>[1] = {}): Promise<{ run: Run; made: World }> {
  const made: World = { records: [], posted: [], linear: [] };
  const compiled = compileWorkflow(workflow);
  const outcome = await engine.executeGraph(engine.parseGraph(compiled.graph), engine.manualEvent(task, NOW), effects(made, options));

  const run = createMachineRun(workflow, { scope: 'workflow', id: 'run_whole1', companionRunId: 'sr_1', host: 'laptop', repository: 'acme/api', task, startedAt: NOW.toISOString() });
  const fold = new MachineRunFold(run, workflow, () => NOW.toISOString());
  const stream: RunStreamRecord[] = [...made.records.map((data, seq): RunStreamRecord => ({ seq, type: 'engine', data })), { seq: made.records.length, type: 'exit', code: outcome.exitCode, error: null }];
  for (const record of stream) fold.apply(record);
  assert.equal(fold.finished, true);
  return { run: fold.run, made };
}

const statusByType = (workflow: Workflow, run: Run): Record<string, string> => Object.fromEntries(workflow.nodes.map((node) => [`${node.data.typeId}${node.data.label === undefined ? '' : `:${node.data.label}`}`, run.nodeStatus[node.id]!]));

test('a real run of the Linear template lights every node it took, and skips the path it did not', async () => {
  const workflow = instantiateTemplate('ticket-to-pr', BRAND, 'acme/api')!;
  const { run, made } = await runWhole(workflow, { kind: 'issue', ref: 'ENG-142' }, { env: { SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x' } });

  assert.equal(run.status, 'succeeded');
  assert.equal(run.machine?.scope, 'workflow');
  assert.deepEqual(statusByType(workflow, run), {
    'linear.trigger.issue-assigned': 'done',
    'gates.action.budget': 'done',
    'pipeline.action.run': 'done',
    'delivery.action.deliver': 'done',
    'linear.action.attach-pr': 'done',
    'linear.action.update-state': 'done',
    'slack.action.share-pr': 'done',
    'linear.action.comment:Tell the ticket why': 'skipped',
  });
  assert.deepEqual([run.prUrl, run.costUsd, run.branch, run.tests?.passed], [PR, 1.84, 'relay/eng-142', true]);
  // Performed, not played: the ticket was moved and the channel was told, with the pull request the run opened.
  assert.deepEqual(made.linear.filter((call) => call.startsWith('mutation')), ['mutation Attach', 'mutation Move']);
  assert.equal(made.posted.length, 1);
  assert.match((made.posted[0]!.body as { text: string }).text, /pull\/143/);
  // Nothing is said twice: one finish per node, and no "nodes not run here".
  const finishes = run.events.filter((event) => event.kind === 'node-finished');
  assert.equal(new Set(finishes.map((event) => event.nodeId)).size, finishes.length);
  assert.ok(!run.events.some((event) => /not run here/.test(event.message)));
  assert.equal(run.events.at(-1)?.kind, 'run-finished');
  assert.match(run.summary ?? '', /Linear ticket to pull request · .*\$1\.84.*pull\/143/);
});

function node(typeId: string, id: string, config: Record<string, unknown> = {}, label?: string): WorkflowNode {
  assert.ok(getNodeType(typeId), typeId);
  return { id, type: 'wf', position: { x: 0, y: 0 }, data: { typeId, config, ...(label === undefined ? {} : { label }) } };
}

function workflowOf(nodes: WorkflowNode[], edges: Array<[string, string, string?]>): Workflow {
  const at = new Date(0).toISOString();
  return { id: 'wf_whole', name: 'Whole', description: '', nodes, edges: edges.map(([source, target, sourceHandle], index) => ({ id: `e${index}`, source, target, sourceHandle: sourceHandle ?? null })), enabled: true, createdAt: at, updatedAt: at, repository: 'acme/api' };
}

test('an approval that is rejected is a refused run, with the pipeline never started', async () => {
  const workflow = workflowOf(
    [node('logic.trigger.manual', 'start'), node('gates.action.approval', 'gate'), node('pipeline.action.run', 'run'), node('slack.action.post-message', 'told', { text: 'Rejected: {{issue.title}}' })],
    [['start', 'gate'], ['gate', 'run', 'approved'], ['gate', 'told', 'rejected']],
  );
  const { run, made } = await runWhole(workflow, { kind: 'prompt', text: 'Fix the flaky timeout' }, { approve: false, env: { SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x' } });
  assert.equal(run.status, 'refused');
  assert.deepEqual([run.nodeStatus['gate'], run.nodeStatus['run'], run.nodeStatus['told']], ['refused', 'skipped', 'done']);
  assert.ok(run.events.some((event) => event.nodeId === 'gate' && event.status === 'waiting' && /relay workflow approve/.test(event.detail ?? '')), 'the canvas says how to answer while it waits');
  assert.deepEqual(made.posted.map((entry) => entry.body), [{ text: 'Rejected: Fix the flaky timeout' }]);
});

test('a step Relay cannot perform is shown as skipped with the reason, never as done', async () => {
  const zendesk = NODE_TYPES.find((def) => def.connectorId === 'zendesk' && def.kind === 'action');
  assert.ok(zendesk, 'the catalog has a Zendesk action');
  const workflow = workflowOf(
    [node('logic.trigger.manual', 'start'), node('pipeline.action.run', 'run'), node(zendesk.id, 'note'), node('slack.action.post-message', 'after', { text: 'done' })],
    [['start', 'run'], ['run', 'note'], ['note', 'after']],
  );
  const { run } = await runWhole(workflow, { kind: 'prompt', text: 'Fix it' });
  assert.equal(run.nodeStatus['note'], 'skipped');
  assert.match(run.events.find((event) => event.nodeId === 'note' && event.kind === 'node-finished')?.message ?? '', /^Not performed: Relay has no connection to zendesk yet/);
  // The step after it ran, and failed for its own stated reason: no webhook was set.
  assert.equal(run.nodeStatus['after'], 'failed');
  assert.equal(run.status, 'failed');
  assert.equal(run.prUrl, PR, 'the pull request is still the run’s');
});

test('a runner that cannot walk the graph still gets the pipeline-only record', () => {
  const workflow = instantiateTemplate('ticket-to-pr', BRAND, 'acme/api')!;
  const run = createMachineRun(workflow, { id: 'run_old', companionRunId: 'sr_2', host: 'laptop', repository: 'acme/api', task: { kind: 'issue', ref: 'ENG-142' }, startedAt: NOW.toISOString() });
  assert.equal(run.machine?.scope, undefined);
  assert.ok(Object.values(run.nodeStatus).includes('skipped'));
  assert.ok(run.events.some((event) => /not run here/.test(event.message)));
});

test('every template that starts by itself carries the two ceilings an event needs before it may start the agents', async () => {
  let checked = 0;
  for (const template of TEMPLATES) {
    const workflow = instantiateTemplate(template.id, BRAND, 'acme/api')!;
    const graph = compileWorkflow(workflow).graph as { nodes: Array<{ id: string; type: string; kind: string }>; config: { unattended?: Record<string, unknown> } };
    const trigger = graph.nodes.find((entry) => entry.kind === 'trigger')!;
    const pipeline = graph.nodes.find((entry) => entry.type === 'pipeline.action.run' || entry.type === 'pipeline.action.fast');
    if (pipeline === undefined || !nodeSupport(trigger.type).real || trigger.type === 'logic.trigger.manual') continue;
    checked += 1;
    assert.equal(typeof graph.config.unattended?.['maxRunCostUsd'], 'number', `${template.id} has no per-run cost`);
    assert.equal(typeof graph.config.unattended?.['maxDailyCostUsd'], 'number', `${template.id} has no daily budget`);

    // And the engine agrees: walked for an event nobody is watching, the pipeline is not refused for want of a ceiling.
    const made: World = { records: [], posted: [], linear: [] };
    const event = { id: 'delivery-1', source: 'webhook', attended: false, actor: 'maintainer', payload: { id: 'ENG-142', key: 'ENG-142', title: 'Fix the flaky timeout', body: 'It fails on CI.', labels: ['bug'] }, task: { kind: 'prompt', text: 'Fix the flaky timeout' }, at: NOW.toISOString() };
    await engine.executeGraph(engine.parseGraph(graph), event, effects(made, { env: { SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x' } }), { dryRun: true });
    const said = made.records.filter((record) => record['type'] === 'node_finished').map((record) => String(record['message']));
    assert.ok(!said.some((message) => /no ceiling on what they spend/.test(message)), `${template.id}: ${said.join(' | ')}`);
  }
  assert.ok(checked >= 5, `only ${checked} templates start by themselves`);
});

test('a test run and a real one agree about a step that two paths lead to', async () => {
  // The allowlist passes and the budget refuses: the "tell them why" step both gates share runs once, and the Merge paths after it carries on.
  const workflow = workflowOf(
    [
      node('logic.trigger.manual', 'start'),
      node('logic.action.condition', 'small', { left: '{{issue.title}}', op: 'contains', right: 'flaky' }),
      node('logic.action.condition', 'urgent', { left: '{{issue.title}}', op: 'contains', right: 'outage' }),
      node('slack.action.post-message', 'told', { text: 'Not started: {{issue.title}}' }),
      node('pipeline.action.run', 'run'),
      node('logic.action.merge-paths', 'join'),
      node('slack.action.post-message', 'after', { text: 'Looked at: {{issue.title}}' }),
    ],
    [['start', 'small'], ['small', 'urgent', 'true'], ['small', 'told', 'false'], ['urgent', 'run', 'true'], ['urgent', 'told', 'false'], ['run', 'join'], ['told', 'join'], ['join', 'after']],
  );
  const { run, made } = await runWhole(workflow, { kind: 'prompt', text: 'Fix the flaky timeout' }, { env: { SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x' } });
  assert.deepEqual([run.nodeStatus['told'], run.nodeStatus['run'], run.nodeStatus['join'], run.nodeStatus['after']], ['done', 'skipped', 'done', 'done']);
  assert.deepEqual(made.posted.map((entry) => (entry.body as { text: string }).text), ['Not started: Fix the flaky timeout', 'Looked at: Fix the flaky timeout']);

  // The studio's own test run walks the same canvas to the same statuses.
  const played = await simulateRun(workflow, { speed: 'instant', brand: BRAND, seed: 7, payload: { title: 'Fix the flaky timeout' } });
  assert.deepEqual([played.nodeStatus['told'], played.nodeStatus['run'], played.nodeStatus['join'], played.nodeStatus['after']], ['done', 'skipped', 'done', 'done']);
});
