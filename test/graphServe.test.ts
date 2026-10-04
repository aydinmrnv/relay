import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { exitJsonMode } from '../src/cli/json.ts';
import { restoreHumanOutput, setTheme } from '../src/cli/output.ts';
import { checkWorkflow, loadWorkflow, resolveWorkflowFile, workflowApprovalsCommand, workflowCheckCommand, workflowDecideCommand, workflowRunCommand } from '../src/cli/commands/workflow.ts';
import { createApproval, listApprovals } from '../src/graph/approvals.ts';
import { createEffects, pipelineOverlay } from '../src/graph/effects.ts';
import { manualEvent, signBody, webhookEvent } from '../src/graph/events.ts';
import { executeGraph, type GraphOutcome } from '../src/graph/executor.ts';
import { serveWorkflow, type ServeLog } from '../src/graph/serve.ts';
import { parseGraph, type GraphRecord, type WorkflowEvent, type WorkflowGraph } from '../src/graph/types.ts';
import { DEFAULT_CONFIG } from '../src/storage/config.ts';
import type { RelayLauncher } from '../src/studio/runs.ts';
import { createTempRepo, FakeIssueProvider, type TempRepo } from './helpers/tempRepo.ts';

/**
 * The real effects, against a real process, a real socket and real files.
 * `relay run --json` is played by a script; Slack is a server on this machine.
 */

/** Stands in for `relay run --json`: says what it was started with, then summarises a run that opened a pull request. */
const FAKE_RUN = `
import { readFileSync, writeFileSync } from 'node:fs';
const line = (value) => process.stdout.write(JSON.stringify({ schema: 1, command: 'run', ...value }) + '\\n');
const overlay = JSON.parse(readFileSync(process.env.RELAY_CONFIG_OVERLAY, 'utf8'));
writeFileSync(process.env.FAKE_RUN_SEEN, JSON.stringify({ argv: process.argv.slice(2), overlay, trigger: process.env.RELAY_RUN_TRIGGER ?? null, slack: process.env.SLACK_WEBHOOK_URL ?? null }));
line({ type: 'run_started', at: '2026-10-05T10:00:00.000Z', runId: '20261005T100000-abc234', shortId: 'abc234', issueRef: '142', agents: { codeReviewer: 'claude' } });
line({ type: 'phase_completed', at: '2026-10-05T10:02:00.000Z', phase: 'PLANNING', phaseLabel: 'Planning', durationMs: 120000, status: 'done' });
const code = Number(process.env.FAKE_RUN_EXIT ?? '0');
line({ type: 'summary', at: '2026-10-05T10:10:00.000Z', exitCode: code, run: {
  runId: '20261005T100000-abc234', shortId: 'abc234', branch: 'relay/142', agents: { codeReviewer: 'claude' },
  issue: { number: 142, title: 'Add authentication rate limiting', url: 'https://github.com/acme/widgets/issues/142' },
  diff: { fileCount: 2, additions: 30, deletions: 4 }, tests: { passed: code === 0, discovered: true, skippedReason: null },
  pullRequest: code === 0 ? { url: 'https://github.com/acme/widgets/pull/143', number: 143 } : null,
  delivery: code === 0 ? { reached: 'pr', steps: [{ step: 'commit', status: 'done' }, { step: 'pullRequest', status: 'done' }] } : null,
  usage: { total: { costUsd: 1.5 } },
} });
process.exitCode = code;
`;

let repo: TempRepo;
let originalCwd: string;
let launcher: RelayLauncher;
let seenPath: string;
let chat: Server;
let chatUrl: string;
let posted: Array<{ path: string; body: unknown }>;
const saved: Record<string, string | undefined> = {};

const node = (id: string, type: string, config: Record<string, unknown> = {}, outputs: string[] = ['out']) => ({ id, type, kind: type.split('.')[1], name: id, config, outputs });

