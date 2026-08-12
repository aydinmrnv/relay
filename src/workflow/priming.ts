import { setTimeout } from 'node:timers/promises';

import { errorMessage } from '../util/errors.ts';
import type { AgentCapability } from '../agents/types.ts';
import type { Role } from '../storage/config.ts';
import { runAgentTurn } from './agentRunner.ts';
import { providerNameFor, type EngineContext } from './context.ts';
import type { Phase } from './phases.ts';

/** A reviewer reading the repository while the work it will review is produced. */
export interface PrimingTask {
  role: Role;
  /** Resolves to whether the reviewer ended up with a session worth resuming. */
  promise: Promise<boolean>;
  controller: AbortController;
}

export interface StartPrimingOptions {
  role: Role;
  prompt: string;
  /** Phase the primed turn's events and tokens are attributed to. */
  phase: Phase;
  capability?: AgentCapability;
}

/**
 * Starts a reviewer's turn *now*, during the phase whose output it will review.
 *
 * Most of a review turn is not judgement, it is reading: opening the files the
 * issue touches to know what correct looks like. That reading does not depend
 * on the artifact under review, so it does not have to wait for it. Priming
 * moves it off the critical path — the reviewer reads while the planner plans
 * or the implementer writes code — and the review turn then resumes that same
 * session with the artifact, already knowing the codebase.
 *
 * The reviewer is deliberately primed on the issue rather than on the artifact:
 * it forms its own view first, which is the opposite of anchoring it.
 *
 * Speculative work must never take a run down, so a priming turn that fails,
 * times out or is cancelled is recorded and forgotten: the review then runs
 * cold, exactly as it did before.
 */
export function startPriming(context: EngineContext, options: StartPrimingOptions): void {
  const { state, observer } = context;
  if (!state.config.workflow.primeReviewers) return;

  const tasks = (context.priming ??= {});
  if (tasks[options.role] !== undefined) return;
  // Nothing to prime when the reviewer already holds a session for this run:
  // resuming it is cheaper than any fresh reading could be.
  if (state.agents[options.role]?.sessionId !== undefined) return;

  const controller = new AbortController();
  const signal = AbortSignal.any([context.signal, controller.signal]);
  const provider = providerNameFor(context, options.role);

  observer.note(`${provider} (${options.role}) is reading the repository in parallel, so its review does not have to.`);

  const promise = (async (): Promise<boolean> => {
    try {
      const session = await runAgentTurn(
        { ...context, signal },
        {
          role: options.role,
          prompt: options.prompt,
          capability: options.capability ?? 'read_only',
          timeoutMs: state.config.timeouts.primingMs,
          phase: options.phase,
          purpose: 'prime',
        },
      );
      return session.sessionId !== undefined;
    } catch (error) {
      // Drop the session: a turn that died part-way is not context worth
      // resuming, and a cold review is the correct fallback.
      delete state.agents[options.role]?.sessionId;
      observer.note(`${provider} (${options.role}) could not read ahead (${errorMessage(error)}); it will read during its review.`);
      return false;
    }
  })();

  tasks[options.role] = { role: options.role, promise, controller };
}

/**
 * Waits for a reviewer's read-ahead to land before its review turn starts.
 * Returns whether the review can resume a primed session.
 *
 * The wait is bounded by `timeouts.primeGraceMs`. Past that point the
 * optimisation has inverted: reading early was supposed to save the review
 * time, not spend the run's. A reviewer still reading when its turn arrives is
 * abandoned, and the review starts cold — which is what every review did
 * before any of this existed.
 */
export async function awaitPriming(context: EngineContext, role: Role): Promise<boolean> {
  const task = context.priming?.[role];
  if (task === undefined) return context.state.agents[role]?.sessionId !== undefined;

  delete context.priming?.[role];

  const grace = new AbortController();
  const landed = await Promise.race([
    task.promise.then((primed) => ({ primed })),
    setTimeout(context.state.config.timeouts.primeGraceMs, undefined, { signal: grace.signal, ref: false })
      .then(() => undefined)
      .catch(() => undefined),
  ]);
  grace.abort();

  if (landed !== undefined) return landed.primed;

  context.observer.note(
    `${providerNameFor(context, role)} (${role}) was still reading when its review came up; reviewing without it.`,
  );
  task.controller.abort();
  await task.promise.catch(() => undefined);
  // Abandoned means abandoned: a half-finished reading is not context to
  // resume into, whatever the CLI made of being killed.
  delete context.state.agents[role]?.sessionId;
  return false;
}

/**
 * Cancels every read-ahead still in flight and waits for the processes to die.
 * A run that ends must not leave an agent running against its worktree.
 */
export async function cancelPriming(context: EngineContext): Promise<void> {
  const tasks = context.priming;
  if (tasks === undefined) return;

  const pending = Object.values(tasks).filter((task): task is PrimingTask => task !== undefined);
  context.priming = {};

  for (const task of pending) task.controller.abort();
  await Promise.allSettled(pending.map((task) => task.promise));
}
