import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { runProcess, resolveExecutable } from '../process/runner.ts';
import { parseJsonLine } from '../process/lines.ts';
import { sandboxReadOnly } from './sandbox.ts';
import { uuid } from '../util/ids.ts';
import { oneLine } from '../util/text.ts';
import type {
  AgentCapability,
  AgentEvent,
  AgentHarness,
  AgentRunOptions,
  AgentSession,
  AgentUsage,
  AvailabilityResult,
  ResumeOptions,
} from './types.ts';
import { makeEvent } from './types.ts';

/**
 * Commands Relay never lets an agent run, regardless of role. Publishing or
 * merging is the user's decision, so those paths are closed at the CLI's own
 * permission layer rather than by instruction.
 */
export const CLAUDE_ALWAYS_DENIED = [
  'Bash(git push:*)',
  'Bash(git push)',
  'Bash(git merge:*)',
  'Bash(gh pr create:*)',
  'Bash(gh pr merge:*)',
  'Bash(gh release:*)',
  'Bash(npm publish:*)',
];

/** Additional tools denied to read-only roles (planning and review). */
export const CLAUDE_READ_ONLY_DENIED = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

/**
 * What the Claude CLI itself must be able to write when Relay wraps a
 * read-only turn in an OS sandbox: its own state (`~/.claude`, `~/.claude.json`
 * and friends), its caches, and the temp directory. The worktree is not in
 * this list, which is the enforcement — a read-only reviewer cannot write the
 * code it is reviewing, whatever its deny list says.
 */
export function claudeWritablePaths(home: string = homedir(), tmp: string = tmpdir()): string[] {
  return [
    tmp,
    join(home, '.claude'),
    join(home, '.claude.json'),
    join(home, '.claude.json.backup'),
    join(home, '.claude.json.lock'),
    join(home, '.cache'),
    join(home, '.npm'),
    join(home, '.config', 'claude'),
    join(home, 'Library', 'Caches'),
    join(home, 'Library', 'Logs'),
  ];
}

export interface ClaudeArgsOptions {
  capability: AgentCapability;
  /** Pre-generated session id for a fresh conversation. */
  sessionId?: string;
  /** Existing session id to continue. Mutually exclusive with `sessionId`. */
  resumeSessionId?: string;
  model?: string;
  outputSchema?: Record<string, unknown>;
  extraArgs?: readonly string[];
}

/**
 * Builds the argv for a `claude` invocation. Kept pure so tests can assert the
 * exact command without spawning anything.
 */
export function buildClaudeArgs(options: ClaudeArgsOptions): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];

  if (options.resumeSessionId !== undefined) {
    args.push('--resume', options.resumeSessionId);
  } else if (options.sessionId !== undefined) {
    args.push('--session-id', options.sessionId);
  }

  if (options.model !== undefined && options.model.length > 0) {
    args.push('--model', options.model);
  }

  // Relay confines the agent to a throwaway worktree, so the interactive
  // permission prompt has no one to answer it and would only stall the run.
  // Capability is enforced in layers instead: read-only turns are wrapped in an
  // OS sandbox where the platform offers one (see `execute`), and the deny
  // list below is the second layer — and the only one where no sandbox exists,
  // which the turn reports as a notice rather than leaving unsaid.
  args.push('--permission-mode', 'bypassPermissions');

  const denied = [...CLAUDE_ALWAYS_DENIED];
  if (options.capability === 'read_only') denied.push(...CLAUDE_READ_ONLY_DENIED);
  args.push('--disallowed-tools', ...denied);

  if (options.outputSchema !== undefined) {
    args.push('--json-schema', JSON.stringify(options.outputSchema));
  }

  if (options.extraArgs !== undefined) args.push(...options.extraArgs);

  return args;
}

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
}

/**
 * Translates one line of Claude's `stream-json` output into normalized events.
 * A line may produce zero events (bookkeeping) or several (a multi-block message).
 */
