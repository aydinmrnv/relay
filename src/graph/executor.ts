import { screenText } from '../unattended/injection.ts';
import { errorMessage } from '../util/errors.ts';
import { clip, oneLine } from '../util/text.ts';
import { formatCost } from '../workflow/usage.ts';
import { evaluateCondition, evaluateFilter, isJsonTemplate, renderJsonTemplate, renderTemplate } from './expression.ts';
import { nextWindowOpening } from './schedule.ts';
import { BRIDGE_VARIABLE, nodeSupport } from './support.ts';
import {
  ENGINE_KEYS,
  isIssueReference,
  isWorkflowCredential,
  plainText,
  triggerOf,
  type GraphNode,
  type GraphNodeStatus,
  type GraphRecord,
  type GraphRunStatus,
  type GraphTask,
  type WorkflowEvent,
  type WorkflowGraph,
} from './types.ts';

/**
 * Runs a workflow as it was drawn.
 *
 * The studio's test run walks a graph and plays what each node would do. This
 * is the same walk — the same queue, the same joins, the same rule for a path
 * a decision did not take — with the playing replaced by doing: a Condition
 * reads the real event, a budget sums the real spend, an approval waits for a
 * real person, the pipeline is a real `relay run`, and a Slack step posts.
 *
 * Nothing in this file touches the network, the disk or a process. Everything
 * a node does to the world goes through `GraphEffects`, so the walk and every
 * decision in it can be tested by handing it a list of things that happened.
 *
 * What it will not do is pretend. A node Relay has no way to perform is
 * reported as `unwired` and the run carries on past it, saying so; it is never
 * reported as done.
 */

/** What the pipeline's own run reported, as far as the steps after it need. */
export interface PipelineResult {
  exitCode: number | null;
  /** Why it ended without a summary: a CLI not signed in, an issue that does not exist. */
  error: string | null;
  /** The `run` object of the engine's summary line, when the run got that far. */
  run: PipelineRun | null;
}

export interface PipelineRun {
  runId?: string;
  shortId?: string;
  branch?: string | null;
  agents?: Record<string, string>;
  issue?: { id?: string | null; number?: number | null; title?: string; url?: string } | null;
  diff?: { fileCount?: number; additions?: number; deletions?: number } | null;
  tests?: { passed?: boolean; discovered?: boolean; skippedReason?: string | null } | null;
  pullRequest?: { url?: string; number?: number | null } | null;
  delivery?: {
    reached?: string;
    steps?: Array<{ step?: string; status?: string; detail?: string }>;
    comment?: { status?: string; detail?: string; url?: string };
  } | null;
  usage?: { total?: { costUsd?: number | null } } | null;
  stopped?: { reason?: string; detail?: string } | null;
  error?: { message?: string } | null;
  [key: string]: unknown;
}

export interface ApprovalAsk {
  node: string;
  workflow: string;
  /** What is waiting to be approved, in a sentence. */
  subject: string;
  via: string;
  approvers: string[];
  expiresAt: Date;
}

export interface ApprovalAnswer {
  approved: boolean;
  /** Who answered, as far as the way they answered can say. */
  by: string | null;
  /** `timeout` when nobody did. */
  reason: 'answered' | 'timeout';
}

export interface GraphEffects {
  now(): Date;
  /** Resolves after `ms`; rejects when the run is cancelled. */
  sleep(ms: number): Promise<void>;
  signal: AbortSignal;
  /** The environment the app steps read their credentials from. Never handed to an agent. */
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof globalThis.fetch;
  emit(record: GraphRecord): void;

  /** Why the repository says to start nothing (`.relay/STOP`), or null. */
  stopReason(): Promise<string | null>;
  /** What unattended runs have cost here today, and how many runs of any kind are going. */
  spend(): Promise<{ spentUsd: number; runs: number; unpriced: number; inFlight: number }>;
  /** What a run of this shape has cost here before, or null with nothing to go on. */
  estimate(): Promise<{ medianUsd: number; worstUsd: number; samples: number } | null>;
  /** The first of these teams the login belongs to, or null. */
  teamOf(login: string, teams: readonly string[]): Promise<string | null>;
  /** Asks a person, and waits for the answer or the deadline. `announce` is told how to answer, and the request's id, once they are known. */
  approval(ask: ApprovalAsk, announce: (how: string, id?: string) => void): Promise<ApprovalAnswer>;

  /** Runs the agent pipeline, and its delivery, to the end. */
  runPipeline(input: { node: GraphNode; task: GraphTask; event: WorkflowEvent; onLine: (line: Record<string, unknown>) => void }): Promise<PipelineResult>;
  /** One read-only turn of a signed-in coding CLI. */
  aiStep(input: { prompt: string; vendor: 'claude' | 'codex' | null; event: WorkflowEvent }): Promise<{ ok: boolean; text: string; agent: string; error?: string; costUsd?: number }>;

  /** `gh`, in the repository. */
  gh(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }>;
  /** One Linear GraphQL request. Throws with Linear's own reason. */
  linear<T>(query: string, variables: Record<string, unknown>): Promise<T>;
}

export interface ExecuteOptions {
  /**
   * Decide everything, do nothing: the gates and the logic run for real, and
   * every step that would spend, post or publish says what it would have done.
   */
  dryRun?: boolean;
  /** The name templates read as `{{product.name}}`. */
  product?: string;
}

export interface GraphOutcome {
  status: GraphRunStatus;
  exitCode: number;
  summary: string;
  nodes: Record<string, GraphNodeStatus | 'pending'>;
  pipeline: PipelineResult | null;
  /** Names of the steps Relay could not perform. */
  unwired: string[];
  costUsd: number | null;
}

/** The engine's exit codes this file reads and returns. From `src/cli/exit.ts`; restated so the walk imports nothing of the CLI. */
const EXIT = { success: 0, error: 1, unlanded: 4, checksFailed: 5, cancelled: 130 } as const;

class Cancelled extends Error {}

interface NodeResult {
  status: GraphNodeStatus;
  message: string;
  detail?: string;
  /** Which outputs the run leaves by. `all`: every one. */
  next: 'all' | string[];
  costUsd?: number;
}

const AGENT_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };

