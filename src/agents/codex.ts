import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runProcess, resolveExecutable } from '../process/runner.ts';
import { parseJsonLine } from '../process/lines.ts';
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
 * Codex enforces capability with a real OS sandbox rather than a prompt.
 *
 * This is why Relay does not wrap Codex in its own sandbox the way it wraps
 * Claude (`src/agents/sandbox.ts`): the CLI already confines the turn at the OS
 * level, and nesting a second Seatbelt profile around it fails on macOS. The
 * registry declares this as `enforcement: os-sandbox`, and `relay doctor`
 * reports it per harness.
 */
export function codexSandboxMode(capability: AgentCapability): string {
  return capability === 'write' ? 'workspace-write' : 'read-only';
}

export interface CodexArgsOptions {
  capability: AgentCapability;
  /** Existing thread id to continue. */
  resumeSessionId?: string;
  model?: string;
  /** Path to a file where Codex writes the agent's final message. */
  lastMessageFile?: string;
  /** Path to a JSON Schema file constraining the final message. */
  outputSchemaFile?: string;
  extraArgs?: readonly string[];
}

/**
 * Flags accepted by `codex exec` but NOT by `codex exec resume`, which takes a
 * narrower option set. Passing one of these to resume makes codex exit 2 before
 * doing any work, so the two argv shapes are built separately.
 */
export const CODEX_EXEC_ONLY_FLAGS = ['--sandbox', '--color', '--cd', '--add-dir'] as const;

/**
 * Builds the argv for a `codex exec` invocation.
 *
 * The working directory always comes from the spawned process's cwd rather than
 * `--cd`, because resume does not support it. The sandbox is set with `--sandbox`
 * on a fresh exec and with the equivalent config override on resume.
 */
export function buildCodexArgs(options: CodexArgsOptions): string[] {
  const sandbox = codexSandboxMode(options.capability);
  const resuming = options.resumeSessionId !== undefined;
  const args = ['exec'];

  if (options.resumeSessionId !== undefined) {
    args.push('resume', options.resumeSessionId);
  }

  args.push('--json');

  if (resuming) {
    args.push('-c', `sandbox_mode="${sandbox}"`);
  } else {
    // Colour is suppressed on resume through NO_COLOR in the environment.
    args.push('--color', 'never', '--sandbox', sandbox);
  }

  // Never wait on an approval prompt: there is no human attached to this process.
  args.push('-c', 'approval_policy="never"');

  if (options.model !== undefined && options.model.length > 0) {
    args.push('--model', options.model);
  }
  if (options.lastMessageFile !== undefined) {
    args.push('--output-last-message', options.lastMessageFile);
  }
  if (options.outputSchemaFile !== undefined) {
    args.push('--output-schema', options.outputSchemaFile);
  }
  if (options.extraArgs !== undefined) args.push(...options.extraArgs);

  // `-` tells Codex to read the prompt from stdin, for both exec and resume.
  args.push('-');

  return args;
}

interface CodexItem {
  type?: string;
  text?: string;
  command?: string;
  exit_code?: number;
  status?: string;
  message?: string;
  path?: string;
  kind?: string;
  changes?: Array<{ path?: string; kind?: string }>;
  server?: string;
  tool?: string;
  query?: string;
}

/** Translates one line of Codex's JSONL stream into normalized events. */
export function normalizeCodexLine(raw: Record<string, unknown>, agent: string): AgentEvent[] {
  const type = typeof raw['type'] === 'string' ? raw['type'] : '';

  if (type === 'thread.started') {
    const sessionId = typeof raw['thread_id'] === 'string' ? raw['thread_id'] : undefined;
    return [makeEvent('started', agent, sessionId === undefined ? {} : { sessionId })];
  }

  if (type === 'turn.completed') {
    const usage = codexUsage(raw);
    return [makeEvent('completed', agent, usage === undefined ? {} : { usage })];
  }

  if (type === 'turn.failed' || type === 'error') {
    const error = raw['error'];
    const detail =
      error !== null && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : typeof raw['message'] === 'string'
          ? raw['message']
          : 'codex reported a failed turn';
    const usage = codexUsage(raw);
    return [makeEvent('failed', agent, { error: detail, ...(usage === undefined ? {} : { usage }) })];
  }

  if (type === 'item.completed' || type === 'item.started') {
    const item = raw['item'];
    if (item === null || typeof item !== 'object') return [];
    // `item.started` only matters for long-running commands; everything else is
    // reported once, on completion, to avoid duplicate events.
    if (type === 'item.started' && (item as CodexItem).type !== 'command_execution') return [];
    return normalizeCodexItem(item as CodexItem, agent, type === 'item.started');
  }

  return [];
}

