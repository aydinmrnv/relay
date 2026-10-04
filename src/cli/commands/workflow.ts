import { readdir, readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { approvalOpen, decideApproval, listApprovals, type ApprovalRecord } from '../../graph/approvals.ts';
import { createEffects } from '../../graph/effects.ts';
import { issueEvent, manualEvent, webhookEvent } from '../../graph/events.ts';
import { executeGraph, type GraphEffects, type GraphOutcome } from '../../graph/executor.ts';
import { DEFAULT_WEBHOOK_PORT, serveWorkflow, WEBHOOK_SECRET_VARIABLE, type ServeLog } from '../../graph/serve.ts';
import { nodeSupport } from '../../graph/support.ts';
import { parseGraph, triggerOf, type GraphRecord, type WorkflowEvent, type WorkflowGraph } from '../../graph/types.ts';
import { relayDir } from '../../storage/config.ts';
import { Prompter } from '../../ui/prompt.ts';
import { glyphs } from '../../ui/theme.ts';
import { errorMessage, RelayError } from '../../util/errors.ts';
import { formatDuration, oneLine, pluralize } from '../../util/text.ts';
import { createCliContext, type CliContext } from '../context.ts';
import { EXIT } from '../exit.ts';
import { emitJson, emitJsonLine } from '../json.ts';
import { bullet, command, dim, failure, hint, ok, out, rows, section, success, theme, warning } from '../output.ts';

/**
 * `relay workflow`: a workflow from the studio, run as it was drawn.
 *
 * `relay run` is the agent pipeline: one issue in, one reviewed change out.
 * A workflow is everything around it on the canvas — what starts it, the
 * guardrails in front, the conditions, the approval, the messages afterwards —
 * and until this command only the studio's test run walked that graph, with
 * made-up effects. Here the same walk happens for real: `run` for one event a
 * person supplies, `serve` to keep the workflow's own trigger, `check` to say
 * what each step needs and which steps Relay cannot perform yet.
 */

export interface WorkflowRunOptions {
  prompt?: string;
  event?: string;
  dryRun?: boolean;
  envFile?: string;
  verbose?: boolean;
  json?: boolean;
}

export interface WorkflowServeOptions {
  port?: string;
  host?: string;
  interval?: string;
  once?: boolean;
  dryRun?: boolean;
  envFile?: string;
  verbose?: boolean;
  json?: boolean;
}

export function workflowsDir(repoRoot: string): string {
  return join(relayDir(repoRoot), 'workflows');
}

/** The compiled workflows a repository holds, as paths. */
export async function listWorkflowFiles(repoRoot: string): Promise<string[]> {
  try {
    return (await readdir(workflowsDir(repoRoot))).filter((name) => name.endsWith('.json')).sort().map((name) => join(workflowsDir(repoRoot), name));
  } catch {
    return [];
  }
}

/**
 * Finds the workflow a command was asked for: a path, a name under
 * `.relay/workflows/`, or — when the repository holds exactly one — nothing
 * at all.
 */
export async function resolveWorkflowFile(repoRoot: string, ref: string | undefined, cwd: string = process.cwd()): Promise<string> {
  const files = await listWorkflowFiles(repoRoot);
  if (ref === undefined || ref.trim().length === 0) {
    if (files.length === 1) return files[0]!;
    throw new RelayError(files.length === 0 ? 'This repository has no workflow to run.' : `This repository has ${files.length} workflows; say which.`, {
      code: 'NO_WORKFLOW',
      hint:
        files.length === 0
          ? 'Export one from the studio (Export → Install into your repository), or name a file.'
          : `One of: ${files.map((file) => relative(workflowsDir(repoRoot), file).replace(/\.json$/, '')).join(', ')}.`,
    });
  }
  const named = files.find((file) => relative(workflowsDir(repoRoot), file).replace(/\.json$/, '') === ref.trim());
  return named ?? resolve(cwd, ref);
}

export async function loadWorkflow(path: string): Promise<WorkflowGraph> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new RelayError(`Cannot read the workflow at ${path}: ${errorMessage(error)}`, { code: 'NO_WORKFLOW', hint: 'Name a file the studio exported: .relay/workflows/<name>.json.' });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RelayError(`${path} is not JSON.`, { code: 'BAD_WORKFLOW' });
  }
  return parseGraph(value);
}