export async function executeGraph(graph: WorkflowGraph, event: WorkflowEvent, effects: GraphEffects, options: ExecuteOptions = {}): Promise<GraphOutcome> {
  const dry = options.dryRun === true;
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, WorkflowGraph['edges']>();
  for (const edge of graph.edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  // Only what the trigger leads to. An edge from a node nothing reaches will never bring
  // anything, and a join that waited for it would wait for ever.
  const reachable = new Set<string>([triggerOf(graph).id]);
  for (const id of reachable) for (const edge of outgoing.get(id) ?? []) reachable.add(edge.to);
  const incoming = new Map<string, number>();
  for (const edge of graph.edges) if (reachable.has(edge.from)) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);

  const status: Record<string, GraphNodeStatus | 'pending'> = Object.fromEntries(graph.nodes.map((node) => [node.id, 'pending']));
  const unwired: string[] = [];
  // Held in one object so the closures below and the code after the walk read the same thing.
  const state: { pipeline: PipelineResult | null; pipelineStarted: boolean; extraCostUsd: number; refused: boolean; failed: boolean; budgeted: boolean } = {
    pipeline: null,
    pipelineStarted: false,
    extraCostUsd: 0,
    refused: false,
    failed: false,
    budgeted: false,
  };

  const issue: Record<string, unknown> = { ...event.payload };
  // What the walk writes for itself is not the event's to set: `{{trigger.*}}` still has the body as it came.
  for (const key of ENGINE_KEYS) delete issue[key];
  if (issue['key'] === undefined && issue['id'] !== undefined) issue['key'] = issue['id'];
  const run: Record<string, unknown> = { id: '', status: 'running', cost: '', prUrl: '', branch: '', tests: 'not run', summary: '', codeReviewer: '', diff: '' };
  const context: Record<string, unknown> = {
    issue,
    trigger: event.payload,
    run,
    workflow: { name: graph.name, repository: graph.repository ?? '' },
    product: { name: options.product ?? 'Relay' },
  };
  const at = (): string => effects.now().toISOString();
  // Text from the event is printed in a terminal and stored in a run's record: it carries no control characters there.
  const title = oneLine(plainText(String(issue['title'] ?? issue['id'] ?? (event.task?.kind === 'prompt' ? event.task.text : event.task?.ref) ?? 'event')), 120);

  // What a step says is partly the event's words and partly whatever an API
  // answered. Neither gets to move a cursor, and neither gets to repeat a
  // credential the step was using: a webhook's address, an API's header.
  const secrets: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(effects.env)) {
    if (typeof value !== 'string' || !(isWorkflowCredential(name) || name === 'LINEAR_API_KEY')) continue;
    if (value.trim().length >= 8) secrets.push([name, value.trim()]);
    if (!name.startsWith('HTTP_HEADERS')) continue;
    try {
      for (const header of Object.values(JSON.parse(value) as Record<string, unknown>)) if (typeof header === 'string' && header.length >= 8) secrets.push([name, header]);
    } catch {
      // Not JSON: the step that reads it says so.
    }
  }
  const said = (value: string): string => {
    let clean = plainText(value);
    for (const [name, secret] of secrets) if (clean.includes(secret)) clean = clean.split(secret).join(`[${name}]`);
    return clean;
  };

  effects.emit({
    type: 'workflow_started',
    at: at(),
    workflow: { id: graph.id, name: graph.name },
    event: { id: event.id, source: event.source, attended: event.attended, actor: event.actor === null ? null : oneLine(plainText(event.actor), 100), title },
    nodes: graph.nodes.map((node) => ({ id: node.id, nodeType: node.type, name: node.name, real: nodeSupport(node.type).real })),
  });

  // The same walk as a test run: a queue of nodes, each run once. Every node
  // keeps count of the paths into it: how many brought the run, and how many
  // a decision upstream ruled out. An ordinary node runs when the first path
  // arrives, and is skipped only once every path into it has been ruled out.
  // A Merge paths node waits to hear from all of them, and runs if any came.
  const visited = new Set<string>();
  const paths = new Map<string, { arrived: number; ruledOut: number }>();
  const isJoin = (id: string): boolean => nodesById.get(id)?.type === 'logic.action.merge-paths';
  const queue: string[] = [triggerOf(graph).id];
  let cancelled = false;

  const skip = (id: string): void => {
    status[id] = 'skipped';
    for (const edge of outgoing.get(id) ?? []) hear(edge.to, false);
  };
  /** One path into `id` has been decided: it brought the run, or it will not. */
  const hear = (id: string, arrived: boolean): void => {
    if (visited.has(id) || status[id] !== 'pending' || !nodesById.has(id)) return;
    const tally = paths.get(id) ?? { arrived: 0, ruledOut: 0 };
    if (arrived) tally.arrived += 1;
    else tally.ruledOut += 1;
    paths.set(id, tally);
    const heardAll = tally.arrived + tally.ruledOut >= (incoming.get(id) ?? 1);
    if (isJoin(id)) {
      if (!heardAll) return;
      if (tally.arrived > 0) queue.push(id);
      else skip(id);
    } else if (arrived) {
      if (tally.arrived === 1) queue.push(id);
    } else if (heardAll && tally.arrived === 0) skip(id);
  };

  try {
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      const node = nodesById.get(id);
      if (node === undefined) continue;
      visited.add(id);
      if (effects.signal.aborted) throw new Cancelled();

      const startedAt = effects.now().getTime();
      effects.emit({ type: 'node_started', at: at(), node: id, nodeType: node.type, name: node.name });
      let result: NodeResult;
      try {
        result = await perform(node);
      } catch (error) {
        if (error instanceof Cancelled || effects.signal.aborted) throw new Cancelled();
        // A step that threw is a step that failed. It does not take the run's
        // other paths, or what it already delivered, down with it.
        result = { status: 'failed', message: oneLine(errorMessage(error), 300), next: [] };
      }
      status[id] = result.status;
      if (result.status === 'refused') state.refused = true;
      if (result.status === 'failed') state.failed = true;
      if (result.status === 'unwired') unwired.push(node.name);
      if (result.costUsd !== undefined) state.extraCostUsd += result.costUsd;
      effects.emit({
        type: 'node_finished',
        at: at(),
        node: id,
        nodeType: node.type,
        status: result.status,
        message: said(result.message),
        detail: result.detail === undefined ? null : said(result.detail),
        durationMs: Math.max(0, effects.now().getTime() - startedAt),
        costUsd: result.costUsd ?? null,
      });

      for (const edge of outgoing.get(id) ?? []) {
        const handle = edge.handle ?? node.outputs[0] ?? null;
        hear(edge.to, result.next === 'all' || (handle !== null && result.next.includes(handle)));
      }
    }
  } catch (error) {
    if (!(error instanceof Cancelled)) throw error;
    cancelled = true;
  }

  for (const node of graph.nodes) if (status[node.id] === 'pending') status[node.id] = 'skipped';

  const pipelineExit = state.pipeline?.exitCode ?? null;
  const pipelineFailed = state.pipelineStarted && !dry && pipelineExit !== EXIT.success && pipelineExit !== EXIT.unlanded;
  const final: GraphRunStatus = cancelled || pipelineExit === EXIT.cancelled ? 'cancelled' : state.failed || pipelineFailed ? 'failed' : state.refused && !state.pipelineStarted ? 'refused' : 'succeeded';
  const exitCode = final === 'cancelled' ? EXIT.cancelled : pipelineFailed ? (pipelineExit ?? EXIT.error) : final === 'failed' ? EXIT.error : EXIT.success;
  const pipelineCost = state.pipeline?.run?.usage?.total?.costUsd;
  // Summed from figures that are themselves cents and fractions of cents; rounded so the total is not 1.8800000000000001.
  const total = (typeof pipelineCost === 'number' ? pipelineCost : 0) + state.extraCostUsd;
  const costUsd = typeof pipelineCost === 'number' || state.extraCostUsd > 0 ? Math.round(total * 10_000) / 10_000 : null;
  run['status'] = final;
  const summary = summarize();

  effects.emit({
    type: 'workflow_finished',
    at: at(),
    status: final,
    exitCode,
    summary,
    runId: state.pipeline?.run?.runId ?? null,
    pullRequest: typeof run['prUrl'] === 'string' && run['prUrl'].length > 0 ? run['prUrl'] : null,
    costUsd,
    unwired,
  });
  return { status: final, exitCode, summary, nodes: status, pipeline: state.pipeline, unwired, costUsd };

  /* ---------------------------------------------------------------- */

  function summarize(): string {
    const parts = [`${graph.name} · ${title}`];
    if (state.pipelineStarted && !dry) {
      const outcome = state.pipeline?.run;
      if (outcome?.diff !== null && outcome?.diff !== undefined) parts.push(`+${outcome.diff.additions ?? 0} −${outcome.diff.deletions ?? 0} across ${outcome.diff.fileCount ?? 0} files`);
      if (run['tests'] !== 'not run') parts.push(`tests ${String(run['tests'])}`);
    }
    if (costUsd !== null && costUsd > 0) parts.push(formatCost(costUsd));
    if (typeof run['prUrl'] === 'string' && run['prUrl'].length > 0) parts.push(run['prUrl']);
    const refusal = graph.nodes.find((node) => status[node.id] === 'refused');
    if (final === 'refused' && refusal !== undefined) parts.push(`refused at ${refusal.name}`);
    if (unwired.length > 0) parts.push(`${unwired.length} step${unwired.length === 1 ? '' : 's'} not performed`);
    if (dry) parts.push('dry run: nothing was started or sent');
    return parts.join(' · ');
  }

  function text(node: GraphNode, key: string, fallback = ''): string {
    const value = node.config[key];
    return value === undefined || value === null ? fallback : String(value);
  }
  function rendered(node: GraphNode, key: string, fallback = '', encode?: (value: string) => string): string {
    return renderTemplate(text(node, key, fallback), context, encode);
  }
  /** A node's URL. A variable inside it is percent-encoded, so an id cannot turn into a path; one that is the whole address is taken as it is. */
  function renderedUrl(node: GraphNode, key: string): string {
    const template = text(node, key).trim();
    return renderTemplate(template, context, /^\{\{\s*[a-zA-Z0-9_.-]+\s*\}\}$/.test(template) ? undefined : encodeURIComponent).trim();
  }
  function waiting(node: GraphNode, message: string, detail: string | null, approval?: string): void {
    effects.emit({ type: 'node_waiting', at: at(), node: node.id, message: said(message), detail: detail === null ? null : said(detail), ...(approval === undefined ? {} : { approval }) });
  }

  async function perform(node: GraphNode): Promise<NodeResult> {
    if (node.kind === 'trigger') {
      if (!event.attended && !graph.enabled) {
        return { status: 'refused', message: 'Refused: this workflow is paused, so nothing starts it by itself.', detail: 'Switch it to Active in the studio and export it again, or start it by hand.', next: [] };
      }
      if (!event.attended) {
        // The repository's stop file stops every workflow in it, whether or not its canvas has a kill switch.
        const stop = await effects.stopReason();
        if (stop !== null) return { status: 'refused', message: `Refused: ${stop}.`, detail: 'Remove the file to let events start runs again.', next: [] };
      }
      return { status: 'done', message: `${event.attended ? 'Started by hand' : 'Received'}: ${title}`, detail: clip(JSON.stringify(event.payload, null, 2), 4000), next: 'all' };
    }

    const support = nodeSupport(node.type);
    if (!support.real) return support.bridge ? bridge(node) : { status: 'unwired', message: `Not performed: ${support.note}`, next: 'all' };

    switch (node.type) {
      case 'gates.action.kill-switch':
        return killSwitch(node);
      case 'gates.action.allowlist':
        return allowlist(node);
      case 'gates.action.budget':
        return budget(node);
      case 'gates.action.concurrency':
        return concurrency(node);
      case 'gates.action.injection-screen':
        return injectionScreen(node);
      case 'gates.action.approval':
        return approval(node);
      case 'pipeline.action.estimate':
        return estimate();
      case 'pipeline.action.run':
      case 'pipeline.action.fast':
        return runPipeline(node);
      case 'delivery.action.deliver':
        return delivered();
      case 'delivery.action.comment-summary':
        return commented();
      case 'logic.action.condition': {
        const left = rendered(node, 'left');
        const op = text(node, 'op', 'contains');
        const right = text(node, 'right');
        const outcome = evaluateCondition(left, op, right);
        return {
          status: 'done',
          message: left.trim().length === 0 ? `${text(node, 'left', 'The field')} has no value in this run, so the condition is false.` : `"${oneLine(left, 80)}" ${op} "${right}" → ${outcome}`,
          next: [outcome ? 'true' : 'false'],
        };
      }
      case 'logic.action.filter': {
        const expression = text(node, 'expression');
        const outcome = evaluateFilter(expression, context);
        if (!outcome.ok) return { status: 'failed', message: `The expression “${oneLine(expression, 80)}” cannot be read: ${outcome.error}.`, next: [] };
        return outcome.value ? { status: 'done', message: `Passed: ${oneLine(expression, 100) || 'no expression'}`, next: 'all' } : { status: 'done', message: `Did not pass: ${oneLine(expression, 100)}. This path stops here.`, next: [] };
      }
      case 'logic.action.merge-paths':
        return { status: 'done', message: 'Every path that was coming has arrived.', next: 'all' };
      case 'logic.action.note':
        return { status: 'skipped', message: 'A note.', next: [] };
      case 'logic.action.ai-step':
        return aiStep(node);
      case 'schedule.action.delay': {
        const minutes = Math.max(0, Number(node.config['minutes'] ?? 10));
        if (!Number.isFinite(minutes)) return { status: 'failed', message: 'The wait has no number of minutes.', next: [] };
        if (dry) return { status: 'done', message: `Dry run: would wait ${minutes} minutes.`, next: 'all' };
        waiting(node, `Waiting ${minutes} minute${minutes === 1 ? '' : 's'}.`, null);
        await wait(minutes * 60_000);
        return { status: 'done', message: `Waited ${minutes} minute${minutes === 1 ? '' : 's'}.`, next: 'all' };
      }
      case 'schedule.action.business-hours': {
        const window = text(node, 'window', '09:00-18:00 Mon-Fri');
        const zone = text(node, 'timezone', 'UTC');
        const opening = nextWindowOpening(effects.now(), window, zone);
        if (!opening.ok) return { status: 'failed', message: opening.error, next: [] };
        if (opening.waitMs === 0) return { status: 'done', message: `Inside ${window} (${zone}): no wait.`, next: 'all' };
        if (dry) return { status: 'done', message: `Dry run: would hold until ${opening.opensAt.toISOString()}.`, next: 'all' };
        waiting(node, `Holding until ${window} (${zone}).`, `Opens at ${opening.opensAt.toISOString()}.`);
        await wait(opening.waitMs);
        return { status: 'done', message: `Held until ${window} (${zone}).`, next: 'all' };
      }
      case 'http.action.request':
        return httpRequest(node);
      case 'http.action.post-run-json':
        return postRunJson(node);
      default:
        break;
    }

    const app = node.type.split('.')[0];
    // Slack reads `<!channel>` as a ping and `<url|label>` as a link, so what a ticket said is escaped before it is one.
    if (app === 'slack') return chat(node, 'SLACK_WEBHOOK_URL', 'Slack', (message) => ({ text: message }), (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    // Text from a ticket must never ping a channel.
    if (app === 'discord') return chat(node, 'DISCORD_WEBHOOK_URL', 'Discord', (message) => ({ content: clip(message, 1900), allowed_mentions: { parse: [] } }));
    if (app === 'github-issues') return githubIssue(node);
    if (app === 'github') return githubPullRequest(node);
    if (app === 'linear') return linear(node);
    // On the table as real, with no code behind it: a bug in this file, said rather than hidden.
    return { status: 'unwired', message: `Not performed: this Relay has no handler for ${node.type}.`, next: 'all' };
  }

  async function wait(ms: number): Promise<void> {
    try {
      await effects.sleep(ms);
    } catch {
      throw new Cancelled();
    }
  }

  /* ----------------------------- guardrails ----------------------------- */

  async function killSwitch(node: GraphNode): Promise<NodeResult> {
    if (event.attended) return { status: 'done', message: 'Started by hand: the kill switch decides whether an event may start a run.', next: 'all' };
    if (node.config['enabled'] !== true) {
      return { status: 'refused', message: 'Refused: unattended runs are switched off.', detail: 'Flip "Unattended runs enabled" on the kill switch node, and export the workflow again.', next: [] };
    }
    const stop = await effects.stopReason();
    if (stop !== null) return { status: 'refused', message: `Refused: ${stop}.`, detail: 'Remove the file to let runs start again.', next: [] };
    return { status: 'done', message: 'Unattended runs are enabled.', next: 'all' };
  }

  async function allowlist(node: GraphNode): Promise<NodeResult> {
    if (event.attended) return { status: 'done', message: 'Started by hand: the person at the controls is who the allowlist is for.', next: ['pass'] };
    const authors = lines(node.config['authors']);
    const teams = lines(node.config['teams']);
    if (authors.length === 0 && teams.length === 0) return { status: 'refused', message: 'Refused: the allowlist is empty, so nobody may start a run.', next: ['refused'] };
    if (authors.includes('*')) return { status: 'done', message: 'Anyone is allowed: the allowlist is *.', next: ['pass'] };
    const actor = event.actor?.replace(/^@/, '') ?? null;
    if (actor === null || actor.length === 0) {
      return {
        status: 'refused',
        message: 'Refused: nothing vouches for who started this event, and the allowlist names people.',
        detail: 'Send the login as "actor" in a signed webhook body (an unsigned delivery’s word for who sent it is not taken), or allow * if the sender is already trusted.',
        next: ['refused'],
      };
    }
    if (authors.some((login) => login.toLowerCase() === actor.toLowerCase())) return { status: 'done', message: `@${actor} is allowed.`, next: ['pass'] };
    if (teams.length > 0) {
      const team = await effects.teamOf(actor, teams);
      if (team !== null) return { status: 'done', message: `@${actor} is allowed, as a member of ${team}.`, next: ['pass'] };
    }
    return { status: 'refused', message: `Refused: @${actor} is not on the allowlist.`, next: ['refused'] };
  }

  async function budget(node: GraphNode): Promise<NodeResult> {
    const perRun = money(node.config['maxRunCostUsd']);
    const perDay = money(node.config['maxDailyCostUsd']);
    // A ceiling that cannot be read is not "no ceiling": the person who typed it meant one.
    if (!perRun.ok || !perDay.ok) {
      return { status: 'failed', message: `The ${perRun.ok ? 'daily budget' : 'per-run cost'} “${oneLine(String(node.config[perRun.ok ? 'maxDailyCostUsd' : 'maxRunCostUsd']), 40)}” is not an amount. Write a number of dollars, such as 2.50.`, next: [] };
    }
    const maxRun = perRun.value;
    const maxDaily = perDay.value;
    if (maxRun === null && maxDaily === null) {
      return { status: 'done', message: 'No ceiling is set, so nothing is refused.', detail: 'Fill in a per-run or daily cost, or this gate lets everything through.', next: ['pass'] };
    }
    const estimated = numberOrNull(issue['estimateUsd']);
    if (maxRun !== null && estimated !== null && estimated > maxRun) {
      return { status: 'refused', message: `Refused: runs like this have cost ${formatCost(estimated)} here, over the per-run ceiling ${formatCost(maxRun)}.`, next: ['refused'] };
    }
    const held = maxRun === null ? 'with no per-run ceiling' : `held to ${formatCost(maxRun)}`;
    if (event.attended) {
      // The daily budget is a ceiling on what Relay starts by itself. A person
      // pressing the button is not that, and the per-run cap still stops the run.
      return { status: 'done', message: `Started by hand, ${held}. The daily budget counts what Relay starts by itself.`, next: ['pass'] };
    }
    if (maxDaily === null) return { status: 'done', message: `Within budget: no daily ceiling, this run ${held}.`, next: ['pass'] };
    if (maxRun === null) {
      // A run in flight has spent nothing yet, so what it reserves of the day is its cap. With no cap it reserves nothing, and the day's ceiling is passed by runs that were each let in.
      return { status: 'refused', message: `Refused: a daily budget of ${formatCost(maxDaily)} cannot be kept with no per-run cost.`, detail: 'Fill in the per-run cost on the Budget gate. A run in flight reserves that much of the day.', next: ['refused'] };
    }
    const day = await today(maxRun, maxDaily);
    if (day.refusal !== null) return { status: 'refused', message: day.refusal, detail: 'Never queued for tomorrow: that is the same spend with a delay in front of it.', next: ['refused'] };
    state.budgeted = true;
    return { status: 'done', message: `Within budget: ${day.said}, this run ${held}.`, next: ['pass'] };
  }

  /** Whether one more run, held to `maxRun`, fits in what is left of today's `maxDaily`. */
  async function today(maxRun: number, maxDaily: number): Promise<{ refusal: string | null; said: string }> {
    const spend = await effects.spend();
    // Each run in flight has reported nothing yet, so it reserves its whole cap — the rule `relay serve` uses.
    const committed = spend.spentUsd + spend.inFlight * maxRun;
    const floor = spend.unpriced === 0 ? '' : ` (${spend.unpriced} turn${spend.unpriced === 1 ? '' : 's'} reported no price, so today’s spend is a floor)`;
    const over = committed + maxRun > maxDaily || spend.spentUsd >= maxDaily;
    return {
      refusal: over ? `Refused: ${formatCost(spend.spentUsd)} spent today across ${spend.runs} unattended run${spend.runs === 1 ? '' : 's'}, and another could take it past ${formatCost(maxDaily)}${floor}.` : null,
      said: `${formatCost(committed)} of ${formatCost(maxDaily)} committed today${floor}`,
    };
  }

  async function concurrency(node: GraphNode): Promise<NodeResult> {
    const max = Math.max(1, Number(node.config['maxConcurrentRuns'] ?? 1) || 1);
    const { inFlight } = await effects.spend();
    return {
      status: 'done',
      message: inFlight >= max ? `${inFlight} of ${max} run${max === 1 ? '' : 's'} in flight: this one waits its turn before the agents start.` : `${inFlight} of ${max} run${max === 1 ? '' : 's'} in flight: starting.`,
      next: 'all',
    };
  }

  async function injectionScreen(node: GraphNode): Promise<NodeResult> {
    const parts: Array<[string, string]> = [
      ['title', String(issue['title'] ?? '')],
      ['description', String(issue['body'] ?? issue['description'] ?? (event.task?.kind === 'prompt' ? event.task.text : ''))],
    ];
    const matches = parts.flatMap(([where, body]) => screenText(body).map((match) => `its ${where} ${match.what} (“${match.excerpt}”)`));
    if (matches.length === 0) {
      return { status: 'done', message: 'Clean: nothing in the title or description matches the injection patterns.', detail: 'A list of patterns, not a guarantee: text in words the list does not know passes it.', next: ['pass'] };
    }
    const said = `${matches.slice(0, 3).join('; ')}${matches.length > 3 ? `, and ${matches.length - 3} more` : ''}`;
    if (node.config['mode'] === 'warn') return { status: 'done', message: `Warned, and let through: ${said}.`, next: ['pass'] };
    return { status: 'refused', message: `Refused: looks like a prompt injection: ${said}.`, detail: 'No agent read it and nothing was spent. A person can read it and start the run by hand.', next: ['refused'] };
  }

  async function approval(node: GraphNode): Promise<NodeResult> {
    const hours = Math.min(168, Math.max(1 / 60, Number(node.config['timeoutHours'] ?? 24) || 24));
    const via = text(node, 'via', 'dashboard');
    if (dry) return { status: 'done', message: 'Dry run: would wait here for a person’s approval. Taken as approved.', next: ['approved'] };
    const ask: ApprovalAsk = {
      node: node.id,
      workflow: graph.name,
      subject: title,
      via,
      approvers: lines(node.config['approvers']),
      expiresAt: new Date(effects.now().getTime() + hours * 3_600_000),
    };
    const answer = await effects.approval(ask, (how, id) => waiting(node, `Waiting for approval: ${title}`, how, id));
    const who = answer.by === null ? 'a person' : answer.by;
    if (answer.reason === 'timeout') {
      const waited = hours >= 1 ? `${hours} hour${hours === 1 ? '' : 's'}` : `${Math.round(hours * 60)} minutes`;
      return { status: 'refused', message: `Nobody answered within ${waited}, so the run was not approved.`, next: ['rejected'] };
    }
    return answer.approved ? { status: 'done', message: `Approved by ${who}.`, next: ['approved'] } : { status: 'refused', message: `Rejected by ${who}.`, next: ['rejected'] };
  }

  async function estimate(): Promise<NodeResult> {
    const priced = await effects.estimate();
    if (priced === null) {
      return { status: 'done', message: 'No estimate: no finished run in this repository has reported a price yet.', detail: 'A Filter or a Budget gate that reads the estimate sees no value until one has.', next: 'all' };
    }
    const typical = Math.round(priced.medianUsd * 100) / 100;
    issue['estimateUsd'] = typical;
    issue['estimate'] = typical;
    return { status: 'done', message: `Estimated ${formatCost(typical)}: the median of ${priced.samples} earlier run${priced.samples === 1 ? '' : 's'} here, worst ${formatCost(priced.worstUsd)}.`, next: 'all' };
  }

  /* ------------------------------ the run ------------------------------ */

  async function runPipeline(node: GraphNode): Promise<NodeResult> {
    if (state.pipelineStarted) return { status: 'failed', message: 'This workflow has a second agent pipeline. A run works on one change, so only the first ran.', next: [] };
    const task = taskFor();
    if (task === null) return { status: 'failed', message: 'There is nothing for the agents to work on: the event has no issue, no title and no description.', next: [] };
    if (!event.attended) {
      // `relay run` reads anything that is not an issue as a file on this machine. An event does not get to name one.
      if (task.kind === 'issue' && !isIssueReference(task.ref)) {
        return { status: 'refused', message: `Refused: “${oneLine(task.ref, 60)}” is not an issue in a tracker, and an event may only name one of those.`, next: [] };
      }
      // The rule `relay serve` starts under: nobody is here to notice the bill, so both ceilings are set before an event may spend.
      const compiled = (graph.config['unattended'] !== null && typeof graph.config['unattended'] === 'object' ? graph.config['unattended'] : {}) as Record<string, unknown>;
      const cap = money(compiled['maxRunCostUsd']);
      const daily = money(compiled['maxDailyCostUsd']);
      if (!cap.ok || !daily.ok || cap.value === null || daily.value === null) {
        return {
          status: 'refused',
          message: 'Refused: an event may not start the agents with no ceiling on what they spend.',
          detail: 'Add a Budget gate with both a per-run cost and a daily budget, and export the workflow again. A run started by hand needs neither.',
          next: [],
        };
      }
      // A Budget gate on the way here has already held today's spend against the ceiling. Where the canvas put it somewhere else, it is held here.
      if (!state.budgeted) {
        const day = await today(cap.value, daily.value);
        if (day.refusal !== null) return { status: 'refused', message: day.refusal, detail: 'Never queued for tomorrow: that is the same spend with a delay in front of it.', next: [] };
      }
    }
    state.pipelineStarted = true;
    if (dry) {
      return { status: 'done', message: `Dry run: would start the agents on ${task.kind === 'issue' ? task.ref : `“${oneLine(task.text, 80)}”`}.`, next: 'all' };
    }

    const result = await effects.runPipeline({ node, task, event, onLine: (line) => effects.emit(line as unknown as GraphRecord) });
    state.pipeline = result;
    const outcome = result.run;
    if (outcome !== null) {
      run['id'] = outcome.shortId ?? outcome.runId ?? '';
      run['branch'] = outcome.branch ?? '';
      const cost = outcome.usage?.total?.costUsd;
      run['cost'] = typeof cost === 'number' ? formatCost(cost) : 'not reported';
      if (typeof outcome.pullRequest?.url === 'string') run['prUrl'] = outcome.pullRequest.url;
      if (outcome.diff !== null && outcome.diff !== undefined) run['diff'] = `+${outcome.diff.additions ?? 0} −${outcome.diff.deletions ?? 0} across ${outcome.diff.fileCount ?? 0} files`;
      if (outcome.tests !== null && outcome.tests !== undefined && outcome.tests.discovered !== false && outcome.tests.skippedReason == null) run['tests'] = outcome.tests.passed === true ? 'passed' : 'failed';
      const reviewer = outcome.agents?.['codeReviewer'];
      if (reviewer !== undefined) run['codeReviewer'] = AGENT_NAMES[reviewer] ?? reviewer;
      // What the tracker said the issue is, for the steps that name it afterwards.
      if (typeof outcome.issue?.title === 'string' && outcome.issue.title.length > 0 && issue['title'] === undefined) issue['title'] = outcome.issue.title;
      if (typeof outcome.issue?.url === 'string' && outcome.issue.url.length > 0 && issue['url'] === undefined) issue['url'] = outcome.issue.url;
      if (typeof outcome.issue?.number === 'number' && issue['number'] === undefined) issue['number'] = outcome.issue.number;
      context['runDocument'] = outcome;
    }
    const code = result.exitCode;
    if (code === EXIT.cancelled) throw new Cancelled();
    run['summary'] = pipelineSummary(result);
    if (code === EXIT.success || code === EXIT.unlanded) {
      const parts = ['Finished'];
      if (run['tests'] !== 'not run') parts.push(`tests ${String(run['tests'])}`);
      if (run['diff'] !== '') parts.push(String(run['diff']));
      if (run['cost'] !== '' && run['cost'] !== 'not reported') parts.push(String(run['cost']));
      return { status: 'done', message: parts.join(' · '), next: 'all' };
    }
    const why =
      outcome?.stopped?.reason === 'budget'
        ? `Stopped: over the per-run budget. ${outcome.stopped.detail ?? ''}`.trim()
        : code === EXIT.checksFailed
          ? 'Finished, and the verdict is no: tests failed or blocking findings were never resolved.'
          : (outcome?.error?.message ?? result.error ?? `Relay exited with code ${code ?? 'unknown'}.`);
    return { status: 'failed', message: oneLine(why, 300), next: [] };
  }

  function taskFor(): GraphTask | null {
    // A step before the pipeline may have filed a new ticket; the agents work on that one. (Only a step: the key is taken out of what an event sends.)
    const created = issue['createdRef'];
    if (typeof created === 'string' && created.length > 0) return { kind: 'issue', ref: created };
    if (event.task !== null) return event.task;
    const heading = String(issue['title'] ?? '').trim();
    const body = String(issue['body'] ?? issue['description'] ?? '').trim();
    if (heading.length === 0 && body.length === 0) return null;
    return { kind: 'prompt', text: [heading, body].filter((part) => part.length > 0).join('\n\n') };
  }

  function pipelineSummary(result: PipelineResult): string {
    const parts: string[] = [title];
    if (run['diff'] !== '') parts.push(String(run['diff']));
    if (run['tests'] !== 'not run') parts.push(`tests ${String(run['tests'])}`);
    if (run['cost'] !== '' && run['cost'] !== 'not reported') parts.push(String(run['cost']));
    if (run['prUrl'] !== '') parts.push(String(run['prUrl']));
    if (result.exitCode !== EXIT.success && result.exitCode !== EXIT.unlanded) parts.push(oneLine(result.run?.error?.message ?? result.error ?? `exit ${result.exitCode ?? 'unknown'}`, 200));
    return parts.join(' · ');
  }

  function delivered(): NodeResult {
    if (dry) return { status: 'done', message: 'Dry run: would deliver as far as the policy allows.', next: 'all' };
    if (state.pipeline === null) return { status: 'skipped', message: 'Nothing to deliver: no agent pipeline ran before this step.', next: [] };
    const delivery = state.pipeline.run?.delivery;
    if (delivery === null || delivery === undefined) return { status: 'skipped', message: 'Nothing delivered: a run that does not finish never publishes.', next: [] };
    const steps = (delivery.steps ?? []).filter((step) => step.status !== 'skipped');
    const failed = steps.find((step) => step.status === 'failed');
    const said = steps.length === 0 ? `Delivered as far as "${delivery.reached ?? 'none'}"` : steps.map((step) => `${stepLabel(step.step)}${step.status === 'failed' ? ' failed' : ''}`).join(' · ');
    if (failed !== undefined) return { status: 'failed', message: said, ...(failed.detail === undefined ? {} : { detail: failed.detail }), next: [] };
    return { status: 'done', message: said, ...(run['prUrl'] === '' ? {} : { detail: String(run['prUrl']) }), next: 'all' };
  }

  function commented(): NodeResult {
    if (dry) return { status: 'done', message: 'Dry run: would comment the summary on the issue.', next: 'all' };
    const comment = state.pipeline?.run?.delivery?.comment;
    if (comment?.status === 'done') return { status: 'done', message: comment.detail ?? 'Commented on the issue.', ...(comment.url === undefined ? {} : { detail: comment.url }), next: 'all' };
    if (comment?.status === 'failed') return { status: 'failed', message: comment.detail ?? 'The comment could not be posted.', next: [] };
    return { status: 'skipped', message: comment?.detail ?? 'No comment: the task was not a tracker issue, or the run did not get as far as delivery.', next: 'all' };
  }

  async function aiStep(node: GraphNode): Promise<NodeResult> {
    const prompt = rendered(node, 'prompt');
    if (prompt.trim().length === 0) return { status: 'failed', message: 'The AI step has no prompt.', next: [] };
    if (dry) {
      // Nothing is asked, so the walk takes the first answer the prompt offers: the path the workflow was drawn for.
      const assumed = answerOptions(prompt)?.[0];
      if (assumed === undefined) return { status: 'done', message: 'Dry run: would ask a model. No answer, so what reads it sees no value.', detail: prompt, next: 'all' };
      issue['triage'] = assumed;
      context['ai'] = { answer: assumed, text: assumed };
      return { status: 'done', message: `Dry run: would ask a model. Taken as “${assumed}”, the first answer the prompt offers.`, detail: prompt, next: 'all' };
    }
    const model = text(node, 'model').toLowerCase();
    const vendor = model.startsWith('claude') ? 'claude' : model.startsWith('gpt') || model.includes('codex') ? 'codex' : null;
    const answer = await effects.aiStep({ prompt, vendor, event });
    if (!answer.ok) return { status: 'failed', message: `${answer.agent} did not answer: ${oneLine(answer.error ?? 'no reason given', 200)}`, detail: prompt, next: [] };
    const verdict = pickAnswer(prompt, answer.text);
    issue['triage'] = verdict;
    context['ai'] = { answer: verdict, text: answer.text };
    return {
      status: 'done',
      message: `${answer.agent} answered: ${oneLine(verdict, 160)}`,
      detail: clip(answer.text, 4000),
      next: 'all',
      ...(answer.costUsd === undefined ? {} : { costUsd: answer.costUsd }),
    };
  }

  /* ------------------------------- apps ------------------------------- */

  async function httpRequest(node: GraphNode): Promise<NodeResult> {
    const url = renderedUrl(node, 'url');
    const configured = text(node, 'method', 'POST').toUpperCase();
    const method = ['POST', 'GET', 'PUT', 'PATCH', 'DELETE'].includes(configured) ? configured : 'POST';
    if (!/^https?:\/\//i.test(url)) return { status: 'failed', message: `“${oneLine(url, 80)}” is not an http(s) URL.`, next: [] };
    // The request carries a credential in its headers, so a ticket's title must not be able to add a field to what is sent with it.
    const template = text(node, 'body');
    const body = isJsonTemplate(template) ? renderJsonTemplate(template, context) : renderTemplate(template, context);
    if (dry) return { status: 'done', message: `Dry run: would ${method} ${redactUrl(url)}.`, ...(method === 'GET' ? {} : { detail: body }), next: 'all' };
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // Headers are where an API's credential goes, so they are never in the workflow: they come from the environment.
    const variable = text(node, 'headersEnv', 'HTTP_HEADERS');
    const raw = effects.env[variable];
    if (raw !== undefined && raw.trim().length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'failed', message: `${variable} is not a JSON object of headers.`, next: [] };
      for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) headers[name.toLowerCase()] = String(value);
    }
    const response = await request(url, { method, headers, ...(method === 'GET' ? {} : { body }) }, 30_000);
    if (typeof response === 'string') return { status: 'failed', message: `${method} ${redactUrl(url)} did not go through: ${response}.`, next: [] };
    const outcome = `${method} ${redactUrl(url)} → ${response.status}`;
    return response.ok ? { status: 'done', message: outcome, next: 'all' } : { status: 'failed', message: outcome, detail: clip(await response.text().catch(() => ''), 1000), next: [] };
  }

  async function postRunJson(node: GraphNode): Promise<NodeResult> {
    const url = renderedUrl(node, 'url');
    if (!/^https?:\/\//i.test(url)) return { status: 'failed', message: `“${oneLine(url, 80)}” is not an http(s) URL.`, next: [] };
    if (dry) return { status: 'done', message: `Dry run: would post the run document to ${redactUrl(url)}.`, next: 'all' };
    const document = { workflow: { id: graph.id, name: graph.name }, event: { id: event.id, source: event.source, actor: event.actor }, issue, run: context['runDocument'] ?? null };
    const response = await request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(document) }, 30_000);
    if (typeof response === 'string') return { status: 'failed', message: `The run document did not reach ${redactUrl(url)}: ${response}.`, next: [] };
    const outcome = `Posted the run document to ${redactUrl(url)} → ${response.status}`;
    return response.ok ? { status: 'done', message: outcome, next: 'all' } : { status: 'failed', message: outcome, next: [] };
  }

  /**
   * One request to somewhere a step was pointed at. A request that never got
   * an answer comes back as a reason, in words that are not the address: what
   * `fetch` throws quotes the URL it was given, and a webhook's URL is its
   * credential.
   */
  async function request(url: string, init: RequestInit, timeoutMs: number): Promise<Response | string> {
    try {
      return await effects.fetch(url, { ...init, signal: AbortSignal.any([effects.signal, AbortSignal.timeout(timeoutMs)]) });
    } catch (error) {
      if (effects.signal.aborted) throw new Cancelled();
      const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
      const name = error instanceof Error ? error.name : '';
      return name === 'TimeoutError' ? `no answer within ${Math.round(timeoutMs / 1000)} seconds` : typeof cause === 'string' ? `the connection failed (${cause})` : 'the request could not be made';
    }
  }

  async function chat(node: GraphNode, variable: string, app: string, body: (message: string) => object, encode?: (value: string) => string): Promise<NodeResult> {
    const message = rendered(node, 'text', '', encode).trim();
    if (message.length === 0) return { status: 'failed', message: `${app}: the message is empty once its variables are filled in.`, next: [] };
    if (dry) return { status: 'done', message: `Dry run: would post to ${app}.`, detail: message, next: 'all' };
    const url = effects.env[variable]?.trim();
    if (url === undefined || url.length === 0) {
      return { status: 'failed', message: `${app}: ${variable} is not set, so there is nowhere to post.`, detail: `Make a webhook in ${app} and export it as ${variable} where the workflow runs.`, next: [] };
    }
    // Said without the value: the address is the credential.
    if (!isWebhookAddress(url)) return { status: 'failed', message: `${app}: ${variable} is not an https:// address.`, detail: `Copy the webhook’s whole URL from ${app}, starting with https://.`, next: [] };
    const response = await request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body(message)) }, 20_000);
    if (typeof response === 'string') return { status: 'failed', message: `${app}: ${response}.`, next: [] };
    if (!response.ok) return { status: 'failed', message: `${app} answered HTTP ${response.status}.`, detail: clip(await response.text().catch(() => ''), 500), next: [] };
    return { status: 'done', message: `Posted to ${app}.`, detail: message, next: 'all' };
  }

  /**
   * An app step Relay has no connection for, handed to the person's own
   * endpoint: what the node was set to do, with its variables filled in, and
   * the run it belongs to. The same request the exported Action sends, so one
   * bridge serves both. With no bridge the step did not happen, and says so.
   */
  async function bridge(node: GraphNode): Promise<NodeResult> {
    const [connector = '', , action = ''] = node.type.split('.');
    const url = effects.env[BRIDGE_VARIABLE]?.trim() ?? '';
    if (url.length === 0) return { status: 'unwired', message: `Not performed: Relay has no connection to ${connector} yet, and ${BRIDGE_VARIABLE} is not set.`, next: 'all' };
    if (!/^https?:\/\//i.test(url)) return { status: 'failed', message: `${BRIDGE_VARIABLE} is not an http(s) URL.`, next: [] };
    const config: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node.config)) config[key] = typeof value === 'string' ? renderTemplate(value, context) : value;
    const message = ['text', 'body', 'message', 'title'].map((key) => config[key]).find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? '';
    if (dry) return { status: 'done', message: `Dry run: would hand ${connector}.${action} to your bridge.`, ...(message.length === 0 ? {} : { detail: message }), next: 'all' };
    const body = { run: run['id'], prUrl: run['prUrl'], status: run['status'], message, action: { connector, action, config }, issue, workflow: graph.name, repository: graph.repository };
    const response = await request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 30_000);
    if (typeof response === 'string') return { status: 'failed', message: `${connector}.${action} did not reach your bridge: ${response}.`, next: [] };
    const outcome = `Handed ${connector}.${action} to your bridge → ${response.status}`;
    return response.ok ? { status: 'done', message: outcome, ...(message.length === 0 ? {} : { detail: message }), next: 'all' } : { status: 'failed', message: outcome, next: [] };
  }

  /** The GitHub issue the event is about: its number, or a reference `gh` accepts. */
  function githubIssueRef(): string | null {
    const number = issue['number'];
    if (typeof number === 'number' || (typeof number === 'string' && /^\d+$/.test(number))) return String(number);
    const url = String(issue['url'] ?? '');
    if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+/.test(url)) return url;
    if (event.task?.kind === 'issue' && /^(#?\d+|https:\/\/github\.com\/.+\/issues\/\d+)$/.test(event.task.ref)) return event.task.ref.replace(/^#/, '');
    const key = String(issue['key'] ?? issue['id'] ?? '');
    return /^#?\d+$/.test(key) ? key.replace(/^#/, '') : null;
  }

  async function gh(args: string[], done: string, would: string): Promise<NodeResult> {
    if (dry) return { status: 'done', message: `Dry run: would ${would}.`, next: 'all' };
    const result = await effects.gh(args);
    return result.ok ? { status: 'done', message: done, ...(result.stdout.trim().length === 0 ? {} : { detail: clip(result.stdout.trim(), 500) }), next: 'all' } : { status: 'failed', message: `gh: ${oneLine(result.stderr || result.stdout || 'failed', 240)}`, next: [] };
  }

  async function githubIssue(node: GraphNode): Promise<NodeResult> {
    const action = node.type.split('.')[2];
    if (action === 'create-issue') {
      const heading = rendered(node, 'title').trim();
      if (heading.length === 0) return { status: 'failed', message: 'The new issue has no title.', next: [] };
      const body = rendered(node, 'body');
      const repo = text(node, 'repo').trim();
      const labels = lines(node.config['labels']);
      if (dry) return { status: 'done', message: `Dry run: would open an issue “${oneLine(heading, 80)}”.`, next: 'all' };
      const result = await effects.gh(['issue', 'create', '--title', heading, '--body', body, ...(repo.length === 0 ? [] : ['--repo', repo]), ...labels.flatMap((label) => ['--label', label])]);
      const url = /https:\/\/github\.com\/[^\s]+\/issues\/(\d+)/.exec(result.stdout);
      if (!result.ok || url === null) return { status: 'failed', message: `gh: ${oneLine(result.stderr || result.stdout || 'could not open the issue', 240)}`, next: [] };
      // Every step after this is about the issue that was just filed.
      Object.assign(issue, { id: `#${url[1]}`, key: `#${url[1]}`, number: Number(url[1]), title: heading, body, url: url[0], createdRef: url[0] });
      return { status: 'done', message: `Opened issue #${url[1]}: ${oneLine(heading, 100)}`, detail: url[0], next: 'all' };
    }
    const ref = githubIssueRef();
    if (ref === null) return { status: 'failed', message: 'The event is not about a GitHub issue, so there is nothing to act on.', next: [] };
    switch (action) {
      case 'comment': {
        const body = rendered(node, 'body').trim();
        if (body.length === 0) return { status: 'failed', message: 'The comment is empty once its variables are filled in.', next: [] };
        return gh(['issue', 'comment', ref, '--body', body], `Commented on issue ${ref}.`, `comment on issue ${ref}`);
      }
      case 'add-label':
      case 'remove-label': {
        const label = text(node, 'label').trim();
        if (label.length === 0) return { status: 'failed', message: 'No label is named.', next: [] };
        const adding = action === 'add-label';
        return gh(['issue', 'edit', ref, adding ? '--add-label' : '--remove-label', label], `${adding ? 'Added' : 'Removed'} the label ${label} on issue ${ref}.`, `${adding ? 'add' : 'remove'} the label ${label} on issue ${ref}`);
      }
      case 'assign': {
        const assignee = text(node, 'assignee').trim().replace(/^@/, '');
        if (assignee.length === 0) return { status: 'failed', message: 'Nobody is named to assign.', next: [] };
        return gh(['issue', 'edit', ref, '--add-assignee', assignee], `Assigned issue ${ref} to ${assignee}.`, `assign issue ${ref} to ${assignee}`);
      }
      case 'close-issue': {
        const reason = text(node, 'reason', 'completed') === 'not-planned' ? 'not planned' : 'completed';
        return gh(['issue', 'close', ref, '--reason', reason], `Closed issue ${ref} as ${reason}.`, `close issue ${ref}`);
      }
      default:
        return { status: 'unwired', message: `Not performed: this Relay has no handler for ${node.type}.`, next: 'all' };
    }
  }

  async function githubPullRequest(node: GraphNode): Promise<NodeResult> {
    const pr = String(run['prUrl'] ?? '');
    if (pr.length === 0 && !dry) return { status: 'skipped', message: 'No pull request to act on: this run opened none.', next: 'all' };
    const target = pr.length === 0 ? 'the pull request' : pr;
    switch (node.type.split('.')[2]) {
      case 'comment': {
        const body = rendered(node, 'body').trim();
        if (body.length === 0) return { status: 'failed', message: 'The comment is empty once its variables are filled in.', next: [] };
        return gh(['pr', 'comment', pr, '--body', body], 'Commented on the pull request.', `comment on ${target}`);
      }
      case 'add-label': {
        const label = text(node, 'label').trim();
        if (label.length === 0) return { status: 'failed', message: 'No label is named.', next: [] };
        return gh(['pr', 'edit', pr, '--add-label', label], `Added the label ${label} to the pull request.`, `add the label ${label} to ${target}`);
      }
      case 'request-review': {
        const reviewers = lines(node.config['reviewers']);
        if (reviewers.length === 0) return { status: 'failed', message: 'No reviewers are named.', next: [] };
        return gh(['pr', 'edit', pr, '--add-reviewer', reviewers.join(',')], `Asked ${reviewers.join(', ')} to review the pull request.`, `ask ${reviewers.join(', ')} to review ${target}`);
      }
      default:
        return { status: 'unwired', message: `Not performed: this Relay has no handler for ${node.type}.`, next: 'all' };
    }
  }

  async function linear(node: GraphNode): Promise<NodeResult> {
    const action = node.type.split('.')[2];
    const key = [issue['key'], issue['id'], event.task?.kind === 'issue' ? event.task.ref : undefined].map((value) => String(value ?? '')).find((value) => /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(value));

    if (action === 'create-issue') {
      const heading = rendered(node, 'title').trim();
      const team = text(node, 'team').trim();
      if (heading.length === 0) return { status: 'failed', message: 'The new Linear issue has no title.', next: [] };
      if (team.length === 0) return { status: 'failed', message: 'The Create issue step names no Linear team (its key, such as ENG).', next: [] };
      if (dry) return { status: 'done', message: `Dry run: would file “${oneLine(heading, 80)}” in Linear team ${team}.`, next: 'all' };
      const teams = await effects.linear<{ teams: { nodes: Array<{ id: string; key: string }> } }>('query Team($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key } } }', { key: team.toUpperCase() });
      const found = teams.teams?.nodes?.[0];
      if (found === undefined) return { status: 'failed', message: `Linear has no team with the key ${team.toUpperCase()}.`, next: [] };
      const body = rendered(node, 'body');
      const made = await effects.linear<{ issueCreate: { success: boolean; issue?: { identifier?: string; url?: string; title?: string } | null } }>(
        'mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url title } } }',
        { input: { teamId: found.id, title: heading, description: body } },
      );
      const identifier = made.issueCreate?.issue?.identifier;
      if (made.issueCreate?.success !== true || identifier === undefined) return { status: 'failed', message: 'Linear refused the new issue.', next: [] };
      Object.assign(issue, { id: identifier, key: identifier, title: heading, body, url: made.issueCreate.issue?.url ?? '', createdRef: identifier });
      delete issue['number'];
      return { status: 'done', message: `Filed ${identifier}: ${oneLine(heading, 100)}`, ...(made.issueCreate.issue?.url === undefined ? {} : { detail: made.issueCreate.issue.url }), next: 'all' };
    }

    if (key === undefined) return { status: 'failed', message: 'The event is not about a Linear issue (a key like ENG-142), so there is nothing to act on.', next: [] };
    if (dry) return { status: 'done', message: `Dry run: would ${action === 'comment' ? 'comment on' : action === 'attach-pr' ? 'attach the pull request to' : action === 'add-label' ? 'label' : 'move'} ${key}.`, next: 'all' };

    const found = await effects.linear<{ issue: { id: string; team?: { states?: { nodes?: Array<{ id: string; name: string }> } } } | null }>(
      'query Issue($id: String!) { issue(id: $id) { id team { states { nodes { id name } } } } }',
      { id: key },
    );
    if (found.issue === null || found.issue === undefined) return { status: 'failed', message: `Linear has no issue ${key}, or this key cannot see it.`, next: [] };

    switch (action) {
      case 'comment': {
        const body = rendered(node, 'body').trim();
        if (body.length === 0) return { status: 'failed', message: 'The comment is empty once its variables are filled in.', next: [] };
        const made = await effects.linear<{ commentCreate: { success: boolean } }>('mutation Comment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }', { issueId: found.issue.id, body });
        return made.commentCreate?.success === true ? { status: 'done', message: `Commented on ${key}.`, detail: body, next: 'all' } : { status: 'failed', message: `Linear refused the comment on ${key}.`, next: [] };
      }
      case 'update-state': {
        const wanted = text(node, 'state').trim();
        if (wanted.length === 0) return { status: 'failed', message: 'The Move to state step names no state.', next: [] };
        const states = found.issue.team?.states?.nodes ?? [];
        const target = states.find((candidate) => candidate.name.toLowerCase() === wanted.toLowerCase());
        if (target === undefined) return { status: 'failed', message: `${key}'s team has no state called “${wanted}”.`, detail: `It has: ${states.map((candidate) => candidate.name).join(', ') || 'none this key can see'}.`, next: [] };
        const moved = await effects.linear<{ issueUpdate: { success: boolean } }>('mutation Move($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }', { id: found.issue.id, stateId: target.id });
        return moved.issueUpdate?.success === true ? { status: 'done', message: `Moved ${key} to ${target.name}.`, next: 'all' } : { status: 'failed', message: `Linear refused to move ${key}.`, next: [] };
      }
      case 'add-label': {
        const wanted = text(node, 'label').trim();
        if (wanted.length === 0) return { status: 'failed', message: 'The Add label step names no label.', next: [] };
        const labels = await effects.linear<{ issueLabels: { nodes: Array<{ id: string; name: string }> } }>('query Label($name: String!) { issueLabels(filter: { name: { eqIgnoreCase: $name } }) { nodes { id name } } }', { name: wanted });
        const label = labels.issueLabels?.nodes?.[0];
        if (label === undefined) return { status: 'failed', message: `Linear has no label called “${wanted}”. Make it there first: a step does not invent labels.`, next: [] };
        const added = await effects.linear<{ issueAddLabel: { success: boolean } }>('mutation Label($id: String!, $labelId: String!) { issueAddLabel(id: $id, labelId: $labelId) { success } }', { id: found.issue.id, labelId: label.id });
        return added.issueAddLabel?.success === true ? { status: 'done', message: `Labelled ${key} ${label.name}.`, next: 'all' } : { status: 'failed', message: `Linear refused the label on ${key}.`, next: [] };
      }
      case 'attach-pr': {
        const pr = String(run['prUrl'] ?? '');
        if (pr.length === 0) return { status: 'skipped', message: `No pull request to attach to ${key}: this run opened none.`, next: 'all' };
        const attached = await effects.linear<{ attachmentCreate: { success: boolean } }>('mutation Attach($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success } }', { input: { issueId: found.issue.id, url: pr, title: `Pull request: ${oneLine(title, 120)}` } });
        return attached.attachmentCreate?.success === true ? { status: 'done', message: `Attached the pull request to ${key}.`, detail: pr, next: 'all' } : { status: 'failed', message: `Linear refused the attachment on ${key}.`, next: [] };
      }
      default:
        return { status: 'unwired', message: `Not performed: this Relay has no handler for ${node.type}.`, next: 'all' };
    }
  }
}

