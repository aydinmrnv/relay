'use client';

import { useStudio } from './store';
import { simulateRun, type SimulateOptions } from './workflow/simulate';
import { compileWorkflow } from './workflow/compile';
import type { Run, RunEvent, Workflow } from './workflow/schema';
import { CompanionError, companionFetch, companionRequest, useCompanion } from './companion/client';
import { createMachineRun, markLost, MachineRunFold } from './companion/machine-run';
import { repositoryLabel, type CompanionRunView, type RunStreamRecord, type RunTask } from './companion/types';

/**
 * Starts a run from anywhere — the builder, the workflows list, a run's
 * "Run again" button — and records it in the store as it goes, so every
 * screen that lists runs sees it move. The builder passes `onEvent` to light
 * up its canvas; other callers just await the result.
 *
 * Two kinds: a test run, played back in this tab for free, and a run on the
 * paired machine, which `relay connect` performs for real and streams back.
 */

/** Test runs this tab is playing, by run id. */
const controllers = new Map<string, AbortController>();
/** Machine runs this tab is following, by run id → the companion's handle. */
const following = new Map<string, string>();

export interface LaunchOptions {
  payload?: Record<string, unknown>;
  seed?: number;
  speed?: SimulateOptions['speed'];
  onEvent?: (event: RunEvent, run: Run) => void;
}

function snapshot(run: Run): Run {
  return {
    ...run,
    events: [...run.events],
    nodeStatus: { ...run.nodeStatus },
    phases: [...run.phases],
    trigger: { ...run.trigger },
    ...(run.machine === undefined ? {} : { machine: { ...run.machine } }),
  };
}

export async function launchRun(workflow: Workflow, options: LaunchOptions = {}): Promise<Run> {
  const state = useStudio.getState();
  const controller = new AbortController();
  let recorded: string | null = null;

  const result = await simulateRun(workflow, {
    speed: options.speed ?? state.settings.simulationSpeed,
    brand: state.brand,
    repository: workflow.repository,
    signal: controller.signal,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    onEvent: (event, live) => {
      const copy = snapshot(live);
      if (recorded === null) {
        recorded = live.id;
        controllers.set(live.id, controller);
        useStudio.getState().addRun({ ...copy, source: 'simulated' });
      } else {
        useStudio.getState().updateRun({ ...copy, source: 'simulated' });
      }
      options.onEvent?.(event, copy);
    },
  });

  const final = { ...snapshot(result), source: 'simulated' as const };
  useStudio.getState().updateRun(final);
  controllers.delete(result.id);
  return final;
}

/* ------------------------------------------------------------------ */
/* Runs on the paired machine                                          */
/* ------------------------------------------------------------------ */

/** The `.relay/config.json` the export would write for this workflow: what the machine's run is shaped by. */
export function compiledConfig(workflow: Workflow): Record<string, unknown> {
  const state = useStudio.getState();
  const compiled = compileWorkflow(workflow, state.brand, { auth: state.settings.auth });
  const file = compiled.files.find((entry) => entry.path === '.relay/config.json');
  if (file === undefined) throw new Error('The compiler produced no config.');
  return JSON.parse(file.content) as Record<string, unknown>;
}

/**
 * Runs the workflow's pipeline for real on the paired machine, in the
 * repository `relay connect` was started in, and follows it to the end.
 */
export async function launchMachineRun(workflow: Workflow, task: RunTask, options: Pick<LaunchOptions, 'onEvent'> = {}): Promise<Run> {
  const hello = useCompanion.getState().hello;
  const view = await companionFetch<CompanionRunView>('/v1/runs', {
    method: 'POST',
    body: { workflow: { id: workflow.id, name: workflow.name }, config: compiledConfig(workflow), task },
  });
  const run = createMachineRun(workflow, {
    id: `run_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    companionRunId: view.id,
    host: hello?.machine ?? 'your machine',
    repository: repositoryLabel(hello?.repository),
    task,
    startedAt: view.startedAt,
  });
  const first = snapshot(run);
  useStudio.getState().addRun(first);
  for (const event of first.events) options.onEvent?.(event, first);
  return follow(run, workflow, options.onEvent);
}

/**
 * Picks a machine run back up after a reload. The companion replays every
 * line from the first, so the record is rebuilt rather than patched.
 */
export async function attachMachineRun(saved: Run): Promise<Run | undefined> {
  if (saved.machine === undefined || following.has(saved.id)) return undefined;
  const workflow = useStudio.getState().workflows[saved.workflowId];
  if (workflow === undefined) return undefined;
  const base = createMachineRun(workflow, {
    id: saved.id,
    companionRunId: saved.machine.companionRunId,
    host: saved.machine.host,
    repository: saved.machine.repository,
    task: saved.machine.task,
    startedAt: saved.startedAt,
  });
  return follow(base, workflow);
}

async function follow(run: Run, workflow: Workflow, onEvent?: (event: RunEvent, run: Run) => void): Promise<Run> {
  const companionRunId = run.machine!.companionRunId;
  following.set(run.id, companionRunId);
  const fold = new MachineRunFold(run, workflow);
  const publish = (events: RunEvent[]) => {
    if (events.length === 0) return;
    const copy = snapshot(fold.run);
    useStudio.getState().updateRun(copy);
    for (const event of events) onEvent?.(event, copy);
  };

  try {
    let response: Response;
    try {
      response = await companionRequest(`/v1/runs/${encodeURIComponent(companionRunId)}/events`);
    } catch (error) {
      if (error instanceof CompanionError) return lose(run, `${error.message}`);
      throw error;
    }
    if (response.status === 404) return lose(run, `${run.machine?.host ?? 'The machine'} no longer knows this run: \`relay connect\` was restarted while it was going.`);
    if (!response.ok || response.body === null) return lose(run, `The companion answered ${response.status}.`);

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) break;
      buffer += value ?? '';
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (line.length === 0) continue;
        let record: RunStreamRecord;
        try {
          record = JSON.parse(line) as RunStreamRecord;
        } catch {
          continue;
        }
        publish(fold.apply(record));
      }
    }
    if (!fold.finished) return lose(run, `Lost contact with ${run.machine?.host ?? 'the machine'} before the run finished. \`relay connect\` stopped or the connection dropped.`);
    return snapshot(fold.run);
  } finally {
    following.delete(run.id);
  }
}

function lose(run: Run, why: string): Run {
  const final = snapshot(markLost(run, why));
  useStudio.getState().updateRun(final);
  return final;
}

/* ------------------------------------------------------------------ */

/**
 * Stops a run this tab can reach. A test run stops at once; a machine run is
 * asked to stop the way Ctrl-C would, and says so when its stream ends.
 * Returns false when it is not ours to stop.
 */
export function cancelRun(runId: string): boolean {
  const controller = controllers.get(runId);
  if (controller !== undefined) {
    controller.abort();
    return true;
  }
  const companionRunId = following.get(runId);
  if (companionRunId !== undefined) {
    void companionFetch(`/v1/runs/${encodeURIComponent(companionRunId)}`, { method: 'DELETE' }).catch(() => undefined);
    return true;
  }
  return false;
}

export function canCancel(runId: string): boolean {
  return controllers.has(runId) || following.has(runId);
}