function loadEnvFile(path: string | undefined): void {
  if (path === undefined) return;
  try {
    process.loadEnvFile(resolve(path));
  } catch (error) {
    throw new RelayError(`Cannot read --env-file ${path}: ${errorMessage(error)}`, { code: 'BAD_FLAG' });
  }
}

/* ------------------------------------------------------------------ */
/* What a run prints                                                   */
/* ------------------------------------------------------------------ */

function mark(status: string): string {
  const glyph = glyphs(theme());
  switch (status) {
    case 'done':
      return success(glyph.ok);
    case 'refused':
      return warning('⊘');
    case 'failed':
      return failure(glyph.failed);
    case 'unwired':
      return warning('!');
    default:
      return dim(glyph.bullet);
  }
}

/** Prints one line of a workflow run for a person. Lines of the pipeline's own run are told in brief. */
export function printRecord(record: Record<string, unknown>, options: { verbose: boolean }): void {
  switch (record['type']) {
    case 'workflow_started': {
      const workflow = record['workflow'] as { name: string };
      const event = record['event'] as { attended: boolean; title: string; actor: string | null; source: string };
      section(workflow.name);
      out(dim(`  ${event.attended ? 'Started by hand' : `Started by ${event.source === 'issue' ? 'a label' : event.source === 'webhook' ? 'a webhook' : 'the clock'}${event.actor === null ? '' : `, from @${event.actor}`}`}: ${event.title}`));
      out();
      break;
    }
    case 'node_started':
      // The pipeline takes minutes; everything else is over before a "started" line would be read.
      if (String(record['nodeType']).startsWith('pipeline.action.') && record['nodeType'] !== 'pipeline.action.estimate') out(`  ${dim(glyphs(theme()).active)} ${String(record['name'])}`);
      break;
    case 'node_waiting':
      out(`  ${warning('…')} ${String(record['message'])}`);
      if (typeof record['detail'] === 'string') hint(record['detail'], '    ');
      break;
    case 'node_finished': {
      const status = String(record['status']);
      if (status === 'skipped') break;
      const took = Number(record['durationMs'] ?? 0);
      out(`  ${mark(status)} ${String(record['name'] ?? record['nodeType'])}  ${dim(String(record['message']))}${took >= 2_000 ? dim(`  ${formatDuration(took)}`) : ''}`);
      if ((status === 'failed' || status === 'refused' || options.verbose) && typeof record['detail'] === 'string' && record['detail'].length > 0) hint(oneLine(record['detail'], 400), '    ');
      break;
    }
    case 'phase_completed':
      out(dim(`      ${String(record['phaseLabel'] ?? record['phase'])}  ${formatDuration(Number(record['durationMs'] ?? 0))}${record['status'] === 'failed' ? '  failed' : ''}`));
      break;
    case 'run_started':
      out(dim(`      run ${String(record['shortId'] ?? record['runId'] ?? '')}`));
      break;
    case 'warning':
      out(dim(`      ! ${String(record['message'])}`));
      break;
    case 'note':
      if (options.verbose) out(dim(`      ${String(record['message'])}`));
      break;
    case 'workflow_finished': {
      const status = String(record['status']);
      out();
      const line = `${status === 'succeeded' ? 'Finished' : status === 'refused' ? 'Refused' : status === 'cancelled' ? 'Stopped' : 'Failed'}: ${String(record['summary'])}`;
      if (status === 'succeeded') ok(line);
      else out(`${status === 'failed' ? failure(glyphs(theme()).failed) : warning('⊘')} ${line}`);
      const unwired = (record['unwired'] as string[] | undefined) ?? [];
      if (unwired.length > 0) hint(`Not performed, because Relay cannot yet: ${unwired.join(', ')}. \`relay workflow check\` says why.`);
      break;
    }
    default:
      break;
  }
}

/** A record with the node's name on it, so a line can be printed without looking the node up. */
function named(graph: WorkflowGraph): (record: GraphRecord | Record<string, unknown>) => Record<string, unknown> {
  const names = new Map(graph.nodes.map((node) => [node.id, node.name]));
  return (record) => {
    const plain = record as Record<string, unknown>;
    return plain['type'] === 'node_finished' && plain['name'] === undefined ? { ...plain, name: names.get(String(plain['node'])) } : plain;
  };
}

