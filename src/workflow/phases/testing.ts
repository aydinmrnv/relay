import { relative } from 'node:path';

import { RelayError } from '../../util/errors.ts';
import { formatDuration } from '../../util/text.ts';
import { performTests, takeBackgroundTests } from '../backgroundTests.ts';
import type { EngineContext, PhaseResult } from '../context.ts';

/**
 * Records the project's own test result, if a command could be identified safely.
 *
 * By the time this phase runs the suite has usually already finished: it was
 * started against this exact diff when the implementation settled and ran
 * through the code review. This phase only has to wait for it, and falls back
 * to running it here when there was nothing in flight.
 *
 * A failing suite does not fail the run: the work still exists on the branch and
 * the user needs to see it. The result is recorded as evidence either way.
 */
export async function testing(context: EngineContext): Promise<PhaseResult> {
  const { state, store, observer, signal } = context;
  const workspace = state.workspace;
  if (workspace === undefined) throw new RelayError('No workspace for this run.', { code: 'NO_WORKSPACE' });

  const at = new Date().toISOString();

  if (!state.config.workflow.runTests) {
    state.tests = {
      discovered: false,
      command: [],
      reason: 'disabled',
      exitCode: null,
      passed: false,
      durationMs: 0,
      timedOut: false,
      skippedReason: 'tests are disabled in .relay/config.json (workflow.runTests = false)',
      at,
    };
    observer.note('Tests skipped: disabled in config.');
    return { next: 'COMPLETE', note: 'tests disabled' };
  }

  // Usually already finished: it was started against this diff the moment the
  // implementation settled, and has been running through the code review.
  const attempt = (await takeBackgroundTests(context)) ?? (await performTests(context, signal, false));
  const { discovery } = attempt;

  if (!discovery.found) {
    state.tests = {
      discovered: false,
      command: [],
      reason: discovery.reason,
      exitCode: null,
      passed: false,
      durationMs: 0,
      timedOut: false,
      skippedReason: discovery.reason,
      at,
    };
    observer.warn(`No test command was run: ${discovery.reason}.`);
    return { next: 'COMPLETE', note: 'no tests found' };
  }

  const printable = discovery.command.command.join(' ');
  const cwd = discovery.command.directory ?? workspace.path;
  const directory = relative(workspace.path, cwd);

  const execution = attempt.execution;
  if (execution === undefined) {
    // A command was found but produced no execution — only reachable if a run
    // in flight was torn down. Recorded, not thrown: the phase reports test
    // evidence, and "none" is a report the user can act on.
    state.tests = {
      discovered: false,
      command: discovery.command.command,
      reason: discovery.command.reason,
      exitCode: null,
      passed: false,
      durationMs: 0,
      timedOut: false,
      skippedReason: `the suite was discovered but did not run: ${printable}`,
      at,
    };
    observer.warn(`No test result: ${printable} was discovered but never completed.`);
    return { next: 'COMPLETE', note: 'tests did not run' };
  }

  observer.note(
    attempt.concurrent
      ? `Tests ran alongside the code review: ${printable}  (${discovery.command.reason})`
      : `Ran tests: ${printable}  (${discovery.command.reason})`,
  );

  const outputFile = await store.saveTestOutput(
    'test-run',
    [
      `$ ${printable}`,
      `directory: ${directory.length === 0 ? '.' : directory}`,
      `exit code: ${String(execution.exitCode)}`,
      `duration: ${formatDuration(execution.durationMs)}`,
      '',
      '--- stdout ---',
      execution.stdout,
      '',
      '--- stderr ---',
      execution.stderr,
    ].join('\n'),
  );

  state.tests = {
    discovered: true,
    command: execution.command,
    ...(directory.length === 0 ? {} : { directory }),
    reason: discovery.command.reason,
    exitCode: execution.exitCode,
    passed: execution.passed,
    durationMs: execution.durationMs,
    timedOut: execution.timedOut,
    outputFile,
    at,
  };

  await store.logEvent({
    timestamp: at,
    runId: state.runId,
    phase: 'TESTING',
    agent: null,
    type: 'tests',
    message: `${printable} → exit ${String(execution.exitCode)}`,
    data: { passed: execution.passed, durationMs: execution.durationMs, timedOut: execution.timedOut },
  });

  if (execution.passed) {
    observer.note(`Tests passed in ${formatDuration(execution.durationMs)}.`);
    return { next: 'COMPLETE', note: 'tests passed' };
  }

  observer.warn(
    execution.timedOut
      ? `Tests timed out after ${formatDuration(execution.durationMs)}.`
      : `Tests failed (exit ${String(execution.exitCode)}). Output: ${store.path(outputFile)}`,
  );
  return { next: 'COMPLETE', note: 'tests failed' };
}
