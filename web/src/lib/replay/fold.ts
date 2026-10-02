import { MachineRunFold, machineRunNodes } from '../companion/machine-run';
import { defaultConfig, getNodeType } from '../connectors';
import type { NodeRunStatus, Run, RunEvent, Workflow, WorkflowNode } from '../workflow/schema';
import { githubUrl } from './parse';
import type { Recording, RecordingLine } from './types';

/**
 * Plays a recording through the fold a live run goes through.
 *
 * `relay recording` rebuilt the run's `relay run --json` stream from disk;
 * this hands those lines, one at a time and in order, to `MachineRunFold`, the
 * same code that turns a run on a paired machine into what the canvas and the
 * timeline draw. Folding the first `n` lines gives the run as it stood at that
 * moment, which is all a scrubber needs: there is no second model of a run to
 * keep in step with the first.
 */

const TRIGGER = 'logic.trigger.manual';
const PIPELINE = 'pipeline.action.run';
const DELIVERY = 'delivery.action.deliver';
const AGENT_KEYS = ['planner', 'planReviewer', 'implementer', 'codeReviewer'] as const;

function node(id: string, typeId: string, column: number, config: Record<string, unknown>, label?: string): WorkflowNode | null {
  const def = getNodeType(typeId);
  if (def === undefined) return null;
  return { id, type: 'wf', position: { x: 80 + column * 340, y: 120 }, data: { typeId, config: { ...defaultConfig(def), ...config }, ...(label === undefined ? {} : { label }) } };
}

/**
 * The workflow a recording is drawn on: what ran, and nothing that did not.
 *
 * A run from a terminal has no canvas behind it, so this is the smallest
 * honest graph of it — a person started it, the pipeline ran with the agents
 * the run recorded, delivery took it as far as it went. A recording never
 * plays on a visitor's own workflow, whose guardrails and actions it never met.
 */
export function workflowForRecording(recording: Recording): Workflow {
  const { run } = recording;
  const agents: Record<string, unknown> = {};
  for (const key of AGENT_KEYS) if (typeof run.agents[key] === 'string') agents[key] = run.agents[key];
  if (run.reviewLevel !== null) agents['review'] = run.reviewLevel;
  const summary = recording.stream.find((line) => line.type === 'summary');
  const delivery = isRecord(summary?.['run']) && isRecord(summary['run']['delivery']) ? summary['run']['delivery'] : null;
  const policy = typeof delivery?.['policy'] === 'string' ? delivery['policy'] : undefined;

  const nodes = [
    node('rec_trigger', TRIGGER, 0, { prompt: taskTitle(recording) }),
    node('rec_pipeline', PIPELINE, 1, agents),
    node('rec_delivery', DELIVERY, 2, policy === undefined ? {} : { policy }),
  ].filter((entry): entry is WorkflowNode => entry !== null);
  const edges = nodes.slice(1).map((target, index) => ({ id: `rec_edge_${index}`, source: nodes[index]!.id, target: target.id }));
  const repository = run.repository.owner !== null && run.repository.name !== null ? `${run.repository.owner}/${run.repository.name}` : '';
  return {
    id: `rec_${run.shortId}`,
    name: taskTitle(recording),
    description: `A recording of run ${run.runId}.`,
    nodes,
    edges,
    enabled: false,
    createdAt: run.createdAt,
    updatedAt: run.createdAt,
    repository,
  };
}

