import { RelayError } from '../util/errors.ts';
import { oneLine } from '../util/text.ts';
import { buildRepairPrompt } from '../agents/prompts.ts';
import type { AgentCapability, AgentEvent, AgentSession } from '../agents/types.ts';
import type { Role } from '../storage/config.ts';
import type { ParseResult } from '../reviews/parse.ts';
import { harnessFor, providerNameFor, type EngineContext } from './context.ts';
import { recordAgentSession } from './state.ts';

export interface AgentTurnOptions {
  role: Role;
  prompt: string;
  capability: AgentCapability;
  timeoutMs: number;
  /** Continue the role's existing session when one exists. */
  resume?: boolean;
  outputSchema?: Record<string, unknown>;
}

/**
 * Runs one agent turn: streams normalized events into the observer and the
 * audit log, persists the session id for resume, and treats a non-zero exit as
 * a failure regardless of what the agent said.
 */
export async function runAgentTurn(context: EngineContext, options: AgentTurnOptions): Promise<AgentSession> {
  const { state, store, observer, signal } = context;
  const harness = harnessFor(context, options.role);
  const provider = providerNameFor(context, options.role);
  const workspace = state.workspace;

  if (workspace === undefined) {
    throw new RelayError('No workspace has been created for this run yet.', { code: 'NO_WORKSPACE' });
  }

  const pending: Array<Promise<void>> = [];
  const onEvent = (event: AgentEvent): void => {
    observer.agentEvent(options.role, event);
    // Log writes are fire-and-forget during streaming and awaited before the
    // turn returns, so a slow disk never stalls the agent's output.
    pending.push(store.logAgentEvent(state.phase, event, { role: options.role, provider }));
  };

  const existingSessionId = state.agents[options.role]?.sessionId;
  const shouldResume = options.resume === true && existingSessionId !== undefined;

  observer.roleStatus(options.role, shouldResume ? 'resuming' : 'running');

  const runOptions = {
    prompt: options.prompt,
    cwd: workspace.path,
    role: options.role,
    capability: options.capability,
    timeoutMs: options.timeoutMs,
    signal,
    onEvent,
    ...(state.config.models[provider] === undefined ? {} : { model: state.config.models[provider]! }),
    ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
  };

  let session: AgentSession;
  try {
    session = shouldResume
      ? await harness.resume(existingSessionId, options.prompt, runOptions)
      : await harness.start(runOptions);
  } finally {
    await Promise.allSettled(pending);
  }

  recordAgentSession(state, options.role, session.sessionId);

  await store.logEvent({
    timestamp: new Date().toISOString(),
    runId: state.runId,
    phase: state.phase,
    agent: options.role,
    type: session.ok ? 'turn_completed' : 'turn_failed',
    ...(session.ok || session.error === undefined ? {} : { message: session.error }),
    data: {
      provider,
      resumed: shouldResume,
      sessionId: session.sessionId,
      exitCode: session.exitCode,
      durationMs: session.durationMs,
      // The exact argv is part of the audit trail; it contains no secrets.
      invocation: `${session.invocation.command} ${session.invocation.args.join(' ')}`,
    },
  });

  if (!session.ok) {
    observer.roleStatus(options.role, 'failed');
    throw new RelayError(`${provider} (${options.role}) failed: ${session.error ?? 'unknown error'}`, {
      code: session.timedOut ? 'AGENT_TIMEOUT' : session.aborted ? 'AGENT_CANCELLED' : 'AGENT_FAILED',
      ...(session.aborted || session.timedOut
        ? {}
        : { hint: `Inspect ${store.path('events.jsonl')} for the full transcript, then \`relay resume ${state.runId}\`.` }),
    });
  }

  if (session.text.trim().length === 0) {
    observer.warn(`${provider} (${options.role}) produced no final message.`);
  }

  observer.roleStatus(options.role, 'complete');
  return session;
}

export interface StructuredTurnOptions<T> extends AgentTurnOptions {
  parse: (text: string) => ParseResult<T>;
  /** Format reminder sent if the first attempt does not parse. */
  expectation: string;
}

export interface StructuredResult<T> {
  value: T;
  session: AgentSession;
  /** Raw final text of the turn that produced the value. */
  text: string;
  repaired: boolean;
}

/**
 * Runs a turn that must produce a machine-readable artifact.
 *
 * Agent output is untrusted, so a malformed response is expected rather than
 * exceptional: Relay resumes the same session once with a format reminder,
 * which keeps all the work in context instead of re-running the whole turn.
 */
export async function runStructuredTurn<T>(
  context: EngineContext,
  options: StructuredTurnOptions<T>,
): Promise<StructuredResult<T>> {
  const session = await runAgentTurn(context, options);
  const parsed = options.parse(session.text);

  if (parsed.ok) {
    reportWarnings(context, options.role, parsed.warnings);
    return { value: parsed.value, session, text: session.text, repaired: false };
  }

  context.observer.warn(
    `${providerNameFor(context, options.role)} (${options.role}) returned unparseable output: ${parsed.error} — asking it to re-send.`,
  );
  await context.store.logEvent({
    timestamp: new Date().toISOString(),
    runId: context.state.runId,
    phase: context.state.phase,
    agent: options.role,
    type: 'parse_failed',
    message: parsed.error,
    data: { attempt: 1, rawFinalMessage: oneLine(session.text, 2000) },
  });

  if (session.sessionId === undefined) {
    throw new RelayError(
      `${options.role} produced unparseable output and its session cannot be resumed: ${parsed.error}`,
      { code: 'STRUCTURED_OUTPUT_FAILED' },
    );
  }

  const repairSession = await runAgentTurn(context, {
    ...options,
    prompt: buildRepairPrompt(options.expectation, parsed.error),
    resume: true,
  });

  const repairedParse = options.parse(repairSession.text);
  if (!repairedParse.ok) {
    await context.store.logEvent({
      timestamp: new Date().toISOString(),
      runId: context.state.runId,
      phase: context.state.phase,
      agent: options.role,
      type: 'parse_failed',
      message: repairedParse.error,
      data: { attempt: 2, rawFinalMessage: oneLine(repairSession.text, 2000) },
    });
    throw new RelayError(
      `${options.role} could not produce parseable output after a retry: ${repairedParse.error}`,
      {
        code: 'STRUCTURED_OUTPUT_FAILED',
        hint: `The raw responses are in ${context.store.path('events.jsonl')}.`,
      },
    );
  }

  reportWarnings(context, options.role, repairedParse.warnings);
  return { value: repairedParse.value, session: repairSession, text: repairSession.text, repaired: true };
}

function reportWarnings(context: EngineContext, role: Role, warnings: readonly string[]): void {
  for (const warning of warnings) {
    context.observer.warn(`${role}: ${warning}`);
  }
}
