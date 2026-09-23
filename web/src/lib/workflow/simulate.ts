/**
 * A run that costs nothing.
 *
 * The prototype cannot spawn Claude Code or Codex from a browser, so a "test
 * run" walks the graph and plays back what each node would do, with the same
 * phases, rounds, budgets and refusals the real pipeline has. Everything is
 * seeded, so the same workflow replays the same run until you change it.
 */
import { getNodeType, type NodeTypeDef } from '../connectors';
import type { Brand } from '../brand';
import type { NodeRunStatus, Run, RunEvent, RunPhase, RunStatus, Workflow, WorkflowEdge, WorkflowNode } from './schema';
import { renderTemplate } from './template';

export interface SimulateOptions {
  speed: 'instant' | 'fast' | 'realistic';
  seed?: number;
  brand: Brand;
  repository?: string;
  onEvent?: (event: RunEvent, run: Run) => void;
  signal?: AbortSignal;
  /** Override the trigger payload (e.g. from the "Run with sample" dialog). */
  payload?: Record<string, unknown>;
}

const PHASES: Array<{ phase: string; label: string; agent?: 'planner' | 'planReviewer' | 'implementer' | 'codeReviewer'; ms: [number, number]; cost: [number, number] }> = [
  { phase: 'FETCHING_ISSUE', label: 'Fetching issue', ms: [800, 2000], cost: [0, 0] },
  { phase: 'CREATING_WORKSPACE', label: 'Creating workspace', ms: [1500, 4000], cost: [0, 0] },
  { phase: 'PLANNING', label: 'Planning', agent: 'planner', ms: [90_000, 240_000], cost: [0.35, 1.1] },
  { phase: 'REVIEWING_PLAN', label: 'Plan review', agent: 'planReviewer', ms: [40_000, 120_000], cost: [0.15, 0.6] },
  { phase: 'REVISING_PLAN', label: 'Plan revision', agent: 'planner', ms: [30_000, 90_000], cost: [0.1, 0.4] },
  { phase: 'IMPLEMENTING', label: 'Implementation', agent: 'implementer', ms: [240_000, 900_000], cost: [0.9, 3.8] },
  { phase: 'REVIEWING_CODE', label: 'Code review', agent: 'codeReviewer', ms: [60_000, 180_000], cost: [0.25, 0.9] },
  { phase: 'REVISING_CODE', label: 'Code revision', agent: 'implementer', ms: [60_000, 240_000], cost: [0.4, 1.4] },
  { phase: 'TESTING', label: 'Tests', ms: [20_000, 200_000], cost: [0, 0] },
];

const AGENT_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', aider: 'Aider' };