function workflow(trigger: string, extra: Partial<Record<'enabled' | 'config', unknown>> = {}, triggerConfig: Record<string, unknown> = {}): WorkflowGraph {
  return parseGraph({
    version: 1,
    id: 'wf_e2e',
    name: 'Ticket to pull request',
    repository: 'acme/widgets',
    enabled: true,
    nodes: [
      node('trigger', trigger, triggerConfig),
      node('allow', 'gates.action.allowlist', { authors: 'maintainer' }, ['pass', 'refused']),
      node('budget', 'gates.action.budget', { maxRunCostUsd: 4, maxDailyCostUsd: 20 }, ['pass', 'refused']),
      node('pipeline', 'pipeline.action.run'),
      node('deliver', 'delivery.action.deliver'),
      node('slack', 'slack.action.share-pr', { text: '{{issue.title}}: {{run.prUrl}} ({{run.cost}})' }),
    ],
    edges: [
      { from: 'trigger', to: 'allow' },
      { from: 'allow', to: 'budget', handle: 'pass' },
      { from: 'budget', to: 'pipeline', handle: 'pass' },
      { from: 'pipeline', to: 'deliver' },
      { from: 'deliver', to: 'slack' },
    ],
    config: {
      version: 1,
      agents: { planner: 'claude', planReviewer: 'codex', implementer: 'codex', codeReviewer: 'claude' },
      workflow: { review: 'standard', deliver: 'merge', maxCostUsd: 4 },
      unattended: { enabled: true, authors: ['maintainer'], teams: [], maxDailyCostUsd: 20, maxRunCostUsd: 4, deliver: 'pr', injectionScreen: 'refuse', pollSeconds: 60 },
    },
    ...extra,
  });
}

beforeEach(async () => {
  originalCwd = process.cwd();
  repo = await createTempRepo();
  process.chdir(repo.root);
  setTheme({ color: false, unicode: true, interactive: false });
  const script = join(repo.root, '..', 'fake-run.mjs');
  await writeFile(script, FAKE_RUN);
  launcher = { command: process.execPath, args: [script] };
  seenPath = join(repo.root, '..', 'seen.json');
  for (const name of ['FAKE_RUN_SEEN', 'FAKE_RUN_EXIT', 'SLACK_WEBHOOK_URL', 'RELAY_WEBHOOK_SECRET']) saved[name] = process.env[name];
  process.env['FAKE_RUN_SEEN'] = seenPath;
  delete process.env['FAKE_RUN_EXIT'];

  posted = [];
  chat = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      posted.push({ path: request.url ?? '', body: JSON.parse(body || 'null') });
      response.writeHead(request.url === '/down' ? 500 : 200).end('ok');
    });
  });
  await new Promise<void>((resolve) => chat.listen(0, '127.0.0.1', () => resolve()));
  chatUrl = `http://127.0.0.1:${(chat.address() as AddressInfo).port}`;
});

afterEach(async () => {
  process.chdir(originalCwd);
  exitJsonMode();
  restoreHumanOutput();
  setTheme(undefined);
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  chat.closeAllConnections();
  await new Promise<void>((resolve) => chat.close(() => resolve()));
  await repo.cleanup();
});

async function runReal(graph: WorkflowGraph, event: WorkflowEvent, env: Record<string, string> = {}, signal: AbortSignal = new AbortController().signal): Promise<{ outcome: GraphOutcome; records: GraphRecord[] }> {
  const records: GraphRecord[] = [];
  const effects = createEffects({
    repoRoot: repo.root,
    config: structuredClone(DEFAULT_CONFIG),
    harnesses: {},
    issueProvider: new FakeIssueProvider(),
    graph,
    signal,
    emit: (record) => records.push(record),
    env: { ...process.env, ...env },
    launcher,
    approvalPollMs: 10,
  });
  return { outcome: await executeGraph(graph, event, effects), records };
}

const seen = async (): Promise<{ argv: string[]; overlay: Record<string, Record<string, unknown>>; trigger: string | null; slack: string | null }> => JSON.parse(await readFile(seenPath, 'utf8'));

