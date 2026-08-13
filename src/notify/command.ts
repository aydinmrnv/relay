import { runProcess } from '../process/runner.ts';
import type { RunState } from '../workflow/state.ts';

export function completionArgs(template: readonly string[], state: RunState): string[] {
  const values = { '{{runId}}': state.runId, '{{outcome}}': state.phase.toLowerCase(), '{{url}}': state.pullRequest?.url ?? state.issue?.url ?? '' };
  return template.map((part) => Object.entries(values).reduce((value, [token, replacement]) => value.replaceAll(token, replacement), part));
}

export async function notifyCommand(template: readonly string[], state: RunState, run: typeof runProcess = runProcess): Promise<void> {
  const [command, ...args] = completionArgs(template, state);
  if (command === undefined || command.length === 0) throw new Error('notification command executable is empty');
  const result = await run(command, args);
  if (!result.ok) throw new Error(`notification command exited ${result.exitCode ?? result.signal ?? 'unknown'}`);
}
