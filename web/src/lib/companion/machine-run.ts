/**
 * A run on the paired machine, told in the studio's terms.
 *
 * The companion relays `relay run --json` line for line. This file folds that
 * stream into the same `Run` record a test run produces, so the canvas, the run
 * panel and the Runs pages show a real run exactly the way they show a
 * simulated one — except that every number here was measured.
 *
 * What runs on the machine is the pipeline and its delivery, with this
 * workflow's settings. The trigger is the person who pressed the button, and
 * the guardrails in front of the pipeline exist to decide whether an *event*
 * may start a run, so they have nothing to decide here; the actions after it
 * run in the exported workflow. Those nodes are marked skipped, and the run
 * says why once rather than pretending to have run them.
 */
import { getNodeType } from '../connectors';
import type { NodeRunStatus, Run, RunEvent, RunPhase, RunStatus, Workflow } from '../workflow/schema';
import type { RunStreamRecord, RunTask } from './types';

const PIPELINE_IDS = new Set(['pipeline.action.run', 'pipeline.action.fast']);
const DELIVERY_ID = 'delivery.action.deliver';
const COMMENT_ID = 'delivery.action.comment-summary';

type Role = 'planner' | 'planReviewer' | 'implementer' | 'codeReviewer';

const PHASE_ROLE: Partial<Record<string, Role>> = {
  PLANNING: 'planner',
  REVIEWING_PLAN: 'planReviewer',
  REVISING_PLAN: 'planner',
  IMPLEMENTING: 'implementer',
  REVIEWING_CODE: 'codeReviewer',
  REVISING_CODE: 'implementer',
};

const AGENT_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', aider: 'Aider' };

/** The engine's exit codes, from docs/cli.md. */
const EXIT = { success: 0, error: 1, preconditions: 3, unlanded: 4, checksFailed: 5, cancelled: 130 } as const;

export interface MachineRunNodes {
  trigger?: string;
  pipeline?: string;
  delivery?: string;
  comment?: string;
}

export function machineRunNodes(workflow: Workflow): MachineRunNodes {
  const nodes: MachineRunNodes = {};
  for (const node of workflow.nodes) {
    const def = getNodeType(node.data.typeId);
    if (def === undefined) continue;
    if (def.kind === 'trigger' && nodes.trigger === undefined) nodes.trigger = node.id;
    else if (PIPELINE_IDS.has(def.id) && nodes.pipeline === undefined) nodes.pipeline = node.id;
    else if (def.id === DELIVERY_ID && nodes.delivery === undefined) nodes.delivery = node.id;
    else if (def.id === COMMENT_ID && nodes.comment === undefined) nodes.comment = node.id;
  }
  return nodes;
}

export function taskLabel(task: RunTask): string {
  if (task.kind === 'issue') return /^\d+$/.test(task.ref) ? `Issue #${task.ref}` : task.ref;
  const first = task.text.split('\n')[0]?.trim() ?? '';
  return first.length > 80 ? `${first.slice(0, 77)}…` : first;
}

export interface MachineRunStart {
  id: string;
  companionRunId: string;
  host: string;
  repository: string | null;
  task: RunTask;
  startedAt: string;
}

/** The record a machine run starts as: the trigger fired, the pipeline waiting for the engine. */
export function createMachineRun(workflow: Workflow, start: MachineRunStart): Run {
  const nodes = machineRunNodes(workflow);
  const triggerDef = nodes.trigger === undefined ? undefined : getNodeType(workflow.nodes.find((node) => node.id === nodes.trigger)!.data.typeId);
  const tracked = new Set([nodes.trigger, nodes.pipeline, nodes.delivery, nodes.comment].filter((id): id is string => id !== undefined));
  const nodeStatus: Record<string, NodeRunStatus> = {};
  for (const node of workflow.nodes) nodeStatus[node.id] = node.id === nodes.trigger ? 'done' : tracked.has(node.id) ? 'pending' : 'skipped';

  const label = taskLabel(start.task);
  const events: RunEvent[] = [];
  if (nodes.trigger !== undefined) {
    events.push({ at: start.startedAt, nodeId: nodes.trigger, kind: 'node-finished', status: 'done', message: `Started by you on ${start.host}: ${label}` });
  }
  const passedOver = workflow.nodes.filter((node) => !tracked.has(node.id)).length;
  if (passedOver > 0) {
    events.push({
      at: start.startedAt,
      nodeId: null,
      kind: 'log',
      message: `${passedOver} node${passedOver === 1 ? '' : 's'} not run here.`,
      detail:
        'A run you start from the studio goes straight to the agent pipeline. The guardrails in front of it decide whether an event may start a run, so a person pressing the button passes over them, and the actions after delivery run in the exported workflow. The per-run cost cap still applies, and delivery stops at a pull request.',
    });
  }

  return {
    id: start.id,
    shortId: start.id.slice(-6),
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: 'running',
    startedAt: start.startedAt,
    trigger: {
      typeId: triggerDef?.id ?? 'none',
      connectorId: triggerDef?.connectorId ?? 'none',
      label: `You, on ${start.host}`,
      payload: start.task.kind === 'issue' ? { id: start.task.ref, title: label } : { title: label, body: start.task.text },
    },
    events,
    nodeStatus,
    phases: [],
    costUsd: 0,
    source: 'machine',
    machine: { host: start.host, repository: start.repository, companionRunId: start.companionRunId, runId: null, task: start.task },
  };
}