export async function simulateRun(workflow: Workflow, options: SimulateOptions): Promise<Run> {
  const rng = mulberry32(options.seed ?? hash(workflow.id + workflow.updatedAt));
  const startedAt = new Date();
  const runId = `run_${startedAt.getTime().toString(36)}${Math.floor(rng() * 1e6).toString(36)}`;
  const repository = options.repository ?? workflow.repository ?? 'acme/api';
  const nodesById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, WorkflowEdge[]>();
  for (const edge of workflow.edges) {
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge);
    outgoing.set(edge.source, list);
  }

  const triggerNode = workflow.nodes.find((node) => getNodeType(node.data.typeId)?.kind === 'trigger');
  const triggerDef = triggerNode === undefined ? undefined : getNodeType(triggerNode.data.typeId);
  const payload = options.payload ?? buildPayload(triggerDef, rng);

  const run: Run = {
    id: runId,
    shortId: runId.slice(-6),
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: 'running',
    startedAt: startedAt.toISOString(),
    trigger: {
      typeId: triggerDef?.id ?? 'none',
      connectorId: triggerDef?.connectorId ?? 'none',
      label: triggerDef === undefined ? 'No trigger' : `${triggerDef.connector.name} · ${triggerDef.name}`,
      payload,
    },
    events: [],
    nodeStatus: Object.fromEntries(workflow.nodes.map((node) => [node.id, 'pending' as NodeRunStatus])),
    phases: [],
    costUsd: 0,
  };

  // Virtual clock so "instant" runs still have believable timestamps.
  let clock = startedAt.getTime();
  const tick = (ms: number) => {
    clock += ms;
    return new Date(clock).toISOString();
  };
  const scale = options.speed === 'instant' ? 0 : options.speed === 'fast' ? 0.0025 : 0.012;
  const pause = async (simulatedMs: number) => {
    if (scale === 0) return;
    const real = Math.min(2500, Math.max(120, simulatedMs * scale));
    await new Promise<void>((resolve) => setTimeout(resolve, real));
    if (options.signal?.aborted) throw new Error('cancelled');
  };

  const emit = (event: Omit<RunEvent, 'at'> & { at?: string }) => {
    const full: RunEvent = { at: event.at ?? new Date(clock).toISOString(), ...event };
    run.events.push(full);
    options.onEvent?.(full, run);
  };
  const setStatus = (nodeId: string, status: NodeRunStatus) => {
    run.nodeStatus[nodeId] = status;
  };

  const context: Record<string, unknown> = {
    issue: payload,
    trigger: payload,
    run: { id: run.shortId, status: 'running', cost: '$0.00', prUrl: '', branch: '', tests: 'not run', summary: '', codeReviewer: '', diff: '' },
    workflow: { name: workflow.name, repository },
    product: { name: options.brand.name },
  };

  if (triggerNode === undefined || triggerDef === undefined) {
    emit({ nodeId: null, kind: 'log', message: 'This workflow has no trigger, so there is nothing to start.' });
    return finish('failed');
  }

  let refused = false;
  let failed = false;
  let waited = false;
  const visited = new Set<string>();
  const pendingJoins = new Map<string, number>();

  // Execution is a queue of (node, via-handle). Each node runs once; join nodes wait for all inputs.
  const queue: Array<{ nodeId: string }> = [{ nodeId: triggerNode.id }];
  const incomingCount = new Map<string, number>();
  for (const edge of workflow.edges) incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);

  try {
    while (queue.length > 0) {
      const { nodeId } = queue.shift()!;
      if (visited.has(nodeId)) continue;
      const node = nodesById.get(nodeId);
      const def = node === undefined ? undefined : getNodeType(node.data.typeId);
      if (node === undefined || def === undefined) continue;

      if (def.id === 'logic.action.merge-paths') {
        const seen = (pendingJoins.get(nodeId) ?? 0) + 1;
        pendingJoins.set(nodeId, seen);
        if (seen < (incomingCount.get(nodeId) ?? 1)) {
          setStatus(nodeId, 'waiting');
          emit({ nodeId, kind: 'log', status: 'waiting', message: `${def.name}: waiting for ${(incomingCount.get(nodeId) ?? 1) - seen} more path(s).` });
          continue;
        }
      }
      visited.add(nodeId);

      setStatus(nodeId, 'running');
      const nodeStart = clock;
      emit({ nodeId, kind: 'node-started', status: 'running', message: `${def.connector.name} · ${def.name}` });
      await pause(400);

      const result = await executeNode(node, def);
      const duration = clock - nodeStart;
      setStatus(nodeId, result.status);
      emit({ nodeId, kind: 'node-finished', status: result.status, message: result.message, durationMs: duration, ...(result.detail === undefined ? {} : { detail: result.detail }) });
      if (result.status === 'refused') refused = true;
      if (result.status === 'failed') failed = true;
      if (result.status === 'waiting') waited = true;

      const handles = result.nextHandles;
      const edges = outgoing.get(nodeId) ?? [];
      for (const edge of edges) {
        const handle = edge.sourceHandle ?? def.outputs[0]?.id;
        if (handles !== 'all' && (handle === undefined || !handles.includes(handle))) {
          markSkipped(edge.target);
          continue;
        }
        queue.push({ nodeId: edge.target });
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'cancelled') return finish('cancelled');
    throw error;
  }

  for (const node of workflow.nodes) if (run.nodeStatus[node.id] === 'pending') run.nodeStatus[node.id] = 'skipped';
  return finish(failed ? 'failed' : refused && run.phases.length === 0 ? 'refused' : waited && run.phases.length === 0 ? 'waiting' : 'succeeded');

  /* ---------------------------------------------------------------- */

  function markSkipped(nodeId: string) {
    if (run.nodeStatus[nodeId] === 'pending') {
      run.nodeStatus[nodeId] = 'skipped';
      for (const edge of outgoing.get(nodeId) ?? []) markSkipped(edge.target);
    }
  }

  function finish(status: RunStatus): Run {
    run.status = status;
    run.finishedAt = new Date(clock).toISOString();
    (context.run as Record<string, unknown>).status = status;
    run.summary = summarize(run, context);
    emit({ nodeId: null, kind: 'run-finished', message: `Run ${status}.`, detail: run.summary });
    return run;
  }

  async function executeNode(node: WorkflowNode, def: NodeTypeDef): Promise<{ status: NodeRunStatus; message: string; detail?: string; nextHandles: 'all' | string[] }> {
    const config = { ...defaults(def), ...node.data.config };
    const nodeId = node.id;

    if (def.kind === 'trigger') {
      tick(300);
      return { status: 'done', message: `${def.name}: ${String(payload['title'] ?? payload['id'] ?? 'event received')}`, detail: JSON.stringify(payload, null, 2), nextHandles: 'all' };
    }

    switch (def.id) {
      case 'pipeline.action.run':
      case 'pipeline.action.fast':
        return runPipeline(nodeId, config, def.id === 'pipeline.action.fast');
      case 'pipeline.action.estimate': {
        const estimate = 0.8 + rng() * 4;
        tick(4000);
        (context.issue as Record<string, unknown>).estimateUsd = round(estimate);
        emit({ nodeId, kind: 'cost', message: `Estimated ${usd(estimate)} from the issue and repository size.`, costUsd: round(estimate) });
        return { status: 'done', message: `Estimated ${usd(estimate)}.`, nextHandles: 'all' };
      }
      case 'gates.action.budget': {
        const maxRun = Number(config['maxRunCostUsd'] ?? 5);
        const maxDaily = Number(config['maxDailyCostUsd'] ?? 25);
        const estimate = Number((context.issue as Record<string, unknown>)['estimateUsd'] ?? round(0.8 + rng() * 4));
        const spentToday = round(rng() * maxDaily * 0.6);
        tick(200);
        if (estimate > maxRun) {
          return { status: 'refused', message: `Refused: estimate ${usd(estimate)} exceeds the per-run ceiling ${usd(maxRun)}.`, detail: 'The label stays where the person who applied it can see it.', nextHandles: ['refused'] };
        }
        if (spentToday + estimate > maxDaily) {
          return { status: 'refused', message: `Refused: ${usd(spentToday)} spent today, ${usd(estimate)} more would pass ${usd(maxDaily)}.`, detail: 'Never queued for tomorrow: that is the same spend with a delay in front of it.', nextHandles: ['refused'] };
        }
        return { status: 'done', message: `Within budget: estimate ${usd(estimate)}, ${usd(spentToday)} of ${usd(maxDaily)} spent today.`, nextHandles: ['pass'] };
      }
      case 'gates.action.allowlist': {
        const authors = lines(config['authors']);
        const teams = lines(config['teams']);
        const actor = String(payload['assignee'] ?? payload['author'] ?? payload['reporter'] ?? 'unknown').replace(/^@/, '');
        tick(150);
        if (authors.length === 0 && teams.length === 0) {
          return { status: 'refused', message: 'Refused: the allowlist is empty, so nobody may start a run.', nextHandles: ['refused'] };
        }
        if (authors.includes('*') || authors.includes(actor) || teams.length > 0) {
          return { status: 'done', message: `@${actor} is allowed${teams.length > 0 && !authors.includes(actor) ? ` (via ${teams[0]})` : ''}.`, nextHandles: ['pass'] };
        }
        return { status: 'refused', message: `Refused: @${actor} is not on the allowlist.`, nextHandles: ['refused'] };
      }
      case 'gates.action.approval': {
        const via = String(config['via'] ?? 'dashboard');
        emit({ nodeId, kind: 'message', status: 'waiting', message: `Approval requested via ${via}.` });
        setStatus(nodeId, 'waiting');
        await pause(20_000);
        const approved = rng() > 0.12;
        tick(approved ? 6 * 60_000 : 40 * 60_000);
        return approved
          ? { status: 'done', message: 'Approved by @maintainer (simulated).', nextHandles: ['approved'] }
          : { status: 'refused', message: 'Rejected by @maintainer (simulated).', nextHandles: ['rejected'] };
      }
      case 'gates.action.concurrency':
        tick(100);
        return { status: 'done', message: `0 of ${config['maxConcurrentRuns'] ?? 1} runs in flight; starting.`, nextHandles: 'all' };
      case 'gates.action.kill-switch':
        tick(50);
        return config['enabled'] === true
          ? { status: 'done', message: 'Unattended runs are enabled.', nextHandles: 'all' }
          : { status: 'refused', message: 'Refused: unattended runs are switched off.', detail: 'Flip "Unattended runs enabled" on the kill switch node.', nextHandles: [] };
      case 'delivery.action.deliver':
        return deliver(nodeId, config);
      case 'delivery.action.comment-summary': {
        tick(2500);
        const body = renderTemplate(String(config['body'] ?? '{{run.summary}}'), context);
        return { status: 'done', message: `Commented on ${String(payload['id'] ?? 'the issue')}.`, detail: body, nextHandles: 'all' };
      }
      case 'logic.action.condition': {
        const left = renderTemplate(String(config['left'] ?? ''), context);
        const right = String(config['right'] ?? '');
        const op = String(config['op'] ?? 'contains');
        const outcome = evaluate(left, op, right);
        tick(50);
        return { status: 'done', message: `"${left}" ${op} "${right}" → ${outcome}`, nextHandles: [outcome ? 'true' : 'false'] };
      }
      case 'logic.action.filter':
        tick(50);
        return { status: 'done', message: `Passed: ${String(config['expression'] ?? 'true')}`, nextHandles: 'all' };
      case 'logic.action.transform':
        tick(80);
        return { status: 'done', message: 'Payload transformed.', nextHandles: 'all' };
      case 'logic.action.ai-step': {
        const prompt = renderTemplate(String(config['prompt'] ?? ''), context);
        const cost = round(0.01 + rng() * 0.08);
        tick(6000 + rng() * 9000);
        run.costUsd = round(run.costUsd + cost);
        const kinds = ['bug', 'feature', 'chore'];
        const verdict = `${kinds[Math.floor(rng() * kinds.length)]}, size ${['S', 'M', 'L'][Math.floor(rng() * 3)]}`;
        (context.issue as Record<string, unknown>).triage = verdict;
        emit({ nodeId, kind: 'cost', message: `${String(config['model'] ?? 'model')} · ${usd(cost)}`, costUsd: cost });
        return { status: 'done', message: `Model answered: ${verdict}.`, detail: prompt, nextHandles: 'all' };
      }
      case 'logic.action.merge-paths':
        tick(10);
        return { status: 'done', message: 'All paths arrived.', nextHandles: 'all' };
      case 'logic.action.note':
        return { status: 'skipped', message: 'Note.', nextHandles: [] };
      case 'schedule.action.delay':
        tick(Number(config['minutes'] ?? 10) * 60_000);
        return { status: 'done', message: `Waited ${config['minutes'] ?? 10} minutes.`, nextHandles: 'all' };
      case 'schedule.action.business-hours':
        tick(35 * 60_000);
        return { status: 'done', message: `Held until ${String(config['window'] ?? 'business hours')}.`, nextHandles: 'all' };
      case 'http.action.request': {
        tick(600 + rng() * 900);
        const url = String(config['url'] ?? 'https://example.com');
        return { status: 'done', message: `${String(config['method'] ?? 'POST')} ${url} → 200 OK`, detail: renderTemplate(String(config['body'] ?? ''), context), nextHandles: 'all' };
      }
      case 'http.action.post-run-json':
        tick(700);
        return { status: 'done', message: `Posted the run document to ${String(config['url'] ?? 'the webhook')} → 200 OK`, nextHandles: 'all' };
      default:
        return genericAction(nodeId, def, config);
    }
  }

  async function runPipeline(nodeId: string, config: Record<string, unknown>, fast: boolean) {
    const agents = {
      planner: String(config['planner'] ?? 'claude'),
      planReviewer: String(config['planReviewer'] ?? 'codex'),
      implementer: String(config['implementer'] ?? 'codex'),
      codeReviewer: String(config['codeReviewer'] ?? 'claude'),
    };
    const maxPlan = Number(config['maxPlanReviewRounds'] ?? 2);
    const maxCode = Number(config['maxCodeReviewRounds'] ?? 2);
    const maxCost = config['maxCostUsd'] === undefined || config['maxCostUsd'] === '' || config['maxCostUsd'] === null ? null : Number(config['maxCostUsd']);
    const runTests = config['runTests'] !== false;
    const key = String(payload['id'] ?? 'task');
    const branch = `${String(config['branchPrefix'] ?? options.brand.slug)}/${key.toLowerCase()}-${slug(String(payload['title'] ?? 'change')).slice(0, 32)}`;
    run.branch = branch;
    (context.run as Record<string, unknown>).branch = branch;
    (context.run as Record<string, unknown>).codeReviewer = AGENT_NAMES[agents.codeReviewer] ?? agents.codeReviewer;

    const planRounds = fast ? 0 : 1 + (rng() < 0.45 ? 1 : 0);
    const codeRounds = 1 + (rng() < 0.35 ? 1 : 0);
    const sequence: string[] = ['FETCHING_ISSUE', 'CREATING_WORKSPACE'];
    if (!fast) {
      sequence.push('PLANNING');
      for (let round = 1; round <= Math.min(planRounds, maxPlan); round += 1) {
        sequence.push('REVIEWING_PLAN');
        if (round < Math.min(planRounds, maxPlan) || (round === planRounds && planRounds > 1)) sequence.push('REVISING_PLAN');
      }
    }
    sequence.push('IMPLEMENTING');
    if (!fast) {
      for (let round = 1; round <= Math.min(codeRounds, maxCode); round += 1) {
        sequence.push('REVIEWING_CODE');
        if (round < Math.min(codeRounds, maxCode)) sequence.push('REVISING_CODE');
      }
    }
    if (runTests) sequence.push('TESTING');

    let pipelineCost = 0;
    for (const name of sequence) {
      const spec = PHASES.find((phase) => phase.phase === name)!;
      const ms = spec.ms[0] + rng() * (spec.ms[1] - spec.ms[0]);
      const cost = round(spec.cost[0] + rng() * (spec.cost[1] - spec.cost[0]));
      const agent = spec.agent === undefined ? undefined : agents[spec.agent];
      const label = spec.label;
      emit({ nodeId, kind: 'phase', phase: name, status: 'running', message: `${label}${agent === undefined ? '' : ` · ${AGENT_NAMES[agent] ?? agent}`}` });
      await pause(ms);
      tick(ms);
      pipelineCost = round(pipelineCost + cost);
      run.costUsd = round(run.costUsd + cost);
      (context.run as Record<string, unknown>).cost = usd(run.costUsd);

      let status: RunPhase['status'] = 'done';
      let detail = phaseDetail(name, agent, rng);
      if (name === 'TESTING') {
        const passed = rng() > 0.08;
        const command = String(config['testCommand'] ?? '').trim() || 'npm test';
        run.tests = { passed, command, durationMs: Math.round(ms) };
        (context.run as Record<string, unknown>).tests = passed ? 'passed' : 'failed';
        detail = passed ? `${command} exited 0` : `${command} exited 1 — 2 failing`;
        if (!passed) status = 'failed';
      }
      run.phases.push({ phase: name, label, ms: Math.round(ms), status, ...(agent === undefined ? {} : { agent: AGENT_NAMES[agent] ?? agent }), costUsd: cost });
      emit({ nodeId, kind: 'phase', phase: name, status: status === 'failed' ? 'failed' : 'done', message: `${label} · ${formatMs(ms)}${cost > 0 ? ` · ${usd(cost)}` : ''}`, detail, durationMs: Math.round(ms), costUsd: cost });

      if (name === 'IMPLEMENTING' || name === 'REVISING_CODE') {
        run.diff = { files: 3 + Math.floor(rng() * 9), additions: 40 + Math.floor(rng() * 260), deletions: 5 + Math.floor(rng() * 90) };
        (context.run as Record<string, unknown>).diff = `+${run.diff.additions} −${run.diff.deletions} across ${run.diff.files} files`;
        emit({ nodeId, kind: 'artifact', message: `Diff: +${run.diff.additions} −${run.diff.deletions} across ${run.diff.files} files`, detail: 'Computed from git, not from what the agent said it did.' });
      }
      if (name === 'PLANNING') emit({ nodeId, kind: 'artifact', message: 'plan.md written', detail: samplePlan(String(payload['title'] ?? 'the change')) });

      if (maxCost !== null && run.costUsd > maxCost) {
        emit({ nodeId, kind: 'cost', status: 'failed', message: `Budget exceeded: ${usd(run.costUsd)} spent of ${usd(maxCost)}. Work so far is committed to ${branch}; nothing is published.` });
        return { status: 'failed' as NodeRunStatus, message: `Stopped: budget exceeded after ${label}.`, nextHandles: [] as string[] };
      }
      if (status === 'failed') {
        return { status: 'failed' as NodeRunStatus, message: `Tests failed after ${formatMs(ms)}. The diff stays on ${branch}.`, detail, nextHandles: [] as string[] };
      }
    }

    (context.run as Record<string, unknown>).summary = summarize(run, context);
    return {
      status: 'done' as NodeRunStatus,
      message: `${fast ? 'Fast run' : 'Pipeline'} finished · ${usd(pipelineCost)} · ${run.tests === undefined ? 'tests skipped' : run.tests.passed ? 'tests passed' : 'tests failed'}`,
      detail: `Planned by ${AGENT_NAMES[agents.planner]}, reviewed by ${AGENT_NAMES[agents.planReviewer]}, implemented by ${AGENT_NAMES[agents.implementer]}, diff reviewed by ${AGENT_NAMES[agents.codeReviewer]}.`,
      nextHandles: 'all' as const,
    };
  }

  async function deliver(nodeId: string, config: Record<string, unknown>) {
    const requested = String(config['policy'] ?? 'pr');
    const unattended = triggerDef !== undefined && triggerDef.id !== 'logic.trigger.manual';
    const policy = unattended && requested === 'merge' ? 'pr' : requested;
    if (policy !== requested) emit({ nodeId, kind: 'log', status: 'running', message: 'Delivery capped at "pr": an unattended run never merges.' });
    const steps: string[] = [];
    if (policy === 'none') return { status: 'done' as NodeRunStatus, message: 'Left the diff in the worktree.', nextHandles: 'all' as const };
    steps.push(`Committed to ${run.branch ?? 'the branch'}`);
    tick(1500);
    if (config['secretScan'] !== false) steps.push('Secret scan: clean');
    if (policy === 'branch') return { status: 'done' as NodeRunStatus, message: steps.join(' · '), nextHandles: 'all' as const };
    steps.push('Pushed');
    tick(3000);
    if (policy === 'push') return { status: 'done' as NodeRunStatus, message: steps.join(' · '), nextHandles: 'all' as const };
    const number = 100 + Math.floor(rng() * 900);
    const prUrl = `https://github.com/${repository}/pull/${number}`;
    run.prUrl = prUrl;
    (context.run as Record<string, unknown>).prUrl = prUrl;
    const title = renderTemplate(String(config['prTitle'] ?? '{{issue.title}}'), context);
    steps.push(`Opened ${config['draft'] === false ? 'PR' : 'draft PR'} #${number}`);
    tick(4000);
    emit({ nodeId, kind: 'artifact', message: `Pull request #${number}: ${title}`, detail: renderTemplate(String(config['prBody'] ?? ''), context) });
    if (policy === 'merge') {
      tick(90_000);
      steps.push(`Merged (${String(config['mergeMethod'] ?? 'squash')})`);
    }
    return { status: 'done' as NodeRunStatus, message: steps.join(' · '), detail: prUrl, nextHandles: 'all' as const };
  }

  async function genericAction(nodeId: string, def: NodeTypeDef, config: Record<string, unknown>) {
    tick(800 + rng() * 2500);
    const rendered = def.fields
      .filter((field) => field.type === 'template')
      .map((field) => `${field.label}: ${renderTemplate(String(config[field.key] ?? field.default ?? ''), context)}`)
      .join('\n\n');
    const target = def.fields.find((field) => field.type === 'text' && /channel|to|board|database|project|repo|path|scheme|playlist|list/i.test(field.key));
    const targetText = target === undefined ? '' : ` → ${String(config[target.key] ?? target.placeholder ?? '')}`;
    void nodeId;
    return {
      status: 'done' as NodeRunStatus,
      message: `${def.connector.name}: ${def.name}${targetText}`,
      ...(rendered.length > 0 ? { detail: rendered } : {}),
      nextHandles: 'all' as const,
    };
  }
}

