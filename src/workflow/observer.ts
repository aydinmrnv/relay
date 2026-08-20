import type { AgentEvent } from '../agents/types.ts';
import type { Role } from '../storage/config.ts';
import type { ReviewRound } from '../reviews/types.ts';
import type { Phase } from './phases.ts';

export interface TestStatusUpdate {
  phase: 'running' | 'passed' | 'failed' | 'skipped';
  concurrent?: boolean;
  detail?: string;
}

/**
 * How the engine reports progress. The engine never writes to stdout itself,
 * which keeps it usable from tests, `relay watch`, and any future non-terminal
 * front end.
 */
export interface RunObserver {
  phaseChanged(phase: Phase, detail?: string): void;
  roleStatus(role: Role, status: string): void;
  agentEvent(role: Role, event: AgentEvent): void;
  reviewCompleted(round: ReviewRound): void;
  testStatus(update: TestStatusUpdate): void;
  note(text: string): void;
  warn(text: string): void;
}

/**
 * An observer that also owns the beginning and end of a run's report.
 *
 * `relay run` picks one of these by how it was asked: the live dashboard for a
 * person, a stream of JSON lines for `--json`. Both watch the same engine
 * through the same interface, which is why neither needs a flag threaded
 * through the workflow.
 */
export interface RunDisplay extends RunObserver {
  start(): void;
  finish(finalPhase: Phase): void;
}

export const silentObserver: RunObserver = {
  phaseChanged() {},
  roleStatus() {},
  agentEvent() {},
  reviewCompleted() {},
  testStatus() {},
  note() {},
  warn() {},
};

/** Collects everything for assertions in tests. */
export class RecordingObserver implements RunObserver {
  readonly phases: Array<{ phase: Phase; detail?: string }> = [];
  readonly statuses: Array<{ role: Role; status: string }> = [];
  readonly events: Array<{ role: Role; event: AgentEvent }> = [];
  readonly reviews: ReviewRound[] = [];
  readonly testStatuses: TestStatusUpdate[] = [];
  readonly notes: string[] = [];
  readonly warnings: string[] = [];

  phaseChanged(phase: Phase, detail?: string): void {
    this.phases.push({ phase, ...(detail === undefined ? {} : { detail }) });
  }
  roleStatus(role: Role, status: string): void {
    this.statuses.push({ role, status });
  }
  agentEvent(role: Role, event: AgentEvent): void {
    this.events.push({ role, event });
  }
  reviewCompleted(round: ReviewRound): void { this.reviews.push(round); }
  testStatus(update: TestStatusUpdate): void { this.testStatuses.push(update); }
  note(text: string): void {
    this.notes.push(text);
  }
  warn(text: string): void {
    this.warnings.push(text);
  }
}