/* ------------------------------------------------------------------ */

interface RunJsonLike {
  runId?: string;
  phase?: string;
  branch?: string | null;
  issue?: { title?: string; url?: string } | null;
  diff?: { fileCount?: number; additions?: number; deletions?: number } | null;
  tests?: { command?: string[]; passed?: boolean; durationMs?: number; discovered?: boolean; skippedReason?: string | null } | null;
  commit?: { sha?: string; branch?: string } | null;
  push?: { remote?: string; branch?: string } | null;
  pullRequest?: { url?: string; number?: number | null } | null;
  delivery?: {
    policy?: string;
    reached?: string;
    steps?: Array<{ step?: string; status?: string; detail?: string }>;
    comment?: { status?: string; detail?: string; url?: string };
  } | null;
  usage?: { total?: { costUsd?: number | null }; byPhase?: Record<string, { costUsd?: number | null }> } | null;
  stopped?: { reason?: string; detail?: string } | null;
  error?: { message?: string } | null;
}

/** Applies the companion's records to a run, in order. Mutates the run it was given. */
export class MachineRunFold {
  readonly run: Run;
  private readonly nodes: MachineRunNodes;
  private readonly fast: boolean;
  private agents: Record<string, string> = {};
  private summarized = false;
  private done = false;
  /** Where the pipeline's last event sits once delivery has begun, so late pipeline facts land inside its group. */
  private pipelineEnd: number | null = null;

  constructor(run: Run, workflow: Workflow) {
    this.run = run;
    this.nodes = machineRunNodes(workflow);
    const pipeline = workflow.nodes.find((node) => node.id === this.nodes.pipeline);
    this.fast = pipeline?.data.typeId === 'pipeline.action.fast';
  }

  get finished(): boolean {
    return this.done;
  }

  apply(record: RunStreamRecord): RunEvent[] {
    if (this.done || record.type === 'ping') return [];
    if (record.type === 'exit') return this.exit(record.code, record.error);
    const data = record.data;
    const at = typeof data['at'] === 'string' && !Number.isNaN(Date.parse(data['at'])) ? data['at'] : new Date().toISOString();
    switch (data['type']) {
      case 'run_started':
        return this.started(at, data);
      case 'phase_started':
        return this.phaseStarted(at, String(data['phase'] ?? ''), String(data['phaseLabel'] ?? data['phase'] ?? ''), typeof data['detail'] === 'string' ? data['detail'] : null);
      case 'phase_completed':
        return this.phaseCompleted(at, String(data['phase'] ?? ''), String(data['phaseLabel'] ?? data['phase'] ?? ''), Number(data['durationMs'] ?? 0), data['status'] === 'failed' ? 'failed' : 'done');
      case 'note':
      case 'warning':
        // Once delivery has begun, what the engine says is about delivery: the secret scan, the push.
        return [this.emit({ at, nodeId: this.pipelineEnd === null ? (this.nodes.pipeline ?? null) : (this.nodes.delivery ?? this.nodes.pipeline ?? null), kind: 'log', message: String(data['message'] ?? '') })];
      case 'summary':
        return this.summary(at, Number(data['exitCode'] ?? EXIT.error), (data['run'] ?? {}) as RunJsonLike);
      default:
        return [];
    }
  }

  /* ---------------------------------------------------------------- */