/* ------------------------------------------------------------------ */

/**
 * The payload a test run of this workflow would start with, for the "Run with
 * my own payload" editor. Consumes the seeded generator in the same order as
 * simulateRun, so an unedited payload replays the same run.
 */
export function samplePayload(workflow: Workflow): Record<string, unknown> {
  const rng = mulberry32(hash(workflow.id + workflow.updatedAt));
  rng();
  const trigger = workflow.nodes.find((node) => getNodeType(node.data.typeId)?.kind === 'trigger');
  return buildPayload(trigger === undefined ? undefined : getNodeType(trigger.data.typeId), rng);
}

function buildPayload(def: NodeTypeDef | undefined, rng: () => number): Record<string, unknown> {
  const titles = [
    'Fix the flaky timeout in the retry test',
    'Export button crashes on Safari 18',
    'Add rate limiting to the webhook receiver',
    'Migrate settings page to the new form primitives',
    'Paginate the audit log endpoint',
    'Cache the issue list for 60 seconds',
  ];
  const base: Record<string, unknown> = {
    id: `ENG-${100 + Math.floor(rng() * 900)}`,
    title: titles[Math.floor(rng() * titles.length)],
    url: 'https://linear.app/acme/issue/ENG-142',
    assignee: 'you',
    author: 'you',
    labels: rng() > 0.5 ? ['bug', 'agent:go'] : ['feature', 'agent:go'],
    body: 'Steps to reproduce are in the thread. Expected: no crash. Actual: crash on second click.',
    priority: ['urgent', 'high', 'medium', 'low'][Math.floor(rng() * 4)],
  };
  const sample = def?.sample ?? {};
  const merged = { ...base, ...sample };
  merged['key'] = merged['id'];
  return merged;
}

