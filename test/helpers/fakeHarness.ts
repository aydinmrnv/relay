import type {
  AgentEvent,
  AgentHarness,
  AgentRunOptions,
  AgentSession,
  AgentUsage,
  AvailabilityResult,
  ResumeOptions,
} from '../../src/agents/types.ts';
import { makeEvent } from '../../src/agents/types.ts';

export interface ScriptedTurn {
  /** Final message the fake agent returns. */
  text: string;
  ok?: boolean;
  error?: string;
  /** Set false for a turn that dies before the CLI reports a live session. */
  started?: boolean;
  /** Side effect on the worktree, so `git diff` sees real changes. */
  effect?: (cwd: string) => Promise<void>;
  /** Token counts this turn reports, as a real CLI would. */
  usage?: AgentUsage;
}

export interface RecordedCall {
  role: string;
  prompt: string;
  capability: string;
  resumed: boolean;
  sessionId: string | undefined;
  /** `prime` for a reviewer reading ahead; absent for the work itself. */
  purpose?: string;
}

/**
 * Deterministic stand-in for a coding CLI.
 *
 * Scripted per role, so a workflow test can say exactly what the planner says,
 * what the reviewer objects to, and what the implementer writes — with no
 * network, no model, and no wall-clock dependence.
 *
 * Turns with a purpose are scripted under `role:purpose` (`planReviewer:prime`).
 * An unscripted priming turn succeeds with no output rather than failing: it is
 * speculative reading whose content no assertion depends on, and requiring
 * every test to script one would say nothing about the behaviour under test.
 */
export class FakeAgentHarness implements AgentHarness {
  readonly name: string;
  readonly calls: RecordedCall[] = [];

  private readonly scripts = new Map<string, ScriptedTurn[]>();
  private readonly sessions = new Map<string, string>();
  private available: AvailabilityResult = { available: true, detail: 'fake' };
  private counter = 0;
  private cancelled = false;

  constructor(name: string, scripts: Record<string, ScriptedTurn[]> = {}) {
    this.name = name;
    for (const [role, turns] of Object.entries(scripts)) this.scripts.set(role, [...turns]);
  }

  /** Queues additional turns for a role. */
  script(role: string, ...turns: ScriptedTurn[]): this {
    const existing = this.scripts.get(role) ?? [];
    this.scripts.set(role, [...existing, ...turns]);
    return this;
  }

  setAvailability(result: AvailabilityResult): this {
    this.available = result;
    return this;
  }

  async checkAvailability(): Promise<AvailabilityResult> {
    return this.available;
  }

  async start(options: AgentRunOptions): Promise<AgentSession> {
    const sessionId = `${this.name}-${options.role}-${(this.counter += 1)}`;
    this.sessions.set(options.role, sessionId);
    return this.execute(options, sessionId, false);
  }

  async resume(sessionId: string, prompt: string, options: ResumeOptions): Promise<AgentSession> {
    return this.execute({ ...options, prompt }, sessionId, true);
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }

  private async execute(options: AgentRunOptions, sessionId: string, resumed: boolean): Promise<AgentSession> {
    const key = options.purpose === undefined ? options.role : `${options.role}:${options.purpose}`;

    this.calls.push({
      role: options.role,
      prompt: options.prompt,
      capability: options.capability,
      resumed,
      sessionId,
      ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
    });

    if (this.cancelled || options.signal?.aborted === true) {
      return this.session(options, sessionId, { ok: false, error: 'cancelled', aborted: true });
    }

    const queue = this.scripts.get(key);
    const turn = queue?.shift() ?? (options.purpose === 'prime' ? { text: '' } : undefined);

    if (turn === undefined) {
      return this.session(options, sessionId, {
        ok: false,
        error: `no scripted turn for "${key}" (call ${this.calls.length})`,
      });
    }

    if (turn.effect !== undefined) await turn.effect(options.cwd);

    const billing = turn.usage === undefined ? {} : { usage: turn.usage };
    // Events are both streamed and retained, as the real harnesses do: whether a
    // failed turn can be resumed is decided from what it managed to emit.
    const events: AgentEvent[] = [];
    const emit = (event: AgentEvent): void => {
      events.push(event);
      options.onEvent?.(event);
    };

    if (turn.started !== false) emit(makeEvent('started', options.role, { sessionId }));
    if (turn.text.length > 0) emit(makeEvent('message', options.role, { text: turn.text }));

    if (turn.ok === false) {
      emit(makeEvent('failed', options.role, { error: turn.error ?? 'scripted failure', ...billing }));
      return this.session(options, sessionId, { ok: false, error: turn.error ?? 'scripted failure', events, ...billing });
    }

    emit(makeEvent('completed', options.role, { result: turn.text, ...billing }));
    return this.session(options, sessionId, { ok: true, text: turn.text, events, ...billing });
  }

  private session(
    options: AgentRunOptions,
    sessionId: string,
    overrides: {
      ok: boolean;
      text?: string;
      error?: string;
      aborted?: boolean;
      usage?: AgentUsage;
      events?: AgentEvent[];
    },
  ): AgentSession {
    return {
      provider: this.name,
      role: options.role,
      sessionId,
      ok: overrides.ok,
      text: overrides.text ?? '',
      events: overrides.events ?? [],
      ...(overrides.error === undefined ? {} : { error: overrides.error }),
      exitCode: overrides.ok ? 0 : 1,
      durationMs: 1,
      timedOut: false,
      aborted: overrides.aborted ?? false,
      ...(overrides.usage === undefined ? {} : { usage: overrides.usage }),
      invocation: { command: this.name, args: ['--fake'] },
    };
  }
}

/** Wraps text in the delimited-section protocol the real agents must follow. */
export function section(name: string, body: string): string {
  return `===RELAY:BEGIN ${name}===\n${body}\n===RELAY:END ${name}===`;
}

export function planText(summary = 'Add the thing'): string {
  return section(
    'PLAN',
    ['## Summary', summary, '', '## Implementation approach', '1. Edit src/app.ts', '', '## Tests required', 'unit test'].join('\n'),
  );
}

export function approveReview(summary = 'Looks correct.'): string {
  return section('REVIEW', JSON.stringify({ decision: 'approve', summary, findings: [] }));
}

export function requestChangesReview(
  findings: Array<Record<string, unknown>>,
  summary = 'Needs work.',
): string {
  return section('REVIEW', JSON.stringify({ decision: 'request_changes', summary, findings }));
}

export function responsesText(
  responses: Array<{ findingId: string; response: string; reasoning: string }>,
  plan?: string,
): string {
  const parts = [section('RESPONSES', JSON.stringify({ responses }))];
  if (plan !== undefined) parts.push(section('PLAN', plan));
  return parts.join('\n\n');
}