  private emit(event: RunEvent): RunEvent {
    this.run.events.push(event);
    return event;
  }

  /**
   * A fact about the pipeline that only the summary knows — its cost, its
   * diff — placed with the pipeline's other events rather than after delivery,
   * so the timeline reads as one pipeline group followed by one delivery group.
   */
  private emitForPipeline(event: RunEvent): RunEvent {
    if (this.pipelineEnd === null) return this.emit(event);
    const placed = { ...event, at: this.run.events[this.pipelineEnd]?.at ?? event.at };
    this.run.events.splice(this.pipelineEnd, 0, placed);
    this.pipelineEnd += 1;
    return placed;
  }

  private setNode(nodeId: string | undefined, status: NodeRunStatus): void {
    if (nodeId !== undefined) this.run.nodeStatus[nodeId] = status;
  }

  private started(at: string, data: Record<string, unknown>): RunEvent[] {
    const runId = typeof data['runId'] === 'string' ? data['runId'] : null;
    if (this.run.machine !== undefined) this.run.machine.runId = runId;
    if (data['agents'] !== null && typeof data['agents'] === 'object') this.agents = data['agents'] as Record<string, string>;
    this.setNode(this.nodes.pipeline, 'running');
    return [this.emit({ at, nodeId: this.nodes.pipeline ?? null, kind: 'node-started', status: 'running', message: `${this.fast ? 'Fast run' : 'Agent pipeline'} started${runId === null ? '' : ` · ${runId}`}` })];
  }

  private agentFor(phase: string): string | undefined {
    const role = PHASE_ROLE[phase];
    const provider = role === undefined ? undefined : this.agents[role];
    return provider === undefined ? undefined : (AGENT_NAMES[provider] ?? provider);
  }

  private phaseStarted(at: string, phase: string, label: string, detail: string | null): RunEvent[] {
    if (phase === 'DELIVERING') {
      const events: RunEvent[] = [];
      if (this.run.nodeStatus[this.nodes.pipeline ?? ''] === 'running') {
        this.setNode(this.nodes.pipeline, 'done');
        events.push(this.emit({ at, nodeId: this.nodes.pipeline ?? null, kind: 'node-finished', status: 'done', message: 'Pipeline finished; delivering.' }));
      }
      this.pipelineEnd = this.run.events.length - 1;
      if (this.nodes.delivery !== undefined) {
        this.setNode(this.nodes.delivery, 'running');
        events.push(this.emit({ at, nodeId: this.nodes.delivery, kind: 'node-started', status: 'running', message: 'Delivering the change' }));
      }
      return events;
    }
    const agent = this.agentFor(phase);
    return [this.emit({ at, nodeId: this.nodes.pipeline ?? null, kind: 'phase', phase, status: 'running', message: [label, agent, detail].filter(Boolean).join(' · ') })];
  }

  private phaseCompleted(at: string, phase: string, label: string, ms: number, status: 'done' | 'failed'): RunEvent[] {
    const agent = this.agentFor(phase);
    this.run.phases.push({ phase, label, ms: Math.max(0, Math.round(ms)), status, ...(agent === undefined ? {} : { agent }) });
    const nodeId = phase === 'DELIVERING' ? (this.nodes.delivery ?? this.nodes.pipeline ?? null) : (this.nodes.pipeline ?? null);
    return [this.emit({ at, nodeId, kind: 'phase', phase, status, message: `${label} · ${formatMs(ms)}`, durationMs: Math.round(ms) })];
  }

