import type {
  AgentHarness,
  AgentRunOptions,
  AgentSession,
  AvailabilityResult,
  ResumeOptions,
} from '../../src/agents/types.ts';
import { makeEvent } from '../../src/agents/types.ts';

export interface ScriptedTurn {
  /** Final message the fake agent returns. */
  text: string;
  ok?: boolean;
  error?: string;
  /** Side effect on the worktree, so `git diff` sees real changes. */
  effect?: (cwd: string) => Promise<void>;
}

export interface RecordedCall {
  role: string;
  prompt: string;
  capability: string;
  resumed: boolean;
  sessionId: string | undefined;
}

/**
 * Deterministic stand-in for a coding CLI.
 *
 * Scripted per role, so a workflow test can say exactly what the planner says,
 * what the reviewer objects to, and what the implementer writes — with no
 * network, no model, and no wall-clock dependence.
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
    this.calls.push({
      role: options.role,
      prompt: options.prompt,
      capability: options.capability,
      resumed,
      sessionId,
    });

    if (this.cancelled || options.signal?.aborted === true) {
      return this.session(options, sessionId, { ok: false, error: 'cancelled', aborted: true });
    }

    const queue = this.scripts.get(options.role);
    const turn = queue?.shift();

    if (turn === undefined) {
      return this.session(options, sessionId, {
        ok: false,
        error: `no scripted turn for role "${options.role}" (call ${this.calls.length})`,
      });
    }

    if (turn.effect !== undefined) await turn.effect(options.cwd);

    options.onEvent?.(makeEvent('started', options.role, { sessionId }));
    options.onEvent?.(makeEvent('message', options.role, { text: turn.text }));

    if (turn.ok === false) {
      options.onEvent?.(makeEvent('failed', options.role, { error: turn.error ?? 'scripted failure' }));
      return this.session(options, sessionId, { ok: false, error: turn.error ?? 'scripted failure' });
    }

    options.onEvent?.(makeEvent('completed', options.role, { result: turn.text }));
    return this.session(options, sessionId, { ok: true, text: turn.text });
  }

  private session(
    options: AgentRunOptions,
    sessionId: string,
    overrides: { ok: boolean; text?: string; error?: string; aborted?: boolean },
  ): AgentSession {
    return {
      provider: this.name,
      role: options.role,
      sessionId,
      ok: overrides.ok,
      text: overrides.text ?? '',
      events: [],
      ...(overrides.error === undefined ? {} : { error: overrides.error }),
      exitCode: overrides.ok ? 0 : 1,
      durationMs: 1,
      timedOut: false,
      aborted: overrides.aborted ?? false,
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
