import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

import { RelayError } from '../util/errors.ts';
import { createLineSplitter } from './lines.ts';

export interface ProcessRunOptions {
  cwd?: string;
  /**
   * Extra variables layered on top of the inherited environment. A value of
   * `undefined` removes the variable from the child rather than setting it,
   * which is how a caller sheds something it inherited but must not pass on.
   */
  env?: Record<string, string | undefined>;
  /** Text written to the child's stdin, which is then closed. */
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Cap on retained stdout/stderr, in characters. Streaming is unaffected. */
  maxCaptureChars?: number;
  /** Grace period between SIGTERM and SIGKILL when terminating. */
  killGraceMs?: number;
}

export interface ProcessResult {
  command: string;
  args: readonly string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  /** True only for a clean `exit 0`. */
  ok: boolean;
}

const DEFAULT_MAX_CAPTURE_CHARS = 4_000_000;
const DEFAULT_KILL_GRACE_MS = 5_000;

/**
 * Spawns a process with an explicit argv. There is no shell involved anywhere
 * in Relay: arguments are passed as an array, so agent- or issue-derived text
 * can never be interpreted as shell syntax.
 */
export async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessRunOptions = {},
): Promise<ProcessResult> {
  const cwd = options.cwd ?? process.cwd();
  const maxCapture = options.maxCaptureChars ?? DEFAULT_MAX_CAPTURE_CHARS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const startedAt = Date.now();

  if (options.signal?.aborted) {
    return {
      command,
      args,
      cwd,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      durationMs: 0,
      timedOut: false,
      aborted: true,
      ok: false,
    };
  }

  const child = spawn(command, [...args], {
    cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    // stdin is a pipe we control (never the user's terminal), so a child that
    // decides to read stdin sees a clean EOF instead of hijacking the TTY.
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let timedOut = false;
  let aborted = false;
  let settled = false;

  const stdoutSplitter = createLineSplitter((line) => options.onStdoutLine?.(line));
  const stderrSplitter = createLineSplitter((line) => options.onStderrLine?.(line));

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  child.stdout.on('data', (chunk: string) => {
    if (stdout.length < maxCapture) {
      stdout += chunk;
      if (stdout.length > maxCapture) {
        stdout = stdout.slice(0, maxCapture);
        stdoutTruncated = true;
      }
    } else {
      stdoutTruncated = true;
    }
    stdoutSplitter.push(chunk);
  });

  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < maxCapture) {
      stderr += chunk;
      if (stderr.length > maxCapture) {
        stderr = stderr.slice(0, maxCapture);
        stderrTruncated = true;
      }
    } else {
      stderrTruncated = true;
    }
    stderrSplitter.push(chunk);
  });

  // Terminate politely first; escalate only if the child ignores SIGTERM.
  let killTimer: NodeJS.Timeout | undefined;
  const terminate = (): void => {
    if (settled || child.killed) return;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => {
      if (!settled) child.kill('SIGKILL');
    }, killGraceMs);
    killTimer.unref?.();
  };

  let timeoutTimer: NodeJS.Timeout | undefined;
  if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timeoutTimer.unref?.();
  }

  const onAbort = (): void => {
    aborted = true;
    terminate();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  if (options.stdin !== undefined) {
    child.stdin.on('error', () => {
      // A child that exits before draining stdin gives us EPIPE. That is a
      // property of the child's lifecycle, not a failure of the write.
    });
    child.stdin.end(options.stdin);
  } else {
    child.stdin.end();
  }

  try {
    const { exitCode, signalName } = await new Promise<{
      exitCode: number | null;
      signalName: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.on('error', (error: NodeJS.ErrnoException) => {
        settled = true;
        if (error.code === 'ENOENT') {
          reject(
            new RelayError(`Executable not found: ${command}`, {
              code: 'EXECUTABLE_NOT_FOUND',
              hint: `Install ${command} and make sure it is on your PATH, then run \`relay doctor\`.`,
              cause: error,
            }),
          );
          return;
        }
        reject(
          new RelayError(`Failed to start ${command}: ${error.message}`, {
            code: 'SPAWN_FAILED',
            cause: error,
          }),
        );
      });
      child.on('close', (code, sig) => {
        settled = true;
        resolve({ exitCode: code, signalName: sig });
      });
    });

    stdoutSplitter.flush();
    stderrSplitter.flush();

    if (stdoutTruncated) stdout += '\n[relay: stdout truncated]';
    if (stderrTruncated) stderr += '\n[relay: stderr truncated]';

    return {
      command,
      args,
      cwd,
      exitCode,
      signal: signalName,
      stdout,
      stderr,
      durationMs: Date.now() - startedAt,
      timedOut,
      aborted,
      ok: exitCode === 0 && !timedOut && !aborted,
    };
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** Runs a process and throws a RelayError unless it exits 0. */
export async function runProcessOrThrow(
  command: string,
  args: readonly string[],
  options: ProcessRunOptions & { errorHint?: string } = {},
): Promise<ProcessResult> {
  const result = await runProcess(command, args, options);
  if (!result.ok) {
    throw new RelayError(describeFailure(result), {
      code: 'PROCESS_FAILED',
      ...(options.errorHint === undefined ? {} : { hint: options.errorHint }),
    });
  }
  return result;
}

export function describeFailure(result: ProcessResult): string {
  const invocation = `${result.command} ${result.args.join(' ')}`.trim();
  const reason = result.timedOut
    ? 'timed out'
    : result.aborted
      ? 'was cancelled'
      : result.signal
        ? `was killed by ${result.signal}`
        : `exited with code ${result.exitCode}`;
  const detail = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-6).join('\n');
  return detail.length > 0 ? `\`${invocation}\` ${reason}:\n${detail}` : `\`${invocation}\` ${reason}`;
}

const executableCache = new Map<string, string | null>();

/**
 * Resolves an executable by scanning PATH directly. Avoids shelling out to
 * `which`/`command -v`, which would reintroduce a shell into the hot path.
 */
export async function resolveExecutable(command: string, options: { useCache?: boolean } = {}): Promise<string | null> {
  const useCache = options.useCache ?? true;
  if (useCache && executableCache.has(command)) return executableCache.get(command) ?? null;

  const resolved = await resolveExecutableUncached(command);
  if (useCache) executableCache.set(command, resolved);
  return resolved;
}

async function resolveExecutableUncached(command: string): Promise<string | null> {
  if (command.includes('/') || isAbsolute(command)) {
    return (await isExecutableFile(command)) ? command : null;
  }

  const pathValue = process.env.PATH ?? '';
  for (const dir of pathValue.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, command);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function clearExecutableCache(): void {
  executableCache.clear();
}