  private summary(at: string, exitCode: number, json: RunJsonLike): RunEvent[] {
    this.summarized = true;
    const events: RunEvent[] = [];
    const run = this.run;
    if (run.machine !== undefined) {
      run.machine.exitCode = exitCode;
      if (typeof json.runId === 'string') run.machine.runId = json.runId;
    }

    // Measured, not played back: every number below comes from the engine's own record.
    const byPhase = json.usage?.byPhase ?? {};
    run.phases = run.phases.map((phase): RunPhase => {
      const cost = byPhase[phase.phase]?.costUsd;
      return typeof cost === 'number' ? { ...phase, costUsd: round(cost) } : phase;
    });
    const total = json.usage?.total?.costUsd;
    run.costUsd = typeof total === 'number' ? round(total) : 0;
    if (typeof total === 'number' && total > 0) events.push(this.emitForPipeline({ at, nodeId: this.nodes.pipeline ?? null, kind: 'cost', message: `Reported by the coding CLIs: ${usd(total)}`, costUsd: round(total) }));
    else if (total === null) events.push(this.emitForPipeline({ at, nodeId: this.nodes.pipeline ?? null, kind: 'cost', message: 'No price reported: Codex publishes token counts, not costs.' }));

    if (json.diff !== null && json.diff !== undefined) {
      run.diff = { files: json.diff.fileCount ?? 0, additions: json.diff.additions ?? 0, deletions: json.diff.deletions ?? 0 };
      events.push(this.emitForPipeline({ at, nodeId: this.nodes.pipeline ?? null, kind: 'artifact', message: `Diff: +${run.diff.additions} −${run.diff.deletions} across ${run.diff.files} files`, detail: 'Computed from git, not from what the agent said it did.' }));
    }
    if (json.tests !== null && json.tests !== undefined && json.tests.discovered !== false && json.tests.skippedReason == null) {
      run.tests = { passed: json.tests.passed === true, command: (json.tests.command ?? []).join(' '), durationMs: json.tests.durationMs ?? 0 };
    }
    if (typeof json.branch === 'string') run.branch = json.branch;
    else if (typeof json.commit?.branch === 'string') run.branch = json.commit.branch;
    if (typeof json.pullRequest?.url === 'string') run.prUrl = json.pullRequest.url;
    if (typeof json.issue?.title === 'string' && json.issue.title.length > 0) {
      run.trigger.payload = { ...run.trigger.payload, title: json.issue.title, ...(json.issue.url === undefined ? {} : { url: json.issue.url }) };
    }

    const status = statusFor(exitCode);
    const pipelineStatus: NodeRunStatus = status === 'cancelled' ? 'skipped' : exitCode === EXIT.success || exitCode === EXIT.unlanded ? 'done' : 'failed';
    if (this.run.nodeStatus[this.nodes.pipeline ?? ''] === 'running' || this.run.nodeStatus[this.nodes.pipeline ?? ''] === 'pending') {
      this.setNode(this.nodes.pipeline, pipelineStatus);
      events.push(this.emit({ at, nodeId: this.nodes.pipeline ?? null, kind: 'node-finished', status: pipelineStatus, message: pipelineMessage(exitCode, json) }));
    }

    if (this.nodes.delivery !== undefined) {
      const delivery = json.delivery;
      if (delivery === null || delivery === undefined) {
        this.setNode(this.nodes.delivery, 'skipped');
        events.push(this.emit({ at, nodeId: this.nodes.delivery, kind: 'node-finished', status: 'skipped', message: 'Nothing delivered: a run that does not finish never publishes.' }));
      } else {
        const steps = (delivery.steps ?? []).filter((step) => step.status !== 'skipped').map((step) => `${stepLabel(step.step)}${step.status === 'failed' ? ' failed' : ''}`);
        const message = steps.length === 0 ? `Delivered as far as "${delivery.reached ?? 'none'}"` : steps.join(' · ');
        this.setNode(this.nodes.delivery, 'done');
        events.push(this.emit({ at, nodeId: this.nodes.delivery, kind: 'node-finished', status: 'done', message, ...(run.prUrl === undefined ? {} : { detail: run.prUrl }) }));
        if (run.prUrl !== undefined) events.push(this.emit({ at, nodeId: this.nodes.delivery, kind: 'artifact', message: `Pull request #${json.pullRequest?.number ?? run.prUrl.split('/').pop()}`, detail: run.prUrl }));
      }
    }

    if (this.nodes.comment !== undefined) {
      const comment = json.delivery?.comment;
      const commentStatus: NodeRunStatus = comment?.status === 'done' ? 'done' : comment?.status === 'failed' ? 'failed' : 'skipped';
      this.setNode(this.nodes.comment, commentStatus);
      events.push(this.emit({ at, nodeId: this.nodes.comment, kind: 'node-finished', status: commentStatus, message: comment?.detail ?? 'No comment: the task was not a tracker issue, or the repository has comments off.', ...(comment?.url === undefined ? {} : { detail: comment.url }) }));
    }
    return events;
  }

