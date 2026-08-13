import { runProcess } from '../process/runner.ts';
import { clip } from '../util/text.ts';
import type { TestCommand } from './discovery.ts';

export interface TestExecution {
  command: string[];
  exitCode: number | null;
  /** Determined by the process exit code, never by parsing output for "PASS". */
  passed: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
}

export interface RunTestsOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
  maxOutputChars?: number;
}

/**
 * Runs a discovered test command. Success is exit code 0 and nothing else — an
 * agent claiming the suite passes is not evidence.
 */
export async function runTests(test: TestCommand, options: RunTestsOptions): Promise<TestExecution> {
  const [command, ...args] = test.command;
  if (command === undefined) {
    return {
      command: [...test.command],
      exitCode: null,
      passed: false,
      stdout: '',
      stderr: 'empty test command',
      durationMs: 0,
      timedOut: false,
      aborted: false,
    };
  }

  const result = await runProcess(command, args, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 15 * 60_000,
    ...(options.signal ? { signal: options.signal } : {}),
    // `NODE_TEST_CONTEXT` is shed rather than passed on: a project whose suite
    // is `node --test` would otherwise report as a subtest of whatever ran
    // Relay, and exit 0 however many of its tests failed.
    env: { CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', NODE_TEST_CONTEXT: undefined },
    ...(options.onLine ? { onStdoutLine: options.onLine, onStderrLine: options.onLine } : {}),
  });

  const maxOutput = options.maxOutputChars ?? 200_000;
  return {
    command: [...test.command],
    exitCode: result.exitCode,
    passed: result.exitCode === 0 && !result.timedOut && !result.aborted,
    stdout: clip(result.stdout, maxOutput),
    stderr: clip(result.stderr, maxOutput),
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    aborted: result.aborted,
  };
}
