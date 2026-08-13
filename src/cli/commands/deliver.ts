import { resolveRun } from '../../storage/runs.ts';
import { RelayError } from '../../util/errors.ts';
import { isTerminal, phaseLabel } from '../../workflow/phases.ts';
import { createCliContext } from '../context.ts';
import { deliverRun, parseDeliver } from './run.ts';

export interface DeliverOptions {
  /** `--to <policy>`: how far to take it, overriding the run's own setting. */
  to?: string;
  json?: boolean;
}

/**
 * Runs a finished run's delivery again.
 *
 * A run delivers its own work, so this is for the times that could not finish:
 * `gh` was missing when the run ended, the push was rejected, or the repository
 * was set to `branch` then and should be `pr` now. Delivery is idempotent —
 * steps already done are recorded as done and skipped — so re-running it picks
 * up exactly where the run left off rather than starting over.
 */
export async function deliverCommand(runRef: string, options: DeliverOptions = {}): Promise<number> {
  const cli = await createCliContext();
  const state = await resolveRun(cli.repo.root, runRef);

  // Committing a worktree an agent is still writing to would capture a diff
  // nobody reviewed, half-finished, under the run's own name.
  if (!isTerminal(state.phase)) {
    throw new RelayError(`Run ${state.runId} is still running (${phaseLabel(state.phase)}).`, {
      code: 'RUN_IN_PROGRESS',
      hint: `Watch it with \`relay watch ${state.runId}\`, or stop it with \`relay stop ${state.runId}\`.`,
    });
  }

  return deliverRun(state, {
    cli,
    ...(options.to === undefined ? {} : { policy: parseDeliver(options.to) }),
    ...(options.json === true ? { json: true } : {}),
  });
}
