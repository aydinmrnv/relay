'use client';

import { useStudio } from './store';
import { simulateRun, type SimulateOptions } from './workflow/simulate';
import type { Run, RunEvent, Workflow } from './workflow/schema';

/**
 * Starts a test run from anywhere — the builder, the workflows list, a run's
 * "Run again" button — and records it in the store as it plays, so every
 * screen that lists runs sees it move. The builder passes `onEvent` to light
 * up its canvas; other callers just await the result.
 */

const controllers = new Map<string, AbortController>();

export interface LaunchOptions {
  payload?: Record<string, unknown>;
  seed?: number;
  speed?: SimulateOptions['speed'];
  onEvent?: (event: RunEvent, run: Run) => void;
}

function snapshot(run: Run): Run {
  return { ...run, events: [...run.events], nodeStatus: { ...run.nodeStatus }, phases: [...run.phases] };
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
        useStudio.getState().addRun(copy);
      } else {
        useStudio.getState().updateRun(copy);
      }
      options.onEvent?.(event, copy);
    },
  });

  const final = snapshot(result);
  useStudio.getState().updateRun(final);
  controllers.delete(result.id);
  return final;
}

/** Stops a run this tab started. Returns false when it is not ours to stop (already finished, or started before a reload). */
export function cancelRun(runId: string): boolean {
  const controller = controllers.get(runId);
  if (controller === undefined) return false;
  controller.abort();
  return true;
}

export function canCancel(runId: string): boolean {
  return controllers.has(runId);
}