/* ------------------------------------------------------------------ */

function lines(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim().replace(/^@/, '')).filter(Boolean);
  return String(value ?? '')
    .split(/[\n,]/)
    .map((entry) => entry.trim().replace(/^@/, ''))
    .filter(Boolean);
}

/** A number the walk wrote for itself, or null when there is none. */
function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * An amount somebody typed into a gate: `2.50`, `$20`, `1,000`. Empty is "no
 * ceiling" and says so with null. Anything else that is not an amount is an
 * error rather than no ceiling — the difference between a typo and a run with
 * nothing to stop it.
 */
function money(value: unknown): { ok: true; value: number | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? { ok: true, value } : { ok: false };
  const typed = String(value).trim();
  if (typed.length === 0) return { ok: true, value: null };
  const digits = typed.replace(/^\$\s*/, '').replace(/,(?=\d{3}(\D|$))/g, '');
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(digits)) return { ok: false };
  return { ok: true, value: Number(digits) };
}

function stepLabel(step: string | undefined): string {
  switch (step) {
    case 'commit':
      return 'Committed';
    case 'push':
      return 'Pushed';
    case 'pullRequest':
      return 'Opened a pull request';
    case 'merge':
      return 'Merged';
    default:
      return step ?? 'Step';
  }
}

/** Whether a chat webhook's address is one: https, or plain http to this machine, where a stand-in for the app may be listening. */
function isWebhookAddress(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/.test(parsed.hostname));
  } catch {
    return false;
  }
}