export function normalizeClaudeLine(raw: Record<string, unknown>, agent: string): AgentEvent[] {
  const type = typeof raw['type'] === 'string' ? raw['type'] : '';

  if (type === 'system') {
    if (raw['subtype'] !== 'init') return [];
    const sessionId = typeof raw['session_id'] === 'string' ? raw['session_id'] : undefined;
    return [makeEvent('started', agent, sessionId === undefined ? {} : { sessionId })];
  }

  if (type === 'assistant') {
    const message = raw['message'];
    if (message === null || typeof message !== 'object') return [];
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];

    const events: AgentEvent[] = [];
    for (const block of content as ClaudeContentBlock[]) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
        events.push(makeEvent('message', agent, { text: block.text }));
      } else if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim().length > 0) {
        events.push(makeEvent('thinking', agent, { text: oneLine(block.thinking, 200) }));
      } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
        events.push(toolEvent(agent, block.name, block.input));
      }
    }
    return events;
  }

  if (type === 'result') {
    const isError = raw['is_error'] === true || raw['subtype'] !== 'success';
    const result = typeof raw['result'] === 'string' ? raw['result'] : undefined;
    const usage = claudeUsage(raw);
    const billing = usage === undefined ? {} : { usage };
    if (isError) {
      const detail =
        typeof raw['error'] === 'string'
          ? raw['error']
          : (result ?? `claude ended with subtype "${String(raw['subtype'])}"`);
      return [makeEvent('failed', agent, { error: detail, ...billing })];
    }
    return [makeEvent('completed', agent, { ...(result === undefined ? {} : { result }), ...billing })];
  }

  if (type === 'error' || type === 'stream_error') {
    const detail = typeof raw['message'] === 'string' ? raw['message'] : JSON.stringify(raw);
    return [makeEvent('failed', agent, { error: detail })];
  }

  return [];
}

/**
 * Reads the token counts and cost Claude puts on its `result` line.
 *
 * Cache creation and cache reads are billed input, so they are folded into
 * `inputTokens` rather than dropped: the total is what the run actually cost.
 */
export function claudeUsage(raw: Record<string, unknown>): AgentUsage | undefined {
  const usage = raw['usage'];
  const record = usage !== null && typeof usage === 'object' ? (usage as Record<string, unknown>) : {};

  const inputTokens =
    tokenCount(record['input_tokens']) +
    tokenCount(record['cache_creation_input_tokens']) +
    tokenCount(record['cache_read_input_tokens']);
  const outputTokens = tokenCount(record['output_tokens']);

  const cost = raw['total_cost_usd'];
  const costUsd = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined;

  if (inputTokens === 0 && outputTokens === 0 && costUsd === undefined) return undefined;
  return { inputTokens, outputTokens, ...(costUsd === undefined ? {} : { costUsd }) };
}

/**
 * Totals are summed into persisted run state, so a malformed count would
 * corrupt them for the life of the run. Anything but a whole, countable
 * number of tokens is dropped rather than folded in.
 */
function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Maps Claude tool names onto the richer event types Relay renders specially. */
function toolEvent(agent: string, tool: string, input: unknown): AgentEvent {
  const record = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};

  if (tool === 'Bash' && typeof record['command'] === 'string') {
    return makeEvent('command', agent, { command: record['command'] });
  }
  if ((tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') &&
      typeof record['file_path'] === 'string') {
    return makeEvent('file_changed', agent, {
      path: record['file_path'],
      change: tool === 'Write' ? 'wrote' : 'edited',
    });
  }
  return makeEvent('tool', agent, { tool, input: summarizeToolInput(record) });
}

/** Keeps a compact, non-sensitive shape of tool input for the audit log. */
function summarizeToolInput(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const keys = ['pattern', 'path', 'file_path', 'query', 'url', 'description', 'prompt'];
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') out[key] = oneLine(value, 160);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Reads sign-in state out of `claude auth status --json`, which exits 0 in both
 * cases and so cannot be judged by its exit code.
 *
 * Only the boolean is returned. The rest of that payload identifies an account,
 * and Relay has no business carrying it any further than this line.
 */
export function claudeSignedIn(stdout: string): boolean | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed === null || typeof parsed !== 'object') return undefined;
    const loggedIn = (parsed as { loggedIn?: unknown }).loggedIn;
    return typeof loggedIn === 'boolean' ? loggedIn : undefined;
  } catch {
    // Older builds print prose instead of JSON; the exit code decides there.
    return undefined;
  }
}