function emitter(graph: WorkflowGraph, options: { json: boolean; verbose: boolean }): (record: GraphRecord) => void {
  const withName = named(graph);
  return (record) => {
    const line = record as unknown as Record<string, unknown>;
    if (options.json) {
      // The pipeline's own lines already carry `schema` and `command: "run"`: they pass through as they were printed.
      if (typeof line['schema'] === 'number') process.stdout.write(`${JSON.stringify(line)}\n`);
      else emitJsonLine('workflow', line);
      return;
    }
    printRecord(withName(line), { verbose: options.verbose });
  };
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

function terminalApproval(json: boolean): ((record: ApprovalRecord, signal: AbortSignal) => Promise<{ approved: boolean; by: string }>) | undefined {
  if (json) return undefined;
  const prompter = new Prompter();
  if (!prompter.interactive) {
    prompter.close();
    return undefined;
  }
  prompter.close();
  return async (record, signal) => {
    // A list of approvers is answered by name, which a y/n at this terminal cannot give.
    if (record.approvers.length > 0) return new Promise(() => undefined);
    const asking = new Prompter();
    signal.addEventListener('abort', () => asking.close(), { once: true });
    try {
      const approved = await asking.confirm(`  Approve “${oneLine(record.subject, 80)}”?`, false);
      return { approved, by: userInfo().username };
    } finally {
      asking.close();
    }
  };
}

/** Takes the trigger label off before the agents start: the acknowledgement, and how two servers do not both take one issue. */
function claimingLabel(effects: GraphEffects, cli: CliContext): GraphEffects {
  return {
    ...effects,
    async runPipeline(input) {
      const label = input.event.payload['triggerLabel'];
      if (input.event.source === 'issue' && typeof label === 'string' && input.task.kind === 'issue' && cli.issueProvider.removeLabel !== undefined) {
        const removed = await cli.issueProvider.removeLabel(input.task.ref, label, { signal: effects.signal }).catch(() => false);
        if (!removed) return { exitCode: EXIT.error, error: `The ${label} label was no longer on the issue: something else took it first.`, run: null };
      }
      return effects.runPipeline(input);
    },
  };
}

async function eventFor(cli: CliContext, graph: WorkflowGraph, issueRef: string | undefined, options: WorkflowRunOptions): Promise<WorkflowEvent> {
  const now = new Date();
  const given = [issueRef !== undefined && issueRef.trim().length > 0, options.prompt !== undefined, options.event !== undefined].filter(Boolean).length;
  if (given > 1) throw new RelayError('Name an issue, or pass --prompt, or pass --event: one of the three.', { code: 'BAD_FLAG' });

  if (options.event !== undefined) {
    let body: unknown;
    try {
      body = JSON.parse(await readFile(resolve(options.event), 'utf8'));
    } catch (error) {
      throw new RelayError(`Cannot read --event ${options.event} as JSON: ${errorMessage(error)}`, { code: 'BAD_FLAG' });
    }
    // An event file stands in for a delivery nobody vetted, so the guardrails decide, as they would for a real one.
    return webhookEvent(body, { now, linear: (process.env['LINEAR_API_KEY'] ?? '').trim().length > 0 });
  }
  if (options.prompt !== undefined) {
    if (options.prompt.trim().length === 0) throw new RelayError('--prompt is empty.', { code: 'BAD_FLAG' });
    return manualEvent({ kind: 'prompt', text: options.prompt.trim() }, now);
  }
  if (issueRef !== undefined && issueRef.trim().length > 0) {
    const ref = issueRef.trim();
    // Fetched here so a Condition can read the issue's labels and a message can name its title.
    const issue = await cli.issueProvider.getIssue(ref);
    return issueEvent(issue, ref, { attended: true, actor: null, now });
  }
  const trigger = triggerOf(graph);
  const preset = trigger.type === 'logic.trigger.manual' ? String(trigger.config['prompt'] ?? '').trim() : '';
  if (preset.length > 0) return manualEvent({ kind: 'prompt', text: preset }, now);
  throw new RelayError('Say what the workflow should work on.', {
    code: 'NO_ISSUE_REF',
    hint: 'Name an issue (`relay workflow run <workflow> 142`), describe the change with --prompt, or pass an event as --event <file.json>.',
  });
}

export async function workflowRunCommand(workflowRef: string | undefined, issueRef: string | undefined, options: WorkflowRunOptions = {}): Promise<number> {
  loadEnvFile(options.envFile);
  const cli = await createCliContext();
  const graph = await loadWorkflow(await resolveWorkflowFile(cli.repo.root, workflowRef));
  const event = await eventFor(cli, graph, issueRef, options);
  const json = options.json === true;

  const controller = new AbortController();
  let asked = false;
  const onSignal = (): void => {
    if (asked) return;
    asked = true;
    if (!json) out(warning('  Stopping: the run is asked to stop, and work so far stays on its branch.'));
    controller.abort();
  };
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, onSignal);

  try {
    const askAtTerminal = terminalApproval(json);
    const effects = createEffects({
      repoRoot: cli.repo.root,
      config: cli.config,
      harnesses: cli.harnesses,
      issueProvider: cli.issueProvider,
      graph,
      signal: controller.signal,
      emit: emitter(graph, { json, verbose: options.verbose === true }),
      ...(askAtTerminal === undefined ? {} : { askAtTerminal }),
    });
    const outcome = await executeGraph(graph, event, effects, { dryRun: options.dryRun === true });
    return outcome.exitCode;
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
  }
}