/** A URL as a log may show it: a chat webhook's path and any query are the credential. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const secretPath = /hooks\.slack\.com$|(^|\.)discord(app)?\.com$/.test(parsed.hostname);
    return `${parsed.origin}${secretPath ? '/…' : parsed.pathname}${parsed.search.length > 0 ? '?…' : ''}`;
  } catch {
    return oneLine(url, 60);
  }
}

/** "Answer fixable or needs-a-person" → ['fixable', 'needs-a-person']. */
export function answerOptions(prompt: string): string[] | undefined {
  const match = /\banswer\s+(?:with\s+)?((?:[\w-]+\s*,\s*)*[\w-]+\s+or\s+[\w-]+)/i.exec(prompt) ?? /\b(?:as|is it)\s+((?:[\w-]+\s*,\s*)*[\w-]+\s+or\s+[\w-]+)/i.exec(prompt);
  if (match === null) return undefined;
  const options = match[1]!.split(/\s*,\s*|\s+or\s+/).map((option) => option.trim().toLowerCase()).filter(Boolean);
  return options.length >= 2 ? options : undefined;
}

/**
 * What a model's reply comes to, for a Condition to read. When the prompt
 * asked for one of a few words, it is whichever of them the reply says first;
 * otherwise the reply's first line.
 */
export function pickAnswer(prompt: string, reply: string): string {
  const options = answerOptions(prompt);
  const said = reply.trim();
  if (options !== undefined) {
    const lower = said.toLowerCase();
    const found = options
      .map((option) => ({ option, at: lower.search(new RegExp(`(?<![\\w-])${option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`)) }))
      .filter((entry) => entry.at >= 0)
      .sort((a, b) => a.at - b.at)[0];
    if (found !== undefined) return found.option;
  }
  return oneLine(said.split('\n').find((line) => line.trim().length > 0) ?? '', 200);
}