/**
 * Reads the token counts Codex attaches to a finished turn. Unlike Claude,
 * `input_tokens` already includes `cached_input_tokens`, so adding them would
 * double-count. Codex reports no price, so `costUsd` stays absent.
 */
export function codexUsage(raw: Record<string, unknown>): AgentUsage | undefined {
  const usage = raw['usage'];
  if (usage === null || typeof usage !== 'object') return undefined;
  const record = usage as Record<string, unknown>;

  const inputTokens = tokenCount(record['input_tokens']);
  const outputTokens = tokenCount(record['output_tokens']);
  if (inputTokens === 0 && outputTokens === 0) return undefined;

  return { inputTokens, outputTokens };
}

/**
 * Totals are summed into persisted run state, so a malformed count would
 * corrupt them for the life of the run. Anything but a whole, countable
 * number of tokens is dropped rather than folded in.
 */
function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeCodexItem(item: CodexItem, agent: string, isStart: boolean): AgentEvent[] {
  switch (item.type) {
    case 'agent_message':
      return typeof item.text === 'string' && item.text.trim().length > 0
        ? [makeEvent('message', agent, { text: item.text })]
        : [];

    case 'reasoning':
      return typeof item.text === 'string' && item.text.trim().length > 0
        ? [makeEvent('thinking', agent, { text: oneLine(item.text, 200) })]
        : [];

    case 'command_execution': {
      if (typeof item.command !== 'string') return [];
      // Report the command once it finishes so the exit code is available.
      if (isStart) return [];
      return [
        makeEvent('command', agent, {
          command: oneLine(item.command, 300),
          ...(typeof item.exit_code === 'number' ? { exitCode: item.exit_code } : {}),
        }),
      ];
    }

    case 'file_change': {
      const changes = Array.isArray(item.changes)
        ? item.changes
        : typeof item.path === 'string'
          ? [{ path: item.path, kind: item.kind }]
          : [];
      return changes
        .filter((change): change is { path: string; kind?: string } => typeof change?.path === 'string')
        .map((change) =>
          makeEvent('file_changed', agent, {
            path: change.path,
            ...(change.kind === undefined ? {} : { change: change.kind }),
          }),
        );
    }

    case 'mcp_tool_call':
      return [makeEvent('tool', agent, { tool: `${item.server ?? 'mcp'}/${item.tool ?? 'call'}` })];

    case 'web_search':
      return [makeEvent('tool', agent, { tool: 'web_search', ...(item.query === undefined ? {} : { input: { query: item.query } }) })];

    case 'error':
      return [makeEvent('failed', agent, { error: item.message ?? 'codex reported an error item' })];

    case 'todo_list':
      return [];

    default:
      return item.type === undefined ? [] : [makeEvent('tool', agent, { tool: item.type })];
  }
}

export interface CodexHarnessOptions {
  binary?: string;
  defaultTimeoutMs?: number;
  defaultModel?: string;
  extraArgs?: readonly string[];
}

export class CodexHarness implements AgentHarness {
  readonly name = 'codex';

  private readonly binary: string;
  private readonly defaultTimeoutMs: number;
  private readonly defaultModel: string | undefined;
  private readonly extraArgs: readonly string[];
  private readonly active = new Map<string, AbortController>();
  private handleCounter = 0;