/* ------------------------------------------------------------------ */
/* check                                                               */
/* ------------------------------------------------------------------ */

export interface WorkflowCheckJson {
  type: 'workflow_check';
  workflow: { id: string; name: string; file: string; enabled: boolean };
  /** Whether an event can start it with nobody pressing anything, under `relay workflow serve`. */
  startsByItself: boolean;
  nodes: Array<{ id: string; nodeType: string; name: string; real: boolean; note: string; needs: Array<{ variable: string; set: boolean }> }>;
  unwired: number;
  missing: string[];
}

export function checkWorkflow(graph: WorkflowGraph, file: string, env: Readonly<Record<string, string | undefined>> = process.env): WorkflowCheckJson {
  const nodes = graph.nodes.map((node) => {
    const support = nodeSupport(node.type);
    return {
      id: node.id,
      nodeType: node.type,
      name: node.name,
      real: support.real,
      note: support.note,
      needs: support.needs.map((variable) => ({ variable, set: (env[variable] ?? '').trim().length > 0 })),
    };
  });
  const trigger = triggerOf(graph);
  // The webhook's secret is optional on this machine; every other variable a step names is how the step works at all.
  const missing = [...new Set(nodes.flatMap((node) => node.needs.filter((need) => !need.set && need.variable !== WEBHOOK_SECRET_VARIABLE).map((need) => need.variable)))];
  return {
    type: 'workflow_check',
    workflow: { id: graph.id, name: graph.name, file, enabled: graph.enabled },
    startsByItself: nodeSupport(trigger.type).real && trigger.type !== 'logic.trigger.manual',
    nodes,
    unwired: nodes.filter((node) => !node.real).length,
    missing,
  };
}