describe('a workflow, with the real effects', () => {
  it('starts relay run as a child for an attended start, and posts the pull request it opened', async () => {
    const { outcome, records } = await runReal(workflow('logic.trigger.manual'), manualEvent({ kind: 'issue', ref: '142' }, new Date()), { SLACK_WEBHOOK_URL: `${chatUrl}/hook` });

    assert.equal(outcome.status, 'succeeded');
    const started = await seen();
    assert.deepEqual(started.argv, ['run', '--json', '--no-offer-merge', '--', '142']);
    assert.equal(started.trigger, null, 'a person started it: the run carries no trigger');
    assert.equal(started.overlay['workflow']?.['deliver'], 'pr', 'a workflow run never merges, whatever the canvas says');
    assert.equal(started.overlay['workflow']?.['maxCostUsd'], 4);
    assert.equal(started.overlay['unattended'], undefined);
    assert.deepEqual(posted, [{ path: '/hook', body: { text: 'Add authentication rate limiting: https://github.com/acme/widgets/pull/143 ($1.50)' } }]);
    // The engine's own lines are in the stream, between the pipeline node's start and finish.
    const types = records.map((record) => record.type as string);
    assert.ok(types.includes('phase_completed') && types.includes('summary'));
  });

  it('marks a run a webhook started as unattended, under the unattended ceiling', async () => {
    const event = webhookEvent({ title: 'Fix it', body: 'Steps.', actor: 'maintainer' }, { now: new Date() });
    const { outcome } = await runReal(workflow('http.trigger.webhook'), event, { SLACK_WEBHOOK_URL: `${chatUrl}/hook` });

    assert.equal(outcome.status, 'succeeded');
    const started = await seen();
    assert.deepEqual(started.argv, ['run', '--json', '--no-offer-merge', '--prompt=Fix it\n\nSteps.']);
    const trigger = JSON.parse(started.trigger ?? 'null') as { label: string; actor: string };
    assert.deepEqual([trigger.label, trigger.actor], ['an incoming webhook (workflow “Ticket to pull request”)', 'maintainer']);
    assert.deepEqual(started.overlay['unattended'], { maxRunCostUsd: 4, deliver: 'pr', injectionScreen: 'refuse' });
  });

  it('refuses a stranger’s webhook before any process is started', async () => {
    const { outcome } = await runReal(workflow('http.trigger.webhook'), webhookEvent({ title: 'Fix it', actor: 'stranger' }, { now: new Date() }));
    assert.equal(outcome.status, 'refused');
    await assert.rejects(readFile(seenPath, 'utf8'), /ENOENT/);
    assert.equal(posted.length, 0);
  });

  it('reports a failed run with the engine’s own exit code, and posts nothing after it', async () => {
    process.env['FAKE_RUN_EXIT'] = '5';
    const { outcome } = await runReal(workflow('logic.trigger.manual'), manualEvent({ kind: 'issue', ref: '142' }, new Date()), { SLACK_WEBHOOK_URL: `${chatUrl}/hook` });
    assert.deepEqual([outcome.status, outcome.exitCode], ['failed', 5]);
    assert.equal(outcome.nodes['deliver'], 'skipped');
    assert.equal(posted.length, 0);
  });

  it('says a chat app refused the message, and still reports the pull request', async () => {
    const { outcome, records } = await runReal(workflow('logic.trigger.manual'), manualEvent({ kind: 'issue', ref: '142' }, new Date()), { SLACK_WEBHOOK_URL: `${chatUrl}/down` });
    assert.deepEqual([outcome.status, outcome.exitCode], ['failed', 1]);
    const slack = records.find((record) => record.type === 'node_finished' && record.node === 'slack');
    assert.equal(slack?.type === 'node_finished' ? slack.message : '', 'Slack answered HTTP 500.');
    assert.match(outcome.summary, /pull\/143/);
  });

  it('holds at an approval until the file is answered, from anywhere', async () => {
    const graph = parseGraph({
      version: 1,
      id: 'wf_approval',
      name: 'Approve first',
      nodes: [node('trigger', 'logic.trigger.manual'), node('gate', 'gates.action.approval', { timeoutHours: 1 }, ['approved', 'rejected']), node('pipeline', 'pipeline.action.run')],
      edges: [{ from: 'trigger', to: 'gate' }, { from: 'gate', to: 'pipeline', handle: 'approved' }],
      config: { version: 1 },
    });
    const running = runReal(graph, manualEvent({ kind: 'prompt', text: 'Fix it' }, new Date()));
    let waiting = await listApprovals(repo.root);
    for (let tries = 0; waiting.length === 0 && tries < 200; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      waiting = await listApprovals(repo.root);
    }
    assert.equal(waiting.length, 1);
    await assert.rejects(readFile(seenPath, 'utf8'), /ENOENT/, 'nothing starts while it waits');

    assert.equal(await workflowDecideCommand(true, waiting[0]!.id, { as: 'maintainer', json: true }), 0);
    const { outcome, records } = await running;
    assert.equal(outcome.status, 'succeeded');
    const gate = records.find((record) => record.type === 'node_finished' && record.node === 'gate');
    assert.equal(gate?.type === 'node_finished' ? gate.message : '', 'Approved by maintainer.');
    const told = records.find((record) => record.type === 'node_waiting');
    assert.match(told?.type === 'node_waiting' ? (told.detail ?? '') : '', new RegExp(`relay workflow approve ${waiting[0]!.id}`));
  });

  it('gives the unattended overlay only what an unattended run reads', () => {
    const graph = workflow('http.trigger.webhook');
    const attended = pipelineOverlay(graph, manualEvent({ kind: 'prompt', text: 'x' }, new Date()));
    assert.equal(attended['unattended'], undefined);
    const unattended = pipelineOverlay(graph, webhookEvent({ title: 'x' }, { now: new Date() }));
    assert.deepEqual(Object.keys(unattended['unattended'] as object).sort(), ['deliver', 'injectionScreen', 'maxRunCostUsd']);
  });
});