/** What the run was asked to do, in a line. */
export function taskTitle(recording: Recording): string {
  const { run } = recording;
  if (run.issue !== null && run.issue.title.length > 0) return run.issue.title;
  const first = recording.artifacts.issue?.split('\n').find((line) => line.trim().length > 0);
  return first?.replace(/^#+\s*/, '').slice(0, 120) ?? run.issueRef;
}

/** The task, as the trigger's event reads: `Issue #23`, or the title of work that had no ticket. */
function taskLabel(recording: Recording): string {
  const { run } = recording;
  if (run.issue?.number != null) return `Issue #${run.issue.number}: ${run.issue.title}`;
  return taskTitle(recording);
}

function startingRun(recording: Recording, workflow: Workflow): Run {
  const { run } = recording;
  const nodes = machineRunNodes(workflow);
  const startedAt = recording.stream[0]?.at ?? run.createdAt;
  const repository = workflow.repository !== undefined && workflow.repository.length > 0 ? workflow.repository : null;
  const nodeStatus: Record<string, NodeRunStatus> = {};
  for (const entry of workflow.nodes) nodeStatus[entry.id] = entry.id === nodes.trigger ? 'done' : 'pending';
  const events: RunEvent[] = nodes.trigger === undefined ? [] : [{ at: startedAt, nodeId: nodes.trigger, kind: 'node-finished', status: 'done', message: `Started from a terminal: ${taskLabel(recording)}` }];
  return {
    id: `rec_${run.shortId}`,
    shortId: run.shortId,
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: 'running',
    startedAt,
    trigger: {
      typeId: TRIGGER,
      connectorId: 'logic',
      label: 'Started from a terminal',
      payload: { title: taskTitle(recording), ...(run.issue === null || run.issue.url.length === 0 ? {} : { url: run.issue.url }), ...(run.issue?.number == null ? {} : { id: String(run.issue.number) }) },
    },
    events,
    nodeStatus,
    phases: [],
    costUsd: 0,
    // Real, and measured: the same kind of run as one on a paired machine, seen afterwards.
    source: 'machine',
    machine: { host: repository ?? 'the machine it ran on', repository, companionRunId: '', runId: run.runId, task: run.issue?.number != null ? { kind: 'issue', ref: String(run.issue.number) } : { kind: 'prompt', text: taskTitle(recording) } },
  };
}

/**
 * The run as it stood once the first `count` lines of the recording had
 * happened. `count` past the end is the finished run. The same recording and
 * the same count always give the same run: the fold's clock is the recording's.
 */
export function foldRecording(recording: Recording, count: number = recording.stream.length, workflow: Workflow = workflowForRecording(recording)): Run {
  const run = startingRun(recording, workflow);
  const upTo = Math.max(0, Math.min(count, recording.stream.length));
  let clock = run.startedAt;
  const fold = new MachineRunFold(run, workflow, () => clock);
  for (let index = 0; index < upTo; index += 1) {
    const line = recording.stream[index]!;
    clock = line.at;
    fold.apply({ seq: index, type: 'engine', data: line.type === 'summary' ? safeSummary(line) : line });
  }
  if (upTo === recording.stream.length) {
    clock = recording.run.finishedAt ?? clock;
    fold.apply({ seq: upTo, type: 'exit', code: recording.exitCode, error: recording.run.error });
  }
  return run;
}

/**
 * The closing line with its addresses checked. The fold turns the pull request
 * and the comment into links, and a recording is a file from anywhere.
 */
function safeSummary(line: RecordingLine): RecordingLine {
  const run = isRecord(line['run']) ? { ...line['run'] } : {};
  const pullRequest = isRecord(run['pullRequest']) ? run['pullRequest'] : null;
  const url = pullRequest === null ? null : githubUrl(pullRequest['url'], 'pull');
  run['pullRequest'] = url === null ? null : { ...pullRequest, url };
  if (isRecord(run['issue'])) run['issue'] = { ...run['issue'], url: githubUrl(run['issue']['url'], 'issues') ?? undefined };
  if (isRecord(run['delivery']) && isRecord(run['delivery']['comment'])) {
    const { url: _unchecked, ...comment } = run['delivery']['comment'];
    void _unchecked;
    run['delivery'] = { ...run['delivery'], comment };
  }
  return { ...line, run };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/* ------------------------------------------------------------------ */
/* The scrubber                                                        */
/* ------------------------------------------------------------------ */

export interface ReplayStep {
  /** How many lines of the stream have happened once this step has. */
  count: number;
  at: string;
  /** Milliseconds since the run began. */
  offsetMs: number;
  /** The engine phase this step belongs to, when it belongs to one. */
  phase: string | null;
  label: string;
}

/**
 * The places a scrubber stops: the start, the end of each phase, and the end.
 * Phase boundaries rather than every line, because between them nothing a
 * reader would call progress has happened.
 */
export function replaySteps(recording: Recording): ReplayStep[] {
  const start = Date.parse(recording.stream[0]?.at ?? recording.run.createdAt);
  const offset = (at: string): number => Math.max(0, Date.parse(at) - start);
  const steps: ReplayStep[] = [{ count: 1, at: recording.stream[0]?.at ?? recording.run.createdAt, offsetMs: 0, phase: null, label: 'Started' }];
  recording.stream.forEach((line, index) => {
    if (line.type !== 'phase_completed') return;
    // A note that closes a phase is logged just before the boundary: take what follows up to the next phase.
    let count = index + 1;
    while (count < recording.stream.length && (recording.stream[count]!.type === 'note' || recording.stream[count]!.type === 'warning')) count += 1;
    steps.push({ count, at: line.at, offsetMs: offset(line.at), phase: String(line['phase'] ?? ''), label: String(line['phaseLabel'] ?? line['phase'] ?? 'Phase') });
  });
  const end = recording.run.finishedAt ?? recording.stream.at(-1)?.at ?? recording.run.createdAt;
  steps.push({ count: recording.stream.length, at: end, offsetMs: offset(end), phase: null, label: 'Finished' });
  // Two stops on the same line of the stream are one stop.
  return steps.filter((step, index) => index === 0 || step.count > steps[index - 1]!.count);
}

/** When each captured patch came to exist: the end of the implementation, then of each code revision. */
export function patchTimes(recording: Recording): Record<string, string> {
  const times: Record<string, string> = {};
  let revisions = 0;
  for (const line of recording.stream) {
    if (line.type !== 'phase_completed') continue;
    if (line['phase'] === 'IMPLEMENTING' && times['implementation'] === undefined) times['implementation'] = line.at;
    if (line['phase'] === 'REVISING_CODE') {
      revisions += 1;
      times[`revision-round-${revisions}`] = line.at;
    }
  }
  return times;
}

/** When the first plan was written, and when the tests finished: what unlocks the plan and the test log. */
export function phaseEndTimes(recording: Recording): { plan: string | null; tests: string | null } {
  const ended = (phase: string): string | null => recording.stream.find((line) => line.type === 'phase_completed' && line['phase'] === phase)?.at ?? null;
  return { plan: ended('PLANNING') ?? ended('IMPLEMENTING'), tests: ended('TESTING') };
}