function defaults(def: NodeTypeDef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of def.fields) if (field.default !== undefined) out[field.key] = field.default;
  return out;
}

function evaluate(left: string, op: string, right: string): boolean {
  const l = left.toLowerCase();
  const r = right.toLowerCase();
  switch (op) {
    case 'contains':
      return l.includes(r);
    case 'equals':
      return l === r;
    case 'not-equals':
      return l !== r;
    case 'gt':
      return Number(left) > Number(right);
    case 'lt':
      return Number(left) < Number(right);
    case 'matches':
      try {
        return new RegExp(right, 'i').test(left);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

function phaseDetail(phase: string, agent: string | undefined, rng: () => number): string {
  const who = agent === undefined ? '' : AGENT_NAMES[agent] ?? agent;
  switch (phase) {
    case 'FETCHING_ISSUE':
      return 'Issue body, comments and linked PRs pulled through the tracker CLI.';
    case 'CREATING_WORKSPACE':
      return 'git worktree add on a fresh branch from the base. Nothing touches your checkout.';
    case 'PLANNING':
      return `${who} read the codebase and wrote plan.md with ${3 + Math.floor(rng() * 4)} steps.`;
    case 'REVIEWING_PLAN':
      return `${who} attacked the plan against the real code: ${Math.floor(rng() * 3)} blocking, ${1 + Math.floor(rng() * 3)} advisory findings.`;
    case 'REVISING_PLAN':
      return `${who} answered every finding: ACCEPT / REJECT with reasons.`;
    case 'IMPLEMENTING':
      return `${who} implemented inside the worktree. Diff computed from git.`;
    case 'REVIEWING_CODE':
      return `${who} read the diff read-only under the OS sandbox. ${Math.floor(rng() * 2)} blocking findings.`;
    case 'REVISING_CODE':
      return `${who} addressed the blocking findings only.`;
    case 'TESTING':
      return 'The project’s own test command, judged by exit code.';
    default:
      return '';
  }
}

function samplePlan(title: string): string {
  return `# Plan: ${title}\n\n1. Reproduce with a failing test.\n2. Isolate the timing dependency behind an injected clock.\n3. Make the retry schedule deterministic in tests.\n4. Run the suite twice to confirm stability.\n\nRisks: the clock seam touches two call sites; both are covered by existing tests.`;
}

function summarize(run: Run, context: Record<string, unknown>): string {
  const issue = context.issue as Record<string, unknown>;
  const parts = [`${run.workflowName} · ${String(issue['id'] ?? '')} ${String(issue['title'] ?? '')}`.trim()];
  if (run.phases.length > 0) parts.push(`${run.phases.length} phases in ${formatMs(run.phases.reduce((sum, phase) => sum + phase.ms, 0))}`);
  if (run.diff !== undefined) parts.push(`+${run.diff.additions} −${run.diff.deletions} across ${run.diff.files} files`);
  if (run.tests !== undefined) parts.push(`tests ${run.tests.passed ? 'passed' : 'failed'}`);
  if (run.costUsd > 0) parts.push(usd(run.costUsd));
  if (run.prUrl !== undefined) parts.push(run.prUrl);
  return parts.join(' · ');
}

function lines(value: unknown): string[] {
  return String(value ?? '')
    .split(/[\n,]/)
    .map((s) => s.trim().replace(/^@/, ''))
    .filter(Boolean);
}

export function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
