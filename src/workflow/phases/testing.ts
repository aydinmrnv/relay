import { RelayError } from '../../util/errors.ts';
import { discoverTestCommand } from '../../testing/discovery.ts';
import { runTests } from '../../testing/runner.ts';
import { formatDuration } from '../../util/text.ts';
import type { EngineContext, PhaseResult } from '../context.ts';

/**
 * Runs the project's own test command, if one can be identified safely.
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

  const discovery = await discoverTestCommand(workspace.path, state.config.tests.command);

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
  observer.note(`Running tests: ${printable}  (${discovery.command.reason})`);

  const execution = await runTests(discovery.command, {
    cwd: workspace.path,
    timeoutMs: state.config.timeouts.testsMs,
    signal,
  });

  const outputFile = await store.saveTestOutput(
    'test-run',
    [
      `$ ${printable}`,
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
