import type { TriggerRecord } from '../workflow/state.ts';

/**
 * How a parent process tells `relay run` that nobody started this run.
 *
 * `relay serve` creates its runs in its own process and stamps the trigger on
 * them directly. `relay workflow` starts the pipeline as a child — a run that
 * crashes takes itself down, not the workflow around it — so the fact has to
 * cross a process boundary, and it crosses in one environment variable.
 *
 * The variable can only make a run stricter. A run that carries a trigger is
 * capped at a draft pull request, reads only trusted comments, screens the
 * issue for injections and withholds secret-named variables from its agents;
 * there is nothing a caller could gain by setting it.
 */
export const RUN_TRIGGER_VARIABLE = 'RELAY_RUN_TRIGGER';

let adopted: TriggerRecord | undefined;

function parse(raw: string): TriggerRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const label = typeof record['label'] === 'string' ? record['label'].slice(0, 200) : '';
  const actor = typeof record['actor'] === 'string' && record['actor'].length > 0 ? record['actor'].slice(0, 100) : null;
  const at = typeof record['at'] === 'string' && !Number.isNaN(Date.parse(record['at'])) ? record['at'] : new Date().toISOString();
  return { source: 'workflow', label, actor, at };
}

/**
 * Takes `RELAY_RUN_TRIGGER` out of the environment and into this process.
 * Out, for the reason the config overlay is: everything a run spawns inherits
 * the environment, and a repository's test suite that runs Relay must not
 * inherit this run's trigger. A value that cannot be read still marks the run
 * unattended — the stricter reading of a garbled "nobody is here".
 */
export function adoptRunTrigger(env: NodeJS.ProcessEnv = process.env): void {
  const raw = env[RUN_TRIGGER_VARIABLE];
  delete env[RUN_TRIGGER_VARIABLE];
  if (raw === undefined || raw.length === 0) return;
  adopted = parse(raw) ?? { source: 'workflow', label: 'a workflow', actor: null, at: new Date().toISOString() };
}

/** The trigger this process was started with, when a workflow started it. */
export function adoptedRunTrigger(): TriggerRecord | undefined {
  return adopted;
}

/** For the tests, which run many invocations in one process. */
export function setRunTrigger(trigger: TriggerRecord | undefined): void {
  adopted = trigger;
}
