import { runProcess, resolveExecutable } from '../process/runner.ts';
import { parseJsonLine } from '../process/lines.ts';
import { RelayError } from '../util/errors.ts';
import { oneLine } from '../util/text.ts';
import type { HarnessOptions, HarnessRegistration } from './index.ts';
import type {
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
 * A coding CLI Relay has not packaged, described in `.relay/config.json`.
 *
 * The shape is deliberately narrow: an argv, a stream format, a field mapping,
 * and the two flag templates that matter. There is no shell, no interpolation
 * into a command string, and no eval — arguments are an array, and the only
 * substitution anywhere is the named `{sessionId}` inside `resume`. A CLI that
 * needs more than this deserves a real harness file and a registry row.
 */
export interface HarnessConfig {
  /** Executable name or path. Resolved on PATH; never handed to a shell. */
  command: string;
  /** Base argv for every turn, passed verbatim. */
  args: readonly string[];
  /** Prompts travel on stdin. This key exists to say so out loud. */
  promptOn: 'stdin';
  /** The only stream format supported: one JSON object per stdout line. */
  stream: 'jsonl';
  /**
   * Where in each stream line the interesting fields live, as `$.a.b` paths.
   * `text` is the agent's message (the last one seen is the final answer);
   * the rest are optional.
   */
  map: {
    text: string;
    sessionId?: string;
    usage?: string;
    error?: string;
  };
  /**
   * Extra argv for continuing a session. `{sessionId}` is replaced with the
   * id previously read via `map.sessionId` — the one substitution allowed.
   */
  resume?: readonly string[];
  /**
   * Extra argv that puts the CLI in a read-only mode. Without it the harness
   * refuses `read_only` turns, and config validation refuses the harness for
   * review roles: a reviewer that can edit what it reviews is not a reviewer.
   */
  readOnly?: readonly string[];
}

const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const FIELD_PATH_PATTERN = /^\$(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const DEF_KEYS = ['command', 'args', 'promptOn', 'stream', 'map', 'resume', 'readOnly'] as const;
const MAP_KEYS = ['text', 'sessionId', 'usage', 'error'] as const;

function bad(message: string): never {
  throw new RelayError(message, { code: 'BAD_CONFIG' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readFlagList(value: unknown, label: string, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((part) => typeof part !== 'string' || part.length === 0)) {
    bad(`config.harnesses.${name}.${label} must be a non-empty array of non-empty strings.`);
  }
  return value as string[];
}

function readFieldPath(value: unknown, label: string, name: string): string {
  if (typeof value !== 'string' || !FIELD_PATH_PATTERN.test(value)) {
    bad(`config.harnesses.${name}.map.${label} must be a "$.field" path, e.g. "$.message" or "$.result.text".`);
  }
  return value;
}

/**
 * Validates the `harnesses` block of `.relay/config.json`.
 *
 * Every mistake is refused loudly rather than defaulted: a silently dropped
 * `readOnly` (say, spelled `readonly`) would run a reviewer with write access,
 * which is exactly the failure this schema exists to make impossible.
 */
export function parseHarnessesConfig(raw: unknown, reservedNames: readonly string[]): Record<string, HarnessConfig> {
  if (!isRecord(raw)) bad('config.harnesses must be an object mapping harness names to definitions.');

  const harnesses: Record<string, HarnessConfig> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!NAME_PATTERN.test(name)) {
      bad(`config.harnesses: "${name}" is not a valid harness name (lowercase letters, digits, "-" and "_", starting with a letter).`);
    }
    if (reservedNames.includes(name)) {
      bad(`config.harnesses: "${name}" is reserved (it is a shipped agent or a role name). Pick another name.`);
    }
    harnesses[name] = parseHarnessDef(name, value);
  }
  return harnesses;
}

function parseHarnessDef(name: string, raw: unknown): HarnessConfig {
  if (!isRecord(raw)) bad(`config.harnesses.${name} must be an object.`);

  for (const key of Object.keys(raw)) {
    if (!(DEF_KEYS as readonly string[]).includes(key)) {
      bad(`config.harnesses.${name}: unknown key "${key}". Valid keys: ${DEF_KEYS.join(', ')}.`);
    }
  }

  const command = raw['command'];
  if (typeof command !== 'string' || command.trim().length === 0) {
    bad(`config.harnesses.${name}.command must be a non-empty string (an executable name or path).`);
  }

  const argsRaw = raw['args'] ?? [];
  if (!Array.isArray(argsRaw) || argsRaw.some((part) => typeof part !== 'string')) {
    bad(`config.harnesses.${name}.args must be an array of strings.`);
  }
  const args = argsRaw as string[];
  if (args.some((part) => part.includes('{sessionId}'))) {
    bad(`config.harnesses.${name}.args must not contain "{sessionId}" — substitution only happens in "resume".`);
  }

  if (raw['promptOn'] !== 'stdin') {
    bad(`config.harnesses.${name}.promptOn must be "stdin" — prompts are delivered on stdin, never as argv.`);
  }
  if (raw['stream'] !== 'jsonl') {
    bad(`config.harnesses.${name}.stream must be "jsonl" (one JSON object per stdout line).`);
  }

  const mapRaw = raw['map'];
  if (!isRecord(mapRaw)) bad(`config.harnesses.${name}.map must be an object with at least a "text" path.`);
  for (const key of Object.keys(mapRaw)) {
    if (!(MAP_KEYS as readonly string[]).includes(key)) {
      bad(`config.harnesses.${name}.map: unknown key "${key}". Valid keys: ${MAP_KEYS.join(', ')}.`);
    }
  }
  const map: HarnessConfig['map'] = { text: readFieldPath(mapRaw['text'], 'text', name) };
  if (mapRaw['sessionId'] !== undefined) map.sessionId = readFieldPath(mapRaw['sessionId'], 'sessionId', name);
  if (mapRaw['usage'] !== undefined) map.usage = readFieldPath(mapRaw['usage'], 'usage', name);
  if (mapRaw['error'] !== undefined) map.error = readFieldPath(mapRaw['error'], 'error', name);

  const def: HarnessConfig = { command, args, promptOn: 'stdin', stream: 'jsonl', map };

  if (raw['resume'] !== undefined) {
    const resume = readFlagList(raw['resume'], 'resume', name);
    if (!resume.some((part) => part.includes('{sessionId}'))) {
      bad(`config.harnesses.${name}.resume must contain "{sessionId}" somewhere, or the CLI is never told which session to continue.`);
    }
    if (map.sessionId === undefined) {
      bad(`config.harnesses.${name}.resume needs map.sessionId, so the id to substitute can be read from the stream.`);
    }
    def.resume = resume;
  }
  if (raw['readOnly'] !== undefined) {
    def.readOnly = readFlagList(raw['readOnly'], 'readOnly', name);
  }

  return def;
}

/** Reads a `$.a.b` path out of a parsed stream line. */
function readPath(record: Record<string, unknown>, path: string): unknown {
  let current: unknown = record;
  for (const segment of path.slice(2).split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function readPathString(record: Record<string, unknown>, path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const value = readPath(record, path);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Totals are summed into persisted run state, so a malformed count would
 * corrupt them for the life of the run. Anything but a whole, countable
 * number of tokens is dropped rather than folded in.
 */
function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Reads usage at the mapped path, accepting snake_case or camelCase keys. */
function readMappedUsage(record: Record<string, unknown>, path: string | undefined): AgentUsage | undefined {
  if (path === undefined) return undefined;
  const value = readPath(record, path);
  if (value === null || typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;

  const inputTokens = tokenCount(usage['input_tokens'] ?? usage['inputTokens']);
  const outputTokens = tokenCount(usage['output_tokens'] ?? usage['outputTokens']);
  const cost = usage['cost_usd'] ?? usage['costUsd'];
  const costUsd = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined;

  if (inputTokens === 0 && outputTokens === 0 && costUsd === undefined) return undefined;
  return { inputTokens, outputTokens, ...(costUsd === undefined ? {} : { costUsd }) };
}

export interface ConfigHarnessOptions {
  /** Overrides the configured command, e.g. for a test's fixture player. */
  binary?: string;
  defaultTimeoutMs?: number;
  /** Accepted for registry symmetry; the schema has no model flag to pass it to. */
  defaultModel?: string;
}

/**
 * Runs a config-defined CLI under the same contract as a shipped harness (the
 * prose above `AgentHarness` and the conformance suite both apply).
 *
 * Because the stream has no terminal event of its own, the exit status is the
 * whole verdict: exit 0 with a mapped final text is `completed`, anything else
 * is `failed`. A turn that cannot honor its options — `read_only` without
 * `readOnly` flags, `resume` without a `resume` template — is refused before
 * the process is spawned, as a failed session rather than a throw.
 */
export class ConfigHarness implements AgentHarness {
  readonly name: string;

  private readonly def: HarnessConfig;
  private readonly binary: string;
  private readonly defaultTimeoutMs: number;
  private readonly active = new Map<string, AbortController>();
  private handleCounter = 0;

  constructor(name: string, def: HarnessConfig, options: ConfigHarnessOptions = {}) {
    this.name = name;
    this.def = def;
    this.binary = options.binary ?? def.command;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30 * 60_000;
  }

  async checkAvailability(): Promise<AvailabilityResult> {
    const path = await resolveExecutable(this.binary);
    if (path === null) {
      return {
        available: false,
        detail: 'not found',
        hint: `\`${this.binary}\` (config harness "${this.name}") was not found.\n\nInstall it and make sure it is on your PATH, then run:\n\n  relay doctor`,
      };
    }
    // The schema declares no version flag, so the path is the whole answer.
    return { available: true, detail: path, path };
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

  /** A turn refused before its process exists: failed, resolved, never thrown. */
  private refuse(options: AgentRunOptions, error: string): AgentSession {
    const event = makeEvent('failed', options.role, { error });
    options.onEvent?.(event);
    return {
      provider: this.name,
      role: options.role,
      ok: false,
      text: '',
      events: [event],
      error,
      exitCode: null,
      durationMs: 0,
      timedOut: false,
      aborted: false,
      invocation: { command: this.binary, args: [] },
    };
  }

  private async execute(options: AgentRunOptions, resumeSessionId: string | undefined): Promise<AgentSession> {
    if (options.capability === 'read_only' && this.def.readOnly === undefined) {
      return this.refuse(
        options,
        `harness "${this.name}" defines no readOnly flags, so a read-only turn cannot be enforced — refusing to run it with write access. Add "readOnly" to harnesses.${this.name} in .relay/config.json.`,
      );
    }
    if (resumeSessionId !== undefined && this.def.resume === undefined) {
      return this.refuse(
        options,
        `harness "${this.name}" defines no resume flags, so session ${resumeSessionId} cannot be continued.`,
      );
    }

    const args = [...this.def.args];
    if (resumeSessionId !== undefined && this.def.resume !== undefined) {
      // The one substitution in the whole schema: a named id into an argv
      // entry that declared a place for it. Never into a command string.
      args.push(...this.def.resume.map((part) => part.replaceAll('{sessionId}', resumeSessionId)));
    }
    if (options.capability === 'read_only' && this.def.readOnly !== undefined) {
      args.push(...this.def.readOnly);
    }

    // The session id arrives (if ever) somewhere in the stream, so in-flight
    // work is tracked under a local handle as well as the eventual id.
    const handle = resumeSessionId ?? `${this.name}-pending-${(this.handleCounter += 1)}`;
    const controller = new AbortController();
    this.active.set(handle, controller);
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const events: AgentEvent[] = [];
    let sessionId = resumeSessionId;
    let finalText = '';
    let failure: string | undefined;
    let usage: AgentUsage | undefined;
    let sawJson = false;

    const emit = (event: AgentEvent): void => {
      events.push(event);
      options.onEvent?.(event);
      if (event.type === 'failed') failure = event.error;
    };

    // The process starting is the conversation starting: this stream format
    // has no init event, so the harness supplies the `started` itself.
    emit(makeEvent('started', options.role, sessionId === undefined ? {} : { sessionId }));

    const startedAt = Date.now();
    try {
      let result;
      try {
        result = await runProcess(this.binary, args, {
          cwd: options.cwd,
          // The prompt goes over stdin: no argv length limit, no quoting, and
          // nothing derived from an issue or an agent ever reaches a shell.
          stdin: options.prompt,
          timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
          signal: controller.signal,
          env: { NO_COLOR: '1' },
          onStdoutLine: (line) => {
            const parsed = parseJsonLine(line);
            if (parsed === undefined) return;
            sawJson = true;

            const sid = readPathString(parsed, this.def.map.sessionId);
            if (sid !== undefined) {
              sessionId = sid;
              this.active.set(sid, controller);
            }
            const mappedUsage = readMappedUsage(parsed, this.def.map.usage);
            if (mappedUsage !== undefined) usage = mappedUsage;

            const error = readPathString(parsed, this.def.map.error);
            if (error !== undefined) emit(makeEvent('failed', options.role, { error }));

            const text = readPathString(parsed, this.def.map.text);
            if (text !== undefined && text.trim().length > 0) {
              finalText = text;
              emit(makeEvent('message', options.role, { text }));
            }
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
        return this.session(options, args, {
          ok: false,
          text: finalText,
          events,
          error: failure,
          exitCode: null,
          durationMs: Date.now() - startedAt,
          timedOut: false,
          aborted: false,
          sessionId,
          usage,
        });
      }

      // The exit status is the whole verdict for this stream format, and the
      // final text is the artifact Relay exists to collect: exit 0 without one
      // is a malformed stream, not a quiet success.
      if (result.ok && failure === undefined && finalText.trim().length === 0) {
        failure = sawJson
          ? `${this.name} exited without a final message (map.text "${this.def.map.text}" matched no line)`
          : `${this.name} produced no parseable jsonl output — its stream was malformed or truncated`;
      }
      const ok = result.ok && failure === undefined;
      if (!ok && failure === undefined) {
        failure = result.timedOut
          ? `${this.name} timed out after ${Math.round((options.timeoutMs ?? this.defaultTimeoutMs) / 1000)}s`
          : result.aborted
            ? `${this.name} was cancelled`
            : result.signal !== null
              ? `${this.name} was killed by ${result.signal}`
              : `${this.name} exited with code ${result.exitCode}${result.stderr.trim() ? `: ${oneLine(result.stderr, 400)}` : ''}`;
      }
      if (ok) {
        emit(makeEvent('completed', options.role, { result: finalText, ...(usage === undefined ? {} : { usage }) }));
      } else if (!events.some((event) => event.type === 'failed')) {
        emit(makeEvent('failed', options.role, { error: failure ?? `${this.name} failed` }));
      }

      return this.session(options, args, {
        ok,
        text: finalText,
        events,
        error: ok ? undefined : failure,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        aborted: result.aborted,
        sessionId,
        usage,
      });
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      this.active.delete(handle);
      if (sessionId !== undefined) this.active.delete(sessionId);
    }
  }

  private session(
    options: AgentRunOptions,
    args: string[],
    fields: {
      ok: boolean;
      text: string;
      events: AgentEvent[];
      error: string | undefined;
      exitCode: number | null;
      durationMs: number;
      timedOut: boolean;
      aborted: boolean;
      sessionId: string | undefined;
      usage: AgentUsage | undefined;
    },
  ): AgentSession {
    return {
      provider: this.name,
      role: options.role,
      ...(fields.sessionId === undefined ? {} : { sessionId: fields.sessionId }),
      ok: fields.ok,
      text: fields.text,
      events: fields.events,
      ...(fields.error === undefined ? {} : { error: fields.error }),
      exitCode: fields.exitCode,
      durationMs: fields.durationMs,
      timedOut: fields.timedOut,
      aborted: fields.aborted,
      ...(fields.usage === undefined ? {} : { usage: fields.usage }),
      invocation: { command: this.binary, args },
    };
  }
}

/**
 * Registry rows for the harnesses a repository defined itself, so `relay
 * doctor`, `relay init` and `createCliContext` treat them exactly like shipped
 * CLIs. Auth has no status probe — Relay has no idea how this CLI signs in —
 * so its state reports as unknown rather than guessed.
 */
export function configHarnessRegistrations(
  harnesses: Readonly<Record<string, HarnessConfig>> | undefined,
): HarnessRegistration[] {
  return Object.entries(harnesses ?? {}).map(([name, def]) => ({
    name,
    label: `${name} (config)`,
    coAuthor: { name, email: 'noreply@localhost' },
    installCommand: `# install ${def.command} and put it on your PATH`,
    auth: { login: { command: def.command, args: [] } },
    enforcesReadOnly: def.readOnly !== undefined,
    create: (options: HarnessOptions) => new ConfigHarness(name, def, options),
  }));
}