describe('relay workflow serve', () => {
  interface Serving {
    url: string;
    logs: ServeLog[];
    events: WorkflowEvent[];
    stop: () => void;
    done: Promise<unknown>;
  }

  async function serving(graph: WorkflowGraph, env: Record<string, string> = {}, options: { maxEvents?: number; host?: string } = {}): Promise<Serving> {
    const accepting = new AbortController();
    const logs: ServeLog[] = [];
    const events: WorkflowEvent[] = [];
    let address: { host: string; port: number; path: string } | undefined;
    const done = serveWorkflow({
      graph,
      env,
      port: 0,
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.maxEvents === undefined ? {} : { maxEvents: options.maxEvents }),
      signal: accepting.signal,
      runSignal: new AbortController().signal,
      log: (entry) => logs.push(entry),
      onListening: (bound) => (address = bound),
      run: async (event) => {
        events.push(event);
        return { status: 'succeeded', exitCode: 0, summary: 'ok', nodes: {}, pipeline: null, unwired: [], costUsd: null };
      },
    });
    for (let tries = 0; address === undefined && tries < 200; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(address !== undefined, 'the listener bound');
    return { url: `http://127.0.0.1:${address.port}${address.path}`, logs, events, stop: () => accepting.abort(), done };
  }

  const post = (url: string, body: string, headers: Record<string, string> = {}): Promise<Response> => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

  it('runs the workflow for a delivery, once, however many times it is sent', async () => {
    const live = await serving(workflow('http.trigger.webhook', {}, { path: 'ticket-in' }));
    try {
      assert.match(live.url, /\/hooks\/ticket-in$/);
      const body = JSON.stringify({ title: 'Fix it', actor: 'maintainer' });
      const first = await post(live.url, body);
      assert.equal(first.status, 202);
      const again = await post(live.url, body);
      assert.deepEqual([again.status, ((await again.json()) as { accepted: boolean }).accepted], [200, false]);
      for (let tries = 0; live.events.length === 0 && tries < 200; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(live.events.length, 1);
      assert.deepEqual([live.events[0]!.source, live.events[0]!.attended, live.events[0]!.actor], ['webhook', false, 'maintainer']);

      assert.equal((await fetch(live.url.replace('/hooks/ticket-in', '/healthz'))).status, 200);
      assert.equal((await post(live.url.replace('ticket-in', 'other'), body)).status, 404);
      assert.equal((await fetch(live.url)).status, 405);
      assert.equal((await post(live.url, 'not json')).status, 400);
      assert.equal((await post(live.url, JSON.stringify({ title: 'x'.repeat(1_100_000) }))).status, 413);
    } finally {
      live.stop();
      await live.done;
    }
  });

  it('takes only signed deliveries once a secret is set', async () => {
    const live = await serving(workflow('http.trigger.webhook'), { RELAY_WEBHOOK_SECRET: 's3cret' });
    try {
      const body = JSON.stringify({ title: 'Fix it' });
      assert.equal((await post(live.url, body)).status, 401);
      assert.equal((await post(live.url, body, { 'x-relay-signature': signBody('wrong', body) })).status, 401);
      assert.equal((await post(live.url, body, { 'x-relay-signature': signBody('s3cret', body) })).status, 202);
      assert.equal((await post(live.url, body, { 'x-hub-signature-256': signBody('s3cret', body), 'x-github-delivery': 'd-2' })).status, 202);
      assert.equal(live.logs.filter((entry) => entry.type === 'ignored').length, 2);
    } finally {
      live.stop();
      await live.done;
    }
  });

  it('will not listen beyond this machine without a secret', async () => {
    await assert.rejects(serveWorkflow({ graph: workflow('http.trigger.webhook'), env: {}, host: '0.0.0.0', port: 0, signal: new AbortController().signal, runSignal: new AbortController().signal, log: () => undefined, run: async () => assert.fail('nothing runs') }), /lets anyone who can reach it start a run/);
  });

  it('fires on the clock, at the minutes the cron expression names', async () => {
    let clock = new Date('2026-10-05T08:59:30Z').getTime();
    const events: WorkflowEvent[] = [];
    const outcome = await serveWorkflow({
      graph: workflow('schedule.trigger.cron', {}, { cron: '0 9 * * 1-5', timezone: 'UTC' }),
      env: {},
      maxEvents: 2,
      signal: new AbortController().signal,
      runSignal: new AbortController().signal,
      log: () => undefined,
      now: () => new Date(clock),
      sleep: async (ms) => void (clock += ms),
      run: async (event) => {
        events.push(event);
        return { status: 'succeeded', exitCode: 0, summary: 'ok', nodes: {}, pipeline: null, unwired: [], costUsd: null };
      },
    });
    assert.deepEqual(events.map((event) => event.at), ['2026-10-05T09:00:00.000Z', '2026-10-06T09:00:00.000Z']);
    assert.deepEqual([outcome.stoppedBy, outcome.events], ['limit', 2]);
    assert.equal(events[0]!.attended, false);
  });

  it('refuses a trigger nothing listens for, a cron it cannot read, and a workflow that starts by hand', async () => {
    const base = { env: {}, signal: new AbortController().signal, runSignal: new AbortController().signal, log: () => undefined, run: async (): Promise<GraphOutcome> => assert.fail('nothing runs') };
    await assert.rejects(serveWorkflow({ ...base, graph: workflow('sentry.trigger.issue-created') }), /Nothing listens for .* yet/);
    await assert.rejects(serveWorkflow({ ...base, graph: workflow('schedule.trigger.cron', {}, { cron: 'every day' }) }), /five fields/);
    await assert.rejects(serveWorkflow({ ...base, graph: workflow('logic.trigger.manual') }), /starts by hand/);
  });
});

describe('the relay workflow commands', () => {
  async function capture(run: () => Promise<number>): Promise<{ code: number; stdout: string }> {
    const original = process.stdout.write.bind(process.stdout);
    let stdout = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      return { code: await run(), stdout };
    } finally {
      process.stdout.write = original;
    }
  }

  async function install(graph: WorkflowGraph, name = 'ticket-to-pr'): Promise<string> {
    await mkdir(join(repo.root, '.relay', 'workflows'), { recursive: true });
    const file = join(repo.root, '.relay', 'workflows', `${name}.json`);
    await writeFile(file, JSON.stringify(graph));
    return file;
  }

  it('finds the one workflow a repository has, by name or by nothing at all', async () => {
    await assert.rejects(resolveWorkflowFile(repo.root, undefined), /has no workflow to run/);
    const file = await install(workflow('logic.trigger.manual'));
    assert.equal(await resolveWorkflowFile(repo.root, undefined), file);
    assert.equal(await resolveWorkflowFile(repo.root, 'ticket-to-pr'), file);
    await install(workflow('http.trigger.webhook'), 'second');
    await assert.rejects(resolveWorkflowFile(repo.root, undefined), /has 2 workflows; say which/);
    assert.equal((await loadWorkflow(file)).name, 'Ticket to pull request');
    await assert.rejects(loadWorkflow(join(repo.root, 'missing.json')), /Cannot read the workflow/);
  });

  it('check says what is real, what is missing, and whether it starts by itself', async () => {
    const graph = parseGraph({ ...workflow('http.trigger.webhook'), nodes: [...workflow('http.trigger.webhook').nodes, node('zendesk', 'zendesk.action.internal-note')] });
    const check = checkWorkflow(graph, '.relay/workflows/x.json', {});
    assert.equal(check.startsByItself, true);
    assert.equal(check.unwired, 1);
    assert.deepEqual(check.missing, ['SLACK_WEBHOOK_URL'], 'the webhook secret is optional on this machine');
    assert.deepEqual(checkWorkflow(graph, 'x', { SLACK_WEBHOOK_URL: 'https://hooks.slack.com/x' }).missing, []);
    assert.equal(checkWorkflow(workflow('linear.trigger.issue-assigned'), 'x', {}).startsByItself, false);

    await install(graph);
    const printed = await capture(() => workflowCheckCommand(undefined, { json: true }));
    const document = JSON.parse(printed.stdout) as { type: string; command: string; nodes: unknown[] };
    assert.deepEqual([printed.code, document.type, document.command, document.nodes.length], [0, 'workflow_check', 'workflow', 7]);
  });

  it('run walks the whole workflow in a dry run and prints one line per step as JSON', async () => {
    await install(workflow('logic.trigger.manual'));
    const printed = await capture(() => workflowRunCommand(undefined, undefined, { prompt: 'Fix the flaky timeout', dryRun: true, json: true }));
    assert.equal(printed.code, 0);
    const lines = printed.stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(lines.every((line) => line['schema'] === 1 && line['command'] === 'workflow'));
    assert.deepEqual([lines[0]!['type'], lines.at(-1)!['type'], lines.at(-1)!['status']], ['workflow_started', 'workflow_finished', 'succeeded']);
    assert.equal(lines.filter((line) => line['type'] === 'node_finished' && line['status'] === 'done').length, 6);
    await assert.rejects(readFile(seenPath, 'utf8'), /ENOENT/, 'a dry run starts nothing');
  });

  it('run treats an event file as a delivery nobody vetted, and refuses to guess what to work on', async () => {
    await install(workflow('http.trigger.webhook'));
    const event = join(repo.root, '..', 'event.json');
    await writeFile(event, JSON.stringify({ title: 'Fix it', actor: 'stranger' }));
    const printed = await capture(() => workflowRunCommand('ticket-to-pr', undefined, { event, dryRun: true, json: true }));
    const finished = JSON.parse(printed.stdout.trim().split('\n').at(-1)!) as { status: string };
    assert.deepEqual([printed.code, finished.status], [0, 'refused']);

    await assert.rejects(workflowRunCommand('ticket-to-pr', undefined, { json: true }), /Say what the workflow should work on/);
    await assert.rejects(workflowRunCommand('ticket-to-pr', '142', { prompt: 'x', json: true }), /one of the three/);
  });

  it('lists what is waiting for approval, and answers it', async () => {
    const record = await createApproval(repo.root, { workflow: 'W', node: 'gate', subject: 'Fix it', via: 'dashboard', approvers: [], expiresAt: new Date(Date.now() + 60_000) });
    const listed = await capture(() => workflowApprovalsCommand({ json: true }));
    assert.equal((JSON.parse(listed.stdout) as { approvals: Array<{ id: string; open: boolean }> }).approvals[0]?.id, record.id);
    assert.equal((await capture(() => workflowDecideCommand(false, record.id, { as: 'lead', json: true }))).code, 0);
    assert.deepEqual((JSON.parse((await capture(() => workflowApprovalsCommand({ json: true }))).stdout) as { approvals: unknown[] }).approvals, []);
    assert.equal((await listApprovals(repo.root))[0]?.status, 'rejected');
  });
});
