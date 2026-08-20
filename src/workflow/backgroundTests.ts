import { errorMessage, RelayError } from '../util/errors.ts';
import { discoverTestCommand, type DiscoveryResult } from '../testing/discovery.ts';
import { runTests, type TestExecution } from '../testing/runner.ts';
import type { EngineContext } from './context.ts';

/** A discovery result plus, when a command was found and run, its execution. */
export interface TestAttempt {
  discovery: DiscoveryResult;
  execution?: TestExecution;
  /** Wall-clock the run took, whether or not it was on the critical path. */
  concurrent: boolean;
}

export interface BackgroundTestRun {
  /** The tree state this run covers: the timestamp of the diff it was started for. */
  key: string;
  promise: Promise<TestAttempt | undefined>;
  controller: AbortController;
}

/**
 * Runs the project's own suite against the current worktree.
 *
 * Shared by the background start and the foreground fallback so both discover
 * and judge a suite the same way: exit code, nothing else.
 */
export async function performTests(context: EngineContext, signal: AbortSignal, concurrent: boolean): Promise<TestAttempt> {
  const { state } = context;
  const workspace = state.workspace;
  if (workspace === undefined) throw new RelayError('No workspace for this run.', { code: 'NO_WORKSPACE' });

  // The run's own file list scopes discovery: in a monorepo whose root declares
  // no suite, the package that was actually changed still gets verified.
  const discovery = await discoverTestCommand(workspace.path, state.config.tests.command, {
    changedPaths: state.diff?.files ?? [],
  });
  if (!discovery.found) {
    context.observer.testStatus({ phase: 'skipped', concurrent, detail: discovery.reason });
    return { discovery, concurrent };
  }

  context.observer.testStatus({ phase: 'running', concurrent, detail: discovery.command.command.join(' ') });

  const execution = await runTests(discovery.command, {
    cwd: discovery.command.directory ?? workspace.path,
    timeoutMs: state.config.timeouts.testsMs,
    signal,
  });

  return { discovery, execution, concurrent };
}

/**
 * Starts the suite the moment a diff exists, so it runs *while* the code
 * reviewer reads that same diff instead of after it.
 *
 * The suite and the review look at the same tree and neither depends on the
 * other's verdict, so the only thing serializing them was the phase order. What
 * they must not overlap with is an implementer editing the tree, which is why a
 * revision cancels the run in flight rather than letting it report on a
 * half-written state.
 */
export function startBackgroundTests(context: EngineContext): void {
  const { state, observer } = context;
  const workflow = state.config.workflow;
  if (!workflow.runTests || !workflow.concurrentTests) return;

  cancelBackgroundTestsSync(context);

  const key = state.diff?.at ?? '';
  const controller = new AbortController();
  const signal = AbortSignal.any([context.signal, controller.signal]);

  const promise = (async (): Promise<TestAttempt | undefined> => {
    try {
      const attempt = await performTests(context, signal, true);
      if (attempt.execution?.aborted === true) return undefined;
      return attempt;
    } catch (error) {
      observer.note(`Could not start the test suite early (${errorMessage(error)}); it will run in the test phase.`);
      return undefined;
    }
  })();

  context.backgroundTests = { key, promise, controller };
}

/**
 * Hands over a finished (or still running) background suite when it covers the
 * current tree. A stale run — one started before the last revision — is
 * discarded rather than reported, because it tested code that no longer exists.
 */
export async function takeBackgroundTests(context: EngineContext): Promise<TestAttempt | undefined> {
  const pending = context.backgroundTests;
  if (pending === undefined) return undefined;

  context.backgroundTests = undefined;

  if (pending.key !== (context.state.diff?.at ?? '')) {
    pending.controller.abort();
    await pending.promise.catch(() => undefined);
    return undefined;
  }

  return pending.promise;
}

/** Aborts a background suite and waits for the process to actually be gone. */
export async function cancelBackgroundTests(context: EngineContext): Promise<void> {
  const pending = context.backgroundTests;
  if (pending === undefined) return;
  context.backgroundTests = undefined;
  pending.controller.abort();
  await pending.promise.catch(() => undefined);
}

/** Fire-and-forget cancellation, for replacing one run with a newer one. */
function cancelBackgroundTestsSync(context: EngineContext): void {
  const pending = context.backgroundTests;
  if (pending === undefined) return;
  context.backgroundTests = undefined;
  pending.controller.abort();
  void pending.promise.catch(() => undefined);
}