export async function workflowCheckCommand(workflowRef: string | undefined, options: { envFile?: string; json?: boolean } = {}): Promise<number> {
  loadEnvFile(options.envFile);
  const cli = await createCliContext();
  const file = await resolveWorkflowFile(cli.repo.root, workflowRef);
  const graph = await loadWorkflow(file);
  const check = checkWorkflow(graph, relative(cli.repo.root, file) || file);
  if (options.json === true) {
    emitJson('workflow', check);
    return EXIT.success;
  }

  section(graph.name);
  out(dim(`  ${check.workflow.file}${graph.enabled ? '' : '  ·  paused: nothing starts it by itself'}`));
  out();
  for (const node of check.nodes) {
    out(`  ${node.real ? success(glyphs(theme()).ok) : warning('!')} ${node.name}${node.real ? '' : warning('  not performed')}`);
    hint(node.note, '    ');
    for (const need of node.needs) {
      if (need.variable === WEBHOOK_SECRET_VARIABLE && !need.set) hint(`${need.variable} is not set: deliveries are unsigned, so it listens on this machine only.`, '    ');
      else out(`    ${need.set ? dim(`${need.variable} is set`) : failure(`${need.variable} is not set`)}`);
    }
  }
  out();
  const trigger = triggerOf(graph);
  rows([
    { label: 'Starts', value: check.startsByItself ? `by itself, under \`relay workflow serve\` (${trigger.name})` : trigger.type === 'logic.trigger.manual' ? 'by hand: `relay workflow run`' : 'by hand: nothing listens for its trigger yet' },
    { label: 'Performed', value: `${check.nodes.length - check.unwired} of ${pluralize(check.nodes.length, 'step')}` },
    check.missing.length > 0 && { label: 'Missing', value: check.missing.join(', ') },
  ]);
  if (check.unwired > 0) hint('A step Relay cannot perform is skipped in a real run, and the run says so. Nothing is pretended.');
  if (check.missing.length > 0) hint('Export each one where the workflow runs, or pass a file of them with --env-file.');
  out();
  hint('Walk it without starting or sending anything:');
  command(`relay workflow run ${relative(workflowsDir(cli.repo.root), file).replace(/\.json$/, '')} --prompt "…" --dry-run`);
  return EXIT.success;
}

/* ------------------------------------------------------------------ */
/* serve                                                               */
/* ------------------------------------------------------------------ */

function printServeLog(entry: ServeLog): void {
  const at = dim(new Date().toISOString());
  switch (entry.type) {
    case 'listening':
      section('Workflow, unattended');
      rows([{ label: 'Trigger', value: entry.trigger }, { label: 'Listening', value: entry.detail }, { label: 'Delivery', value: 'capped at a draft pull request: nothing merges without a person' }]);
      out();
      hint('To stop it: Ctrl-C. The run in flight finishes; press it again to stop that too.');
      out();
      break;
    case 'event':
      out(`${at} ${success('event')} ${entry.id}${entry.title.length === 0 ? '' : `: ${oneLine(entry.title, 100)}`}`);
      break;
    case 'ignored':
      out(`${at} ${warning('ignored')} ${entry.reason}`);
      break;
    case 'finished':
      out(`${at} ${entry.status === 'succeeded' ? success(entry.status) : entry.status === 'failed' ? failure(entry.status) : warning(entry.status)} ${entry.summary}`);
      break;
    case 'error':
      out(`${at} ${failure('error')} ${entry.detail}`);
      break;
    case 'stopping':
      out(dim(`  Stopping: ${entry.reason}. ${pluralize(entry.waiting, 'event')} still waiting were not run.`));
      break;
  }
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new RelayError(`--port must be a port number (got "${value}").`, { code: 'BAD_FLAG' });
  return port;
}