  constructor(options: CodexHarnessOptions = {}) {
    this.binary = options.binary ?? 'codex';
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
        hint: `Codex was not found.\n\nInstall and authenticate the Codex CLI, then run:\n\n  relay doctor`,
      };
    }

    const result = await runProcess(this.binary, ['--version'], { timeoutMs: 20_000 });
    if (!result.ok) {
      return { available: false, detail: 'installed but not runnable', path, hint: 'Try running `codex --version` yourself.' };
    }

    const version = result.stdout.trim().split('\n')[0] ?? 'unknown';
    return { available: true, detail: version, version, path };
  }

  async start(options: AgentRunOptions): Promise<AgentSession> {
    return this.execute(options, undefined);
  }

  async resume(sessionId: string, prompt: string, options: ResumeOptions): Promise<AgentSession> {
    return this.execute({ ...options, prompt }, sessionId);
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

  private async execute(options: AgentRunOptions, resumeSessionId: string | undefined): Promise<AgentSession> {
    // Codex reveals its thread id only once the process starts, so in-flight
    // work is tracked under a local handle as well as the eventual session id.
    const handle = resumeSessionId ?? `codex-pending-${(this.handleCounter += 1)}`;
    const controller = new AbortController();
    this.active.set(handle, controller);
    // Removed when the turn ends: a run makes many turns against one signal,
    // and listeners that outlive their process pile up on it.
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const scratch = await mkdtemp(join(tmpdir(), 'relay-codex-'));
    const lastMessageFile = join(scratch, 'last-message.txt');

    let outputSchemaFile: string | undefined;
    if (options.outputSchema !== undefined) {
      outputSchemaFile = join(scratch, 'schema.json');
      await writeFile(outputSchemaFile, JSON.stringify(options.outputSchema, null, 2), 'utf8');
    }

    const model = options.model ?? this.defaultModel;
    const args = buildCodexArgs({
      capability: options.capability,
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
      ...(model === undefined ? {} : { model }),
      lastMessageFile,
      ...(outputSchemaFile === undefined ? {} : { outputSchemaFile }),
      extraArgs: this.extraArgs,
    });

    const events: AgentEvent[] = [];
    let sessionId = resumeSessionId;
    let lastMessage = '';
    let failure: string | undefined;
    let usage: AgentUsage | undefined;
    let sawResult = false;

    const emit = (event: AgentEvent): void => {
      events.push(event);
      options.onEvent?.(event);
      if (event.type === 'started' && event.sessionId !== undefined) {
        sessionId = event.sessionId;
        this.active.set(event.sessionId, controller);
      }
      if (event.type === 'message') lastMessage = event.text;
      if (event.type === 'failed') failure = event.error;
      if (event.type === 'completed' || event.type === 'failed') {
        sawResult = true;
        if (event.usage !== undefined) usage = event.usage;
      }
    };

    const startedAt = Date.now();
    try {
      let result;
      try {
        result = await runProcess(this.binary, args, {
          cwd: options.cwd,
          stdin: options.prompt,
          timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
          signal: controller.signal,
          env: { NO_COLOR: '1' },
          onStdoutLine: (line) => {
            const parsed = parseJsonLine(line);
            if (parsed === undefined) return;
            for (const event of normalizeCodexLine(parsed, options.role)) emit(event);
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
          text: lastMessage,
          events,
          ...(failure === undefined ? {} : { error: failure }),
          exitCode: null,
          durationMs: Date.now() - startedAt,
          timedOut: false,
          aborted: false,
          ...(usage === undefined ? {} : { usage }),
          invocation: { command: this.binary, args },
        };
      }

      // Prefer the file Codex writes: it is the authoritative final message and
      // survives any interleaving in the event stream.
      const fromFile = await readFileSafe(lastMessageFile);
      const finalText = fromFile !== undefined && fromFile.trim().length > 0 ? fromFile : lastMessage;

      // The exit status is the source of truth — and an exit 0 whose stream
      // never carried a terminal turn event is a malformed or truncated
      // stream, not a success with nothing to say.
      if (result.ok && failure === undefined && !sawResult) {
        failure = 'codex exited without reporting a completed turn: its stream was malformed or truncated';
      }
      const ok = result.ok && failure === undefined;
      if (!ok && failure === undefined) {
        failure = result.timedOut
          ? `codex timed out after ${Math.round((options.timeoutMs ?? this.defaultTimeoutMs) / 1000)}s`
          : result.aborted
            ? 'codex was cancelled'
            : result.signal !== null
              ? `codex was killed by ${result.signal}`
              : `codex exited with code ${result.exitCode}${result.stderr.trim() ? `: ${oneLine(result.stderr, 400)}` : ''}`;
      }
      // The contract promises a `failed` event for every failed turn, so one is
      // synthesized when the stream itself never said so — a kill, a silent
      // non-zero exit, a cancellation, a truncated stream.
      if (!ok && !events.some((event) => event.type === 'failed')) {
        emit(makeEvent('failed', options.role, { error: failure ?? 'codex failed' }));
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
        invocation: { command: this.binary, args },
      };
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      this.active.delete(handle);
      if (sessionId !== undefined) this.active.delete(sessionId);
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

async function readFileSafe(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}