  private exit(code: number | null, error: string | null): RunEvent[] {
    this.done = true;
    const at = new Date().toISOString();
    const events: RunEvent[] = [];
    const status: RunStatus = this.summarized ? statusFor(this.run.machine?.exitCode ?? code ?? EXIT.error) : code === EXIT.cancelled || code === null ? (error === null ? 'cancelled' : 'failed') : 'failed';

    if (!this.summarized) {
      // The engine stopped before it had a run to summarize: usually a
      // precondition — a CLI not signed in, an issue that does not exist.
      if (this.run.machine !== undefined) this.run.machine.exitCode = code;
      for (const [nodeId, value] of Object.entries(this.run.nodeStatus)) {
        if (value === 'running') this.run.nodeStatus[nodeId] = status === 'cancelled' ? 'skipped' : 'failed';
      }
      if (this.nodes.pipeline !== undefined && this.run.nodeStatus[this.nodes.pipeline] === 'pending') {
        this.run.nodeStatus[this.nodes.pipeline] = 'failed';
        events.push(this.emit({ at, nodeId: this.nodes.pipeline, kind: 'node-finished', status: 'failed', message: error ?? `Relay exited with code ${code ?? 'unknown'} before the run began.` }));
      } else if (error !== null) {
        events.push(this.emit({ at, nodeId: this.nodes.pipeline ?? null, kind: 'log', message: error }));
      }
    }
    for (const [nodeId, value] of Object.entries(this.run.nodeStatus)) if (value === 'pending') this.run.nodeStatus[nodeId] = 'skipped';

    this.run.status = status;
    this.run.finishedAt = at;
    this.run.summary = summarize(this.run, error);
    events.push(this.emit({ at, nodeId: null, kind: 'run-finished', message: `Run ${status}.`, detail: this.run.summary }));
    return events;
  }
}

/** Marks a run whose stream ended with no word from the engine: the companion went away. */
export function markLost(run: Run, why: string): Run {
  const at = new Date().toISOString();
  for (const [nodeId, value] of Object.entries(run.nodeStatus)) if (value === 'running' || value === 'pending') run.nodeStatus[nodeId] = 'skipped';
  run.status = 'cancelled';
  run.finishedAt = at;
  const where = run.machine?.runId === null || run.machine?.runId === undefined ? '' : ` Check it there: relay status ${run.machine.runId}`;
  run.summary = `${why}${where}`;
  run.events.push({ at, nodeId: null, kind: 'run-finished', message: 'Lost track of the run.', detail: run.summary });
  return run;
}

function statusFor(exitCode: number): RunStatus {
  if (exitCode === EXIT.success || exitCode === EXIT.unlanded) return 'succeeded';
  if (exitCode === EXIT.cancelled) return 'cancelled';
  return 'failed';
}

function pipelineMessage(exitCode: number, json: RunJsonLike): string {
  if (json.stopped?.reason === 'budget') return `Stopped: over the per-run budget. ${json.stopped.detail ?? ''}`.trim();
  if (exitCode === EXIT.cancelled) return 'Stopped by you. Work so far is committed to the run branch.';
  if (exitCode === EXIT.checksFailed) return 'Finished, and the verdict is no: tests failed or blocking findings were never resolved.';
  if (exitCode === EXIT.unlanded) return 'Finished; the work is committed nowhere yet.';
  if (exitCode !== EXIT.success) return json.error?.message ?? `Relay exited with code ${exitCode}.`;
  const parts = ['Finished'];
  if (json.tests?.passed === true) parts.push('tests passed');
  if (json.diff !== null && json.diff !== undefined) parts.push(`+${json.diff.additions ?? 0} −${json.diff.deletions ?? 0}`);
  return parts.join(' · ');
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

function summarize(run: Run, error: string | null): string {
  const parts = [`${run.workflowName} · ${String(run.trigger.payload['title'] ?? '')}`.trim()];
  if (run.machine !== undefined) parts.push(`on ${run.machine.host}`);
  if (run.phases.length > 0) parts.push(`${run.phases.length} phases in ${formatMs(run.phases.reduce((sum, phase) => sum + phase.ms, 0))}`);
  if (run.diff !== undefined) parts.push(`+${run.diff.additions} −${run.diff.deletions} across ${run.diff.files} files`);
  if (run.tests !== undefined) parts.push(`tests ${run.tests.passed ? 'passed' : 'failed'}`);
  if (run.costUsd > 0) parts.push(usd(run.costUsd));
  if (run.prUrl !== undefined) parts.push(run.prUrl);
  if (run.status !== 'succeeded' && error !== null) parts.push(error.split('\n')[0] ?? error);
  return parts.join(' · ');
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