export async function workflowServeCommand(workflowRef: string | undefined, options: WorkflowServeOptions = {}): Promise<number> {
  loadEnvFile(options.envFile);
  const cli = await createCliContext();
  const graph = await loadWorkflow(await resolveWorkflowFile(cli.repo.root, workflowRef));
  const json = options.json === true;
  if (!graph.enabled) {
    throw new RelayError(`“${graph.name}” is paused, so nothing may start it by itself.`, { code: 'WORKFLOW_PAUSED', hint: 'Switch it to Active in the studio and export it again.' });
  }
  let pollSeconds: number | undefined;
  if (options.interval !== undefined) {
    pollSeconds = Number.parseInt(options.interval, 10);
    if (!Number.isInteger(pollSeconds) || pollSeconds < 5 || pollSeconds > 3600) throw new RelayError(`--interval must be a whole number of seconds between 5 and 3600 (got "${options.interval}").`, { code: 'BAD_FLAG' });
  }

  // Two signals, as in `relay serve`: the first stops taking events, the second stops the run in flight.
  const accepting = new AbortController();
  const running = new AbortController();
  const onSignal = (signal: NodeJS.Signals): void => {
    if (accepting.signal.aborted) {
      if (signal === 'SIGHUP') return;
      if (!json) out(warning(`  ${signal} again: stopping the run in flight.`));
      running.abort();
      return;
    }
    if (!json) out(warning(`\n  ${signal}: taking no more events. A run in flight will finish.`));
    accepting.abort();
  };
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, onSignal);

  const emit = emitter(graph, { json, verbose: options.verbose === true });
  try {
    const outcome = await serveWorkflow({
      graph,
      env: process.env,
      provider: cli.issueProvider,
      signal: accepting.signal,
      runSignal: running.signal,
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(parsePort(options.port) === undefined ? {} : { port: parsePort(options.port)! }),
      ...(pollSeconds === undefined ? {} : { pollSeconds }),
      ...(options.once === true ? { maxEvents: 1 } : {}),
      log: (entry) => {
        if (json) emitJsonLine('workflow', { type: 'serve', at: new Date().toISOString(), entry });
        else printServeLog(entry);
      },
      run: async (event, signal): Promise<GraphOutcome> => {
        const effects = claimingLabel(
          createEffects({ repoRoot: cli.repo.root, config: cli.config, harnesses: cli.harnesses, issueProvider: cli.issueProvider, graph, signal, emit }),
          cli,
        );
        return executeGraph(graph, event, effects, { dryRun: options.dryRun === true });
      },
    });
    if (json) emitJsonLine('workflow', { type: 'serve_finished', at: new Date().toISOString(), ...outcome });
    if (outcome.stoppedBy === 'error') throw new RelayError(outcome.reason, { code: 'WORKFLOW_SERVE_FAILED' });
    return outcome.results.some((result) => result.status === 'failed') ? EXIT.error : EXIT.success;
  } catch (error) {
    if (error instanceof RelayError) throw error;
    // What `serveWorkflow` refuses before it listens: a trigger it cannot keep, a cron it cannot read, a port in use.
    throw new RelayError(errorMessage(error), { code: 'WORKFLOW_SERVE_FAILED', hint: (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `Something is already using that port. Pass another with --port (the default is ${DEFAULT_WEBHOOK_PORT}).` : 'Check the trigger with `relay workflow check`.' });
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
  }
}

/* ------------------------------------------------------------------ */
/* approvals                                                           */
/* ------------------------------------------------------------------ */

export async function workflowApprovalsCommand(options: { all?: boolean; json?: boolean } = {}): Promise<number> {
  const cli = await createCliContext();
  const records = await listApprovals(cli.repo.root);
  const shown = options.all === true ? records : records.filter((record) => approvalOpen(record));
  if (options.json === true) {
    emitJson('workflow', { type: 'approvals', approvals: shown.map((record) => ({ ...record, open: approvalOpen(record) })) });
    return EXIT.success;
  }
  if (shown.length === 0) {
    out(options.all === true ? 'No approvals on record in this repository.' : 'Nothing is waiting for approval.');
    return EXIT.success;
  }
  section(options.all === true ? 'Approvals' : 'Waiting for approval');
  for (const record of shown) {
    const state = approvalOpen(record) ? warning('waiting') : record.status === 'pending' ? dim('ran out of time') : record.status === 'approved' ? success('approved') : failure('rejected');
    bullet(`${record.id}  ${state}  ${oneLine(record.subject, 70)}  ${dim(`${record.workflow}${record.decidedBy === undefined ? '' : ` · by ${record.decidedBy}`}`)}`);
    if (approvalOpen(record)) hint(`until ${record.expiresAt}${record.approvers.length === 0 ? '' : ` · may be answered by ${record.approvers.join(', ')}`}`, '      ');
  }
  out();
  hint('Answer one:');
  command('relay workflow approve <id>');
  command('relay workflow reject <id>');
  return EXIT.success;
}

export async function workflowDecideCommand(approved: boolean, id: string, options: { as?: string; json?: boolean } = {}): Promise<number> {
  const cli = await createCliContext();
  const by = options.as?.trim() || userInfo().username;
  const record = await decideApproval(cli.repo.root, id.trim(), { approved, by });
  if (options.json === true) {
    emitJson('workflow', { type: 'approval', approval: record });
    return EXIT.success;
  }
  ok(`${approved ? 'Approved' : 'Rejected'} ${record.id} as ${by}: ${oneLine(record.subject, 80)}`);
  hint(approved ? 'The run waiting on it carries on within a second.' : 'The run waiting on it takes its “Rejected” path.');
  return EXIT.success;
}
