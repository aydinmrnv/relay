import { RelayError, errorMessage, isRelayError } from '../util/errors.ts';
import { RUN_FILES } from '../storage/runs.ts';
import { commitRunWork } from './commitRun.ts';
import { cancelBackgroundTests } from './backgroundTests.ts';
import { cancelPriming } from './priming.ts';
import { isTerminal, phaseLabel, type Phase } from './phases.ts';
import { transition, type RunState } from './state.ts';
import { renderSummary } from './summary.ts';
import type { EngineContext, PhaseResult } from './context.ts';
import { creatingWorkspace, fetchingIssue, initializing } from './phases/setup.ts';
import { planning, reviewingPlan, revisingPlan } from './phases/planning.ts';
import { implementing, reviewingCode, revisingCode } from './phases/implementation.ts';
import { testing } from './phases/testing.ts';

type PhaseHandler = (context: EngineContext) => Promise<PhaseResult>;

/**
 * One handler per non-terminal phase. Adding a phase means adding a row here
 * and an edge in the transition table — there is no place for workflow logic to
 * hide in a conditional somewhere else.
 */
const HANDLERS: Partial<Record<Phase, PhaseHandler>> = {
  INITIALIZING: initializing,
  FETCHING_ISSUE: fetchingIssue,
  CREATING_WORKSPACE: creatingWorkspace,
  PLANNING: planning,
  REVIEWING_PLAN: reviewingPlan,
  REVISING_PLAN: revisingPlan,
  IMPLEMENTING: implementing,
  REVIEWING_CODE: reviewingCode,
  REVISING_CODE: revisingCode,
  TESTING: testing,
};

/**
 * Drives the state machine. Every iteration persists state before and after the
 * phase runs, so an interrupted run resumes from the last completed phase
 * rather than from the beginning.
 */
export class WorkflowEngine {
  private readonly context: EngineContext;

  constructor(context: EngineContext) {
    this.context = context;
  }

  get state(): RunState {
    return this.context.state;
  }

  async run(): Promise<RunState> {
    const { state, store, observer } = this.context;

    state.pid = process.pid;
    await store.init();
    await store.clearCancel();
    await store.saveState(state);

    try {
      while (!isTerminal(state.phase)) {
        if (await this.shouldCancel()) {
          await this.finish('CANCELLED', 'cancelled by user');
          break;
        }

        const handler = HANDLERS[state.phase];
        if (handler === undefined) {
          await this.fail(new RelayError(`No handler for phase ${state.phase}.`, { code: 'NO_HANDLER' }));
          break;
        }

        observer.phaseChanged(state.phase, roundDetail(state));
        await this.logPhase('phase_started');

        try {
          const result = await handler(this.context);
          await this.logPhase('phase_completed', result.note);
          transition(state, result.next, result.note === undefined ? {} : { note: result.note });
          await store.saveState(state);
        } catch (error) {
          if (this.context.signal.aborted || isCancellation(error)) {
            await this.finish('CANCELLED', 'cancelled');
          } else {
            await this.fail(error);
          }
          break;
        }
      }
    } finally {
      // Speculative work — a reviewer reading ahead, a suite running against the
      // diff — outlives the phase that started it by design. A run that is over,
      // however it ended, must not leave either of them alive in its worktree.
      await cancelPriming(this.context);
      await cancelBackgroundTests(this.context);
    }

    // Opt-in, and only for a run that finished: a commit is how completed work
    // stops being a staged index nobody would notice losing.
    if (state.phase === 'COMPLETE' && state.config.workflow.commit) {
      await commitRunWork(this.context);
    }

    await this.writeSummary();
    delete state.pid;
    await store.saveState(state);
    return state;
  }

  private async shouldCancel(): Promise<boolean> {
    return this.context.signal.aborted || (await this.context.store.cancelRequested());
  }

  private async logPhase(type: string, note?: string): Promise<void> {
    await this.context.store.logEvent({
      timestamp: new Date().toISOString(),
      runId: this.state.runId,
      phase: this.state.phase,
      agent: null,
      type,
      ...(note === undefined ? {} : { message: note }),
    });
  }

  private async finish(phase: 'CANCELLED', note: string): Promise<void> {
    const { state, store, observer } = this.context;
    transition(state, phase, { note });
    observer.warn(`Run ${phase.toLowerCase()}. Work so far is preserved on ${state.workspace?.branch ?? 'its branch'}.`);
    await this.logPhase('run_cancelled', note);
    await store.saveState(state);
  }

  private async fail(error: unknown): Promise<void> {
    const { state, store, observer } = this.context;
    const message = errorMessage(error);

    state.error = {
      message,
      phase: state.phase,
      ...(isRelayError(error) ? { code: error.code } : {}),
    };

    await this.logPhase('phase_failed', message);
    transition(state, 'FAILED', { note: message });

    observer.warn(`Failed during ${phaseLabel(state.error.phase)}: ${message}`);
    if (isRelayError(error) && error.hint !== undefined) observer.note(error.hint);

    await store.saveState(state);
  }

  private async writeSummary(): Promise<void> {
    try {
      await this.context.store.writeArtifact(RUN_FILES.summary, renderSummary(this.state));
    } catch (error) {
      // A summary that cannot be written must not mask the run's real outcome.
      this.context.observer.warn(`Could not write summary.md: ${errorMessage(error)}`);
    }
  }
}

/**
 * Round progress for the phase about to run. Plan review can consume three
 * rounds and code review two; a display that only ever says "revising" hides a
 * limit while it is being spent.
 *
 * The counters hold *completed* rounds, so the round about to start is one more.
 */
function roundDetail(state: RunState): string | undefined {
  const { maxPlanReviewRounds, maxCodeReviewRounds } = state.config.workflow;
  switch (state.phase) {
    case 'REVIEWING_PLAN':
      return `round ${state.rounds.planReview + 1}/${maxPlanReviewRounds}`;
    case 'REVISING_PLAN':
      return `revising · round ${state.rounds.planReview}/${maxPlanReviewRounds}`;
    case 'REVIEWING_CODE':
      return `round ${state.rounds.codeReview + 1}/${maxCodeReviewRounds}`;
    case 'REVISING_CODE':
      return `revising · round ${state.rounds.codeReview}/${maxCodeReviewRounds}`;
    default:
      return undefined;
  }
}

function isCancellation(error: unknown): boolean {
  if (!isRelayError(error)) return false;
  return error.code === 'AGENT_CANCELLED';
}