export interface ClaudeHarnessOptions {
  binary?: string;
  defaultTimeoutMs?: number;
  /** Passed through to `--model` when a run does not specify one. */
  defaultModel?: string;
  extraArgs?: readonly string[];
}

export class ClaudeHarness implements AgentHarness {
  readonly name = 'claude';

  private readonly binary: string;
  private readonly defaultTimeoutMs: number;
  private readonly defaultModel: string | undefined;
  private readonly extraArgs: readonly string[];
  private readonly active = new Map<string, AbortController>();

  constructor(options: ClaudeHarnessOptions = {}) {
    this.binary = options.binary ?? 'claude';
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30 * 60_000;
    this.defaultModel = options.defaultModel;
    this.extraArgs = options.extraArgs ?? [];
  }

  async checkAvailability(): Promise<AvailabilityResult> {
    const path = await resolveExecutable(this.binary);
    if (path === null) {
      return {
        available: false,
        detail: 'not found',
        hint: `Claude Code was not found.\n\nInstall and authenticate Claude Code, then run:\n\n  relay doctor`,
      };
    }

    const result = await runProcess(this.binary, ['--version'], { timeoutMs: 20_000 });
    if (!result.ok) {
      return { available: false, detail: 'installed but not runnable', path, hint: 'Try running `claude --version` yourself.' };
    }

    const version = result.stdout.trim().split('\n')[0] ?? 'unknown';
    return { available: true, detail: version, version, path };
  }

  async start(options: AgentRunOptions): Promise<AgentSession> {
    // Claude accepts a caller-chosen session id, so the id needed for resume is
    // known before the process starts rather than scraped out of its output.
    const sessionId = uuid();
    const args = buildClaudeArgs({
      capability: options.capability,
      sessionId,
      ...this.optionalArgs(options),
    });
    return this.execute(args, options, sessionId);
  }

  async resume(sessionId: string, prompt: string, options: ResumeOptions): Promise<AgentSession> {
    const args = buildClaudeArgs({
      capability: options.capability,
      resumeSessionId: sessionId,
      ...this.optionalArgs(options),
    });
    return this.execute(args, { ...options, prompt }, sessionId);
  }

  async cancel(sessionId?: string): Promise<void> {
    if (sessionId === undefined) {
      for (const controller of this.active.values()) controller.abort();
      this.active.clear();
      return;
    }
    this.active.get(sessionId)?.abort();
    this.active.delete(sessionId);
  }

  /** Optional argv inputs, omitted entirely rather than passed as undefined. */
  private optionalArgs(options: { model?: string; outputSchema?: Record<string, unknown> }): Partial<ClaudeArgsOptions> {
    const model = options.model ?? this.defaultModel;
    return {
      ...(model === undefined ? {} : { model }),
      ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
      extraArgs: this.extraArgs,
    };
  }

