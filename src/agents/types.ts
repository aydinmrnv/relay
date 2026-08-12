/**
 * Relay speaks in normalized agent events. Nothing outside `agents/` should
 * know what a Claude `stream-json` line or a Codex `item.completed` looks like:
 * adding a third CLI must mean adding one file here, not touching the engine.
 */
/**
 * What one agent turn consumed, as reported by the CLI that ran it.
 *
 * Relay never prices tokens itself: `costUsd` is present only when the harness
 * was told a cost, so a missing cost means "not reported", never "free".
 */
export interface AgentUsage {
  /** Every input token the turn was billed for, including cached reads. */
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export type AgentEvent =
  | { type: 'started'; agent: string; at: string; sessionId?: string }
  | { type: 'message'; agent: string; at: string; text: string }
  | { type: 'thinking'; agent: string; at: string; text: string }
  | { type: 'tool'; agent: string; at: string; tool: string; input?: unknown }
  | { type: 'command'; agent: string; at: string; command: string; exitCode?: number }
  | { type: 'file_changed'; agent: string; at: string; path: string; change?: string }
  // Usage rides on the terminal events because that is where both CLIs report
  // it — a turn that fails still spent tokens.
  | { type: 'completed'; agent: string; at: string; result?: string; usage?: AgentUsage }
  | { type: 'failed'; agent: string; at: string; error: string; usage?: AgentUsage }
  | { type: 'notice'; agent: string; at: string; text: string };

export type AgentEventType = AgentEvent['type'];

/**
 * What the agent is permitted to do in the worktree.
 * `read_only` is enforced by the underlying CLI (Codex's sandbox, Claude's tool
 * deny list) rather than by asking the model to behave.
 */
export type AgentCapability = 'read_only' | 'write';

export interface AgentRunOptions {
  /** Full prompt. Delivered on stdin, never as an argv entry or through a shell. */
  prompt: string;
  /** Working directory: always the run's isolated worktree. */
  cwd: string;
  /** Role label used in logs and the UI, e.g. `planner`. */
  role: string;
  capability: AgentCapability;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  /** JSON Schema for the final message, when the CLI supports enforcing one. */
  outputSchema?: Record<string, unknown>;
}

export type ResumeOptions = Omit<AgentRunOptions, 'prompt'>;

export interface AgentSession {
  provider: string;
  role: string;
  /** Present whenever the CLI exposed one; required to resume the conversation. */
  sessionId?: string;
  ok: boolean;
  /** The agent's final message — the artifact Relay parses. */
  text: string;
  events: AgentEvent[];
  error?: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  /** Present when the CLI reported token counts for this turn. */
  usage?: AgentUsage;
  /** Exact argv that was executed, for the audit trail. */
  invocation: { command: string; args: string[] };
}

export interface AvailabilityResult {
  available: boolean;
  /** Short status shown by `relay doctor`, e.g. `2.1.210`. */
  detail: string;
  version?: string;
  path?: string;
  hint?: string;
}

export interface AgentHarness {
  readonly name: string;

  checkAvailability(): Promise<AvailabilityResult>;

  start(options: AgentRunOptions): Promise<AgentSession>;

  /** Continues an existing conversation so context is not re-sent or lost. */
  resume(sessionId: string, prompt: string, options: ResumeOptions): Promise<AgentSession>;

  /** Terminates in-flight work for a session (or all work when omitted). */
  cancel(sessionId?: string): Promise<void>;
}

export function makeEvent<T extends AgentEvent['type']>(
  type: T,
  agent: string,
  rest: Omit<Extract<AgentEvent, { type: T }>, 'type' | 'agent' | 'at'>,
): AgentEvent {
  return { type, agent, at: new Date().toISOString(), ...rest } as AgentEvent;
}

/** One-line human summary of an event, used by the renderer and `relay logs`. */
export function describeEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'started':
      return `started${event.sessionId === undefined ? '' : ` (session ${event.sessionId.slice(0, 8)})`}`;
    case 'message':
      return event.text;
    case 'thinking':
      return `thinking: ${event.text}`;
    case 'tool':
      return `tool: ${event.tool}`;
    case 'command':
      return `$ ${event.command}${event.exitCode === undefined ? '' : ` → exit ${event.exitCode}`}`;
    case 'file_changed':
      return `${event.change ?? 'changed'}: ${event.path}`;
    case 'completed':
      return 'completed';
    case 'failed':
      return `failed: ${event.error}`;
    case 'notice':
      return event.text;
  }
}
