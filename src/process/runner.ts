import { spawn } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

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

  // On Windows the logical command may be a `.cmd` shim that cannot be spawned
  // without a shell; the invocation resolves it to a direct, shell-free argv.
  // On POSIX this is the identity. Results still report the logical command.
  const invocation = await resolveInvocation(command, args);

  const child = spawn(invocation.command, [...invocation.args], {
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

/**
 * The platform facts executable resolution depends on. Injectable so the
 * Windows behaviour is testable from any operating system; production callers
 * never pass one and get the machine Relay is actually running on.
 */
export interface ExecutionPlatform {
  /** `process.platform === 'win32'` on the machine that is really running. */
  isWindows: boolean;
  /** Environment the lookup reads `PATH` and `PATHEXT` from. */
  env: Record<string, string | undefined>;
  /** Node binary used to run the script inside a `.cmd` shim directly. */
  execPath: string;
}

export function nativePlatform(): ExecutionPlatform {
  return { isWindows: process.platform === 'win32', env: process.env, execPath: process.execPath };
}

const executableCache = new Map<string, string | null>();

/**
 * What `PATHEXT` means when it is unset. The full Windows default lists more
 * (`.VBS`, `.JS`, `.MSC`, …), but those run via associations Relay refuses to
 * invoke anyway — see `resolveInvocation`.
 */
const WINDOWS_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * Resolves an executable by scanning PATH directly. Avoids shelling out to
 * `which`/`command -v`/`where`, which would reintroduce a shell into the hot
 * path. On Windows this honours `PATHEXT` — the npm-installed `claude` is
 * really `claude.cmd`, and `gh` is `gh.exe` — and drops the `X_OK` probe,
 * which does not mean on Windows what it means on POSIX.
 */
export async function resolveExecutable(
  command: string,
  options: { useCache?: boolean; platform?: ExecutionPlatform } = {},
): Promise<string | null> {
  // A lookup against an injected platform never touches the cache: cached
  // answers from the real machine must not leak into a simulated one.
  const useCache = (options.useCache ?? true) && options.platform === undefined;
  if (useCache && executableCache.has(command)) return executableCache.get(command) ?? null;

  const resolved = await resolveExecutableUncached(command, options.platform ?? nativePlatform());
  if (useCache) executableCache.set(command, resolved);
  return resolved;
}

async function resolveExecutableUncached(command: string, platform: ExecutionPlatform): Promise<string | null> {
  const hasDirectory =
    command.includes('/') || (platform.isWindows && command.includes('\\')) || isAbsolute(command);
  if (hasDirectory) {
    for (const candidate of runnableCandidates(command, platform)) {
      if (await isRunnableFile(candidate, platform)) return candidate;
    }
    return null;
  }

  const pathValue = platform.env['PATH'] ?? '';
  const pathDelimiter = platform.isWindows ? ';' : ':';
  for (const entry of pathValue.split(pathDelimiter)) {
    // Windows PATH entries may be quoted ("C:\Program Files\..."); POSIX ones never are.
    const dir = platform.isWindows ? entry.replaceAll('"', '') : entry;
    if (dir.length === 0) continue;
    for (const candidate of runnableCandidates(join(dir, command), platform)) {
      if (await isRunnableFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

/**
 * The filenames a command may resolve to. On POSIX a command is one file; on
 * Windows `PATHEXT` decides what is runnable, in order, so `gh` is tried as
 * `gh.COM`, `gh.EXE`, `gh.BAT`, `gh.CMD` — plus as written when it already
 * carries a runnable extension. Each extension is also tried lowercased so the
 * lookup does not depend on the filesystem being case-insensitive.
 */
function runnableCandidates(base: string, platform: ExecutionPlatform): string[] {
  if (!platform.isWindows) return [base];

  const extensions = (platform.env['PATHEXT'] ?? WINDOWS_DEFAULT_PATHEXT)
    .split(';')
    .map((extension) => extension.trim())
    .filter((extension) => extension.startsWith('.'));

  const candidates: string[] = [];
  const lower = base.toLowerCase();
  if (extensions.some((extension) => lower.endsWith(extension.toLowerCase()))) candidates.push(base);
  for (const extension of extensions) {
    for (const candidate of [base + extension, base + extension.toLowerCase()]) {
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
  }
  return candidates;
}

async function isRunnableFile(candidate: string, platform: ExecutionPlatform): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    // X_OK reflects POSIX permission bits; on Windows PATHEXT already decided.
    if (!platform.isWindows) await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function clearExecutableCache(): void {
  executableCache.clear();
}

export interface Invocation {
  command: string;
  args: readonly string[];
}

/**
 * Turns a logical command into something `spawn` can run without a shell on
 * this platform.
 *
 * On POSIX that is the command itself. On Windows the resolved executable
 * decides: a real binary (`.exe`, `.com`) is spawned by its full path, and an
 * npm `.cmd` shim is seen through — the node script it wraps is spawned with
 * node and an explicit argv. `cmd.exe` is never an option, because its
 * argument parsing re-interprets `&`, `|` and `%VAR%` inside arguments: the
 * exact injection the no-shell rule exists to prevent. A batch file this code
 * cannot see through is refused outright rather than run through a shell.
 */
export async function resolveInvocation(
  command: string,
  args: readonly string[],
  platform?: ExecutionPlatform,
): Promise<Invocation> {
  const effective = platform ?? nativePlatform();
  if (!effective.isWindows) return { command, args };

  const resolved = await resolveExecutable(command, platform === undefined ? {} : { platform });
  // Unresolvable commands are spawned as written, so the caller sees the same
  // EXECUTABLE_NOT_FOUND error it would see on POSIX.
  if (resolved === null) return { command, args };

  const extension = extensionOf(resolved);
  if (extension === '.exe' || extension === '.com') return { command: resolved, args };
  if (extension === '.cmd' || extension === '.bat') {
    const shim = await resolveBatchShim(resolved, effective);
    return { command: shim.command, args: [...shim.args, ...args] };
  }
  // Anything else (.ps1, .vbs, …) runs via an interpreter that parses its
  // arguments as a language. Refusing is the honest answer.
  throw refuseWithoutShell(resolved, `.${extension.replace(/^\./, '')} files only run through an interpreter shell`);
}

/** Lowercased extension of the last path segment, tolerant of both separators. */
function extensionOf(filePath: string): string {
  const name = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/**
 * Resolves an npm `.cmd` shim to the script it wraps.
 *
 * Shims generated by npm's `cmd-shim` end in a line like
 * `... & "%_prog%"  "%dp0%\node_modules\pkg\bin\cli.js" %*` (or, in older
 * versions, `"%~dp0\node.exe"  "%~dp0\...\cli.js" %*`), with `_prog` falling
 * back to `node`. That is enough structure to recover the real entry point and
 * run it with node directly — explicit argv, no `cmd.exe` anywhere.
 */
async function resolveBatchShim(shimPath: string, platform: ExecutionPlatform): Promise<Invocation> {
  let content: string;
  try {
    content = await readFile(shimPath, 'utf8');
  } catch (error) {
    throw refuseWithoutShell(shimPath, 'it could not be read', error);
  }

  const invocationLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes('%*'))
    .at(-1);
  if (invocationLine === undefined) {
    throw refuseWithoutShell(shimPath, 'it does not look like an npm shim');
  }

  // The invocation is the last `&`-joined segment mentioning `%*`.
  const segment = invocationLine.split('&').filter((part) => part.includes('%*')).at(-1) ?? '';
  const tokens = (segment.match(/"[^"]*"|\S+/g) ?? []).map((token) => token.replace(/^"|"$/g, ''));

  const program = tokens[0] ?? '';
  if (!shimRunsNode(program, content)) {
    throw refuseWithoutShell(shimPath, `it launches \`${program || 'nothing'}\`, which Relay cannot verify is node`);
  }

  const scriptToken = tokens.slice(1).find((token) => /%~?dp0%?/i.test(token));
  if (scriptToken === undefined) {
    throw refuseWithoutShell(shimPath, 'the script it wraps could not be identified');
  }
  const relativePart = scriptToken.replace(/%~?dp0%?[\\/]?/i, '');
  const scriptPath = join(dirname(shimPath), ...relativePart.split(/[\\/]/));

  try {
    const info = await stat(scriptPath);
    if (!info.isFile()) throw new Error('not a file');
  } catch (error) {
    throw refuseWithoutShell(shimPath, `the script it wraps (${scriptPath}) does not exist`, error);
  }

  return { command: platform.execPath, args: [scriptPath] };
}

/** True when the shim's program is node — directly, or via cmd-shim's `_prog`. */
function shimRunsNode(program: string, content: string): boolean {
  if (/%_prog%/i.test(program)) {
    // cmd-shim sets `_prog` twice: `%dp0%\node.exe` when a node is bundled
    // beside the shim, plus a bare fallback. Every assignment must be node —
    // a python shim says `SET "_prog=python"` here.
    const assignments = [...content.matchAll(/SET\s+"_prog=([^"]*)"/gi)].map((match) => match[1] ?? '');
    return assignments.length > 0 && assignments.every((value) => nameIsNode(value));
  }
  return nameIsNode(program);
}

function nameIsNode(program: string): boolean {
  const name = basename(program.replace(/%~?dp0%?[\\/]?/i, '').replaceAll('\\', '/')).toLowerCase();
  return name === 'node' || name === 'node.exe';
}

function refuseWithoutShell(path: string, reason: string, cause?: unknown): RelayError {
  return new RelayError(`Refusing to run ${basename(path)} without a shell: ${reason}.`, {
    code: 'BATCH_SHIM_UNSUPPORTED',
    hint:
      'Relay never spawns through a shell, on any platform: cmd.exe rewrites arguments, which would let\n' +
      'issue text or agent output become shell syntax. Install a native (.exe) or Node-based build of this tool.',
    ...(cause === undefined ? {} : { cause }),
  });
}
