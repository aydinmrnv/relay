import { screenText } from '../unattended/injection.ts';
import { errorMessage } from '../util/errors.ts';
import { clip, oneLine } from '../util/text.ts';
import { formatCost } from '../workflow/usage.ts';
import { evaluateCondition, evaluateFilter, renderTemplate } from './expression.ts';
import { nextWindowOpening } from './schedule.ts';
import { nodeSupport } from './support.ts';
import { triggerOf, type GraphNode, type GraphNodeStatus, type GraphRecord, type GraphRunStatus, type GraphTask, type WorkflowEvent, type WorkflowGraph } from './types.ts';

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
  /** Asks a person, and waits for the answer or the deadline. `announce` is told how to answer, once that is known. */
  approval(ask: ApprovalAsk, announce: (how: string) => void): Promise<ApprovalAnswer>;

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
  const incoming = new Map<string, number>();
  for (const edge of graph.edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }

  const status: Record<string, GraphNodeStatus | 'pending'> = Object.fromEntries(graph.nodes.map((node) => [node.id, 'pending']));
  const unwired: string[] = [];
  // Held in one object so the closures below and the code after the walk read the same thing.
  const state: { pipeline: PipelineResult | null; pipelineStarted: boolean; extraCostUsd: number; refused: boolean; failed: boolean } = {
    pipeline: null,
    pipelineStarted: false,
    extraCostUsd: 0,
    refused: false,
    failed: false,
  };

  const issue: Record<string, unknown> = { ...event.payload };
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
  const title = oneLine(String(issue['title'] ?? issue['id'] ?? (event.task?.kind === 'prompt' ? event.task.text : event.task?.ref) ?? 'event'), 120);

  effects.emit({
    type: 'workflow_started',
    at: at(),
    workflow: { id: graph.id, name: graph.name },
    event: { id: event.id, source: event.source, attended: event.attended, actor: event.actor, title },
    nodes: graph.nodes.map((node) => ({ id: node.id, nodeType: node.type, name: node.name, real: nodeSupport(node.type).real })),
  });

  // The same walk as a test run: a queue of nodes, each run once, with a
  // Merge paths node waiting for every path that has not been ruled out.
  const visited = new Set<string>();
  const joins = new Map<string, { arrived: number; ruledOut: number }>();
  const isJoin = (id: string): boolean => nodesById.get(id)?.type === 'logic.action.merge-paths';
  const queue: string[] = [triggerOf(graph).id];
  let cancelled = false;

  const markSkipped = (id: string): void => {
    if (isJoin(id)) return arriveAtJoin(id, false);
    if (status[id] !== 'pending') return;
    status[id] = 'skipped';
    for (const edge of outgoing.get(id) ?? []) markSkipped(edge.to);
  };
  const arriveAtJoin = (id: string, arrived: boolean): void => {
    if (visited.has(id) || status[id] === 'skipped') return;
    const join = joins.get(id) ?? { arrived: 0, ruledOut: 0 };
    if (arrived) join.arrived += 1;
    else join.ruledOut += 1;
    joins.set(id, join);
    if (join.arrived + join.ruledOut < (incoming.get(id) ?? 1)) return;
    if (join.arrived > 0) queue.push(id);
    else {
      status[id] = 'skipped';
      for (const edge of outgoing.get(id) ?? []) markSkipped(edge.to);
    }
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
        message: result.message,
        detail: result.detail ?? null,
        durationMs: Math.max(0, effects.now().getTime() - startedAt),
        costUsd: result.costUsd ?? null,
      });

      for (const edge of outgoing.get(id) ?? []) {
        const handle = edge.handle ?? node.outputs[0] ?? null;
        if (result.next !== 'all' && (handle === null || !result.next.includes(handle))) markSkipped(edge.to);
        else if (isJoin(edge.to)) arriveAtJoin(edge.to, true);
        else queue.push(edge.to);
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
  function rendered(node: GraphNode, key: string, fallback = ''): string {
    return renderTemplate(text(node, key, fallback), context);
  }

  async function perform(node: GraphNode): Promise<NodeResult> {
    if (node.kind === 'trigger') {
      if (!event.attended && !graph.enabled) {
        return { status: 'refused', message: 'Refused: this workflow is paused, so nothing starts it by itself.', detail: 'Switch it to Active in the studio and export it again, or start it by hand.', next: [] };
      }
      return { status: 'done', message: `${event.attended ? 'Started by hand' : node.name}: ${title}`, detail: clip(JSON.stringify(event.payload, null, 2), 4000), next: 'all' };
    }

    const support = nodeSupport(node.type);
    if (!support.real) return { status: 'unwired', message: `Not performed: ${support.note}`, next: 'all' };

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
        effects.emit({ type: 'node_waiting', at: at(), node: node.id, message: `Waiting ${minutes} minute${minutes === 1 ? '' : 's'}.`, detail: null });
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
        effects.emit({ type: 'node_waiting', at: at(), node: node.id, message: `Holding until ${window} (${zone}).`, detail: `Opens at ${opening.opensAt.toISOString()}.` });
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
    if (app === 'slack') return chat(node, 'SLACK_WEBHOOK_URL', 'Slack', (message) => ({ text: message }));
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
      return { status: 'refused', message: 'Refused: the event does not say who started it, and the allowlist names people.', detail: 'Send the login as "actor" in the webhook body, or allow * if the sender is already trusted.', next: ['refused'] };
    }
    if (authors.some((login) => login.toLowerCase() === actor.toLowerCase())) return { status: 'done', message: `@${actor} is allowed.`, next: ['pass'] };
    if (teams.length > 0) {
      const team = await effects.teamOf(actor, teams);
      if (team !== null) return { status: 'done', message: `@${actor} is allowed, as a member of ${team}.`, next: ['pass'] };
    }
    return { status: 'refused', message: `Refused: @${actor} is not on the allowlist.`, next: ['refused'] };
  }

  async function budget(node: GraphNode): Promise<NodeResult> {
    const maxRun = numberOrNull(node.config['maxRunCostUsd']);
    const maxDaily = numberOrNull(node.config['maxDailyCostUsd']);
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
    const spend = await effects.spend();
    // Each run in flight has reported nothing yet, so it reserves its whole cap — the rule `relay serve` uses.
    const committed = spend.spentUsd + spend.inFlight * (maxRun ?? 0);
    const wouldCommit = committed + (maxRun ?? 0);
    const floor = spend.unpriced === 0 ? '' : ` (${spend.unpriced} turn${spend.unpriced === 1 ? '' : 's'} reported no price, so today’s spend is a floor)`;
    if (wouldCommit > maxDaily || spend.spentUsd >= maxDaily) {
      return {
        status: 'refused',
        message: `Refused: ${formatCost(spend.spentUsd)} spent today across ${spend.runs} unattended run${spend.runs === 1 ? '' : 's'}, and another could take it past ${formatCost(maxDaily)}${floor}.`,
        detail: 'Never queued for tomorrow: that is the same spend with a delay in front of it.',
        next: ['refused'],
      };
    }
    return { status: 'done', message: `Within budget: ${formatCost(committed)} of ${formatCost(maxDaily)} committed today, this run ${held}${floor}.`, next: ['pass'] };
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
    const answer = await effects.approval(ask, (how) => effects.emit({ type: 'node_waiting', at: at(), node: node.id, message: `Waiting for approval: ${title}`, detail: how }));
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
    // A step before the pipeline may have filed a new ticket; the agents work on that one.
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
    if (dry) return { status: 'done', message: 'Dry run: would ask a model. No answer, so what reads it sees no value.', detail: prompt, next: 'all' };
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
    const url = rendered(node, 'url').trim();
    const configured = text(node, 'method', 'POST').toUpperCase();
    const method = ['POST', 'GET', 'PUT', 'PATCH', 'DELETE'].includes(configured) ? configured : 'POST';
    if (!/^https?:\/\//i.test(url)) return { status: 'failed', message: `“${oneLine(url, 80)}” is not an http(s) URL.`, next: [] };
    const body = rendered(node, 'body');
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
    const response = await effects.fetch(url, { method, headers, ...(method === 'GET' ? {} : { body }), signal: AbortSignal.any([effects.signal, AbortSignal.timeout(30_000)]) });
    const said = `${method} ${redactUrl(url)} → ${response.status}`;
    return response.ok ? { status: 'done', message: said, next: 'all' } : { status: 'failed', message: said, detail: clip(await response.text().catch(() => ''), 1000), next: [] };
  }

  async function postRunJson(node: GraphNode): Promise<NodeResult> {
    const url = rendered(node, 'url').trim();
    if (!/^https?:\/\//i.test(url)) return { status: 'failed', message: `“${oneLine(url, 80)}” is not an http(s) URL.`, next: [] };
    if (dry) return { status: 'done', message: `Dry run: would post the run document to ${redactUrl(url)}.`, next: 'all' };
    const document = { workflow: { id: graph.id, name: graph.name }, event: { id: event.id, source: event.source, actor: event.actor }, issue, run: context['runDocument'] ?? null };
    const response = await effects.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(document), signal: AbortSignal.any([effects.signal, AbortSignal.timeout(30_000)]) });
    const said = `Posted the run document to ${redactUrl(url)} → ${response.status}`;
    return response.ok ? { status: 'done', message: said, next: 'all' } : { status: 'failed', message: said, next: [] };
  }

  async function chat(node: GraphNode, variable: string, app: string, body: (message: string) => object): Promise<NodeResult> {
    const message = rendered(node, 'text').trim();
    if (message.length === 0) return { status: 'failed', message: `${app}: the message is empty once its variables are filled in.`, next: [] };
    if (dry) return { status: 'done', message: `Dry run: would post to ${app}.`, detail: message, next: 'all' };
    const url = effects.env[variable]?.trim();
    if (url === undefined || url.length === 0) {
      return { status: 'failed', message: `${app}: ${variable} is not set, so there is nowhere to post.`, detail: `Make a webhook in ${app} and export it as ${variable} where the workflow runs.`, next: [] };
    }
    const response = await effects.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body(message)), signal: AbortSignal.any([effects.signal, AbortSignal.timeout(20_000)]) });
    if (!response.ok) return { status: 'failed', message: `${app} answered HTTP ${response.status}.`, detail: clip(await response.text().catch(() => ''), 500), next: [] };
    return { status: 'done', message: `Posted to ${app}.`, detail: message, next: 'all' };
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
    if (dry) return { status: 'done', message: `Dry run: would ${action === 'comment' ? 'comment on' : action === 'attach-pr' ? 'attach the pull request to' : 'move'} ${key}.`, next: 'all' };

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

/** A number somebody typed, or null when the field is empty or not a number: "unset", never zero. */
function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