  private async execute(
    args: string[],
    options: AgentRunOptions,
    knownSessionId: string,
  ): Promise<AgentSession> {
    const controller = new AbortController();
    this.active.set(knownSessionId, controller);
    // Removed when the turn ends: a run makes many turns against one signal,
    // and listeners that outlive their process pile up on it.
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const events: AgentEvent[] = [];
    let sessionId: string | undefined = knownSessionId;
    let finalText = '';
    let failure: string | undefined;
    let usage: AgentUsage | undefined;
    let sawResult = false;

    const emit = (event: AgentEvent): void => {
      events.push(event);
      options.onEvent?.(event);
      if (event.type === 'started' && event.sessionId !== undefined) sessionId = event.sessionId;
      if (event.type === 'completed' && event.result !== undefined) finalText = event.result;
      if (event.type === 'failed') failure = event.error;
      if (event.type === 'completed' || event.type === 'failed') {
        sawResult = true;
        if (event.usage !== undefined) usage = event.usage;
      }
    };

    // Claude's own read-only enforcement is a deny list — a policy inside its
    // process. Read-only turns are therefore wrapped in an OS sandbox where the
    // platform provides one, so "the reviewer cannot write" is the operating
    // system's promise rather than the CLI's. When no sandbox exists, the turn
    // says so out loud instead of implying parity it does not have.
    let spawnSpec = { command: this.binary, args };
    if (options.capability === 'read_only') {
      const sandboxed = await sandboxReadOnly(spawnSpec, claudeWritablePaths());
      spawnSpec = sandboxed.invocation;
      if (sandboxed.notice !== undefined) {
        emit(makeEvent('notice', options.role, { text: sandboxed.notice }));
      }
    }

    const startedAt = Date.now();
    try {
      let result;
      try {
        result = await runProcess(spawnSpec.command, spawnSpec.args, {
          cwd: options.cwd,
          // The prompt goes over stdin: no argv length limit, no quoting, and
          // nothing derived from an issue or an agent ever reaches a shell.
          stdin: options.prompt,
          timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
          signal: controller.signal,
          onStdoutLine: (line) => {
            const parsed = parseJsonLine(line);
            if (parsed === undefined) return;
            for (const event of normalizeClaudeLine(parsed, options.role)) emit(event);
          },
          onStderrLine: (line) => {
            if (line.trim().length > 0) emit(makeEvent('notice', options.role, { text: oneLine(line, 300) }));
          },
        });
      } catch (error) {
        // A process that could not even start (missing binary, EACCES) fails
        // the turn the way a crash does: a `failed` event and a resolved
        // session. Nothing thrown here may cross the harness boundary.
        emit(makeEvent('failed', options.role, { error: error instanceof Error ? error.message : String(error) }));
        return {
          provider: this.name,
          role: options.role,
          ...(sessionId === undefined ? {} : { sessionId }),
          ok: false,
          text: finalText,
          events,
          ...(failure === undefined ? {} : { error: failure }),
          exitCode: null,
          durationMs: Date.now() - startedAt,
          timedOut: false,
          aborted: false,
          ...(usage === undefined ? {} : { usage }),
          invocation: { command: spawnSpec.command, args: spawnSpec.args },
        };
      }

      // The CLI's exit status is the source of truth. A `result` event claiming
      // success on a non-zero exit is not trusted — and an exit 0 whose stream
      // never carried a result line is a malformed or truncated stream, not a
      // success with nothing to say.
      if (result.ok && failure === undefined && !sawResult) {
        failure = 'claude exited without reporting a result: its stream was malformed or truncated';
      }
      const ok = result.ok && failure === undefined;
      if (!ok && failure === undefined) {
        failure = result.timedOut
          ? `claude timed out after ${Math.round((options.timeoutMs ?? this.defaultTimeoutMs) / 1000)}s`
          : result.aborted
            ? 'claude was cancelled'
            : result.signal !== null
              ? `claude was killed by ${result.signal}`
              : `claude exited with code ${result.exitCode}${result.stderr.trim() ? `: ${oneLine(result.stderr, 400)}` : ''}`;
      }
      // The contract promises a `failed` event for every failed turn, so one is
      // synthesized when the stream itself never said so — a kill, a silent
      // non-zero exit, a cancellation, a truncated stream.
      if (!ok && !events.some((event) => event.type === 'failed')) {
        emit(makeEvent('failed', options.role, { error: failure ?? 'claude failed' }));
      }

      return {
        provider: this.name,
        role: options.role,
        ...(sessionId === undefined ? {} : { sessionId }),
        ok,
        text: finalText,
        events,
        ...(failure === undefined ? {} : { error: failure }),
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        aborted: result.aborted,
        ...(usage === undefined ? {} : { usage }),
        // The wrapped argv, when a sandbox applied: the audit trail records
        // what was actually executed, sandbox and all.
        invocation: { command: spawnSpec.command, args: spawnSpec.args },
      };
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      this.active.delete(knownSessionId);
    }
  }
}
