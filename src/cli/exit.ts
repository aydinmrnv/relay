import { CommanderError } from 'commander';

import type { Landing } from '../git/commit.ts';
import { isRelayError } from '../util/errors.ts';
import { unresolvedBlockingFindings } from '../workflow/delivery.ts';
import type { RunState } from '../workflow/state.ts';

/**
 * What Relay's exit codes mean.
 *
 * A script that wraps Relay has to decide something from how a command ended,
 * and "non-zero" is not a decision. The two that carry their weight are 3 and
 * 5: *you are not set up* and *the work is not good enough* are different
 * answers needing different responses, and collapsing both into 1 makes a CI
 * job page a person for a missing `gh`.
 *
 * This table is the contract. It is documented in the README, and the tests
 * assert one invocation per code.
 */
export const EXIT = {
  /** The command did what it was asked. */
  success: 0,
  /** A Relay error — the message on stderr says which. */
  error: 1,
  /** Usage error: an unknown command, a missing argument, a bad flag. */
  usage: 2,
  /** Preconditions unmet: a missing CLI, a signed-out tool, not a repository. */
  preconditions: 3,
  /** The run finished, and its work is committed nowhere. */
  unlanded: 4,
  /** The run failed on its own terms: blocking findings unresolved, tests failed. */
  checksFailed: 5,
  /** Cancelled — Ctrl-C, `relay stop`, or an abandoned prompt. */
  cancelled: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * The failures that mean "this machine is not ready", rather than "this went
 * wrong". Each one is something `relay doctor` reports and a person fixes once,
 * which is exactly the distinction a caller needs to make before deciding
 * whether to retry, page someone, or install something.
 */
const PRECONDITION_CODES: ReadonlySet<string> = new Set([
  'NOT_A_REPOSITORY',
  'EMPTY_REPOSITORY',
  'EXECUTABLE_NOT_FOUND',
  'AGENT_UNAVAILABLE',
  'UNKNOWN_AGENT',
  'GH_NOT_INSTALLED',
  'GH_NOT_AUTHENTICATED',
]);

export function isCommanderError(error: unknown): error is CommanderError {
  return error instanceof CommanderError;
}

/**
 * The code a thrown failure exits with.
 *
 * Commander's own errors are usage errors, except the ones it throws to report
 * that it printed help or a version — those are a success that happens to
 * unwind through the same channel.
 */
export function exitCodeFor(error: unknown): ExitCode {
  if (isCommanderError(error)) return error.exitCode === 0 ? EXIT.success : EXIT.usage;
  if (isRelayError(error)) {
    if (error.code === 'PROMPT_CANCELLED') return EXIT.cancelled;
    if (PRECONDITION_CODES.has(error.code)) return EXIT.preconditions;
  }
  return EXIT.error;
}

/**
 * The code a finished run exits with.
 *
 * The order is the order a reader cares about. A run that reached a verdict and
 * the verdict is bad (5) is a different answer from a run that broke on the way
 * (1), and both are more urgent than work that came out fine but is sitting
 * uncommitted in a throwaway worktree (4) — which is itself worth saying,
 * because a `git worktree prune` is all it takes to lose it.
 */
export function exitCodeForRun(state: RunState, landing: Landing): ExitCode {
  if (state.phase === 'CANCELLED') return EXIT.cancelled;
  if (state.phase !== 'COMPLETE') {
    // A run that died mid-phase failed for a reason it already recorded, and
    // that reason is sometimes "the CLI is not installed" rather than a bug.
    const code = state.error?.code;
    return code !== undefined && PRECONDITION_CODES.has(code) ? EXIT.preconditions : EXIT.error;
  }

  if (runChecksFailed(state)) return EXIT.checksFailed;
  if (landing === 'unlanded') return EXIT.unlanded;
  // The run worked; a delivery step that broke did not. That distinction is
  // invisible to a script unless the exit code carries it.
  if (state.delivery?.steps.some((step) => step.status === 'failed') === true) return EXIT.error;
  return EXIT.success;
}

/**
 * Whether the run's own evidence condemns it. Deliberately narrower than the
 * gate on merging: a repository with no test suite has not failed its tests,
 * it simply has none, and exiting 5 for that would make the code meaningless.
 */
export function runChecksFailed(state: RunState): boolean {
  if (state.tests?.discovered === true && !state.tests.passed) return true;
  return unresolvedBlockingFindings(state) > 0;
}
