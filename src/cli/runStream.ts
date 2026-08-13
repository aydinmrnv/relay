import type { AgentEvent } from '../agents/types.ts';
import type { Role } from '../storage/config.ts';
import type { RunDisplay } from '../workflow/observer.ts';
import { phaseLabel, type Phase } from '../workflow/phases.ts';
import type { RunState } from '../workflow/state.ts';
import { emitJsonLine } from './json.ts';
import type { ExitCode } from './exit.ts';
import type { RunJson } from './runJson.ts';

/**
 * `relay run --json`: a stream, not a blob.
 *
 * A run takes ten to twenty minutes, so a single document at the end is the one
 * shape that is useless while it matters. This emits one JSON object per line
 * as each phase opens and closes, then a final summary object — which is what a
 * CI log wants, and what `events.jsonl` already looks like.
 *
 * The phases reported are the engine's own, not the folded checklist the
 * terminal draws: a plan revision is a phase the run entered and a reader is
 * entitled to see it, even though the dashboard keeps it in the review row.
 */

export interface PhaseStartedJson {
  type: 'phase_started';
  at: string;
  phase: Phase;
  phaseLabel: string;
  /** Round progress, e.g. `round 2/3`, when the phase has any. */
  detail: string | null;
}

export interface PhaseCompletedJson {
  type: 'phase_completed';
  at: string;
  phase: Phase;
  phaseLabel: string;
  durationMs: number;
  status: 'done' | 'failed';
}

export interface RunStartedJson {
  type: 'run_started';
  at: string;
  runId: string;
  shortId: string;
  issueRef: string;
  agents: Record<string, string>;
}

export interface RunNoteJson {
  type: 'note' | 'warning';
  at: string;
  message: string;
}

export interface AgentEventJson {
  type: 'agent_event';
  at: string;
  role: Role;
  event: AgentEvent;
}

export interface RunSummaryJson {
  type: 'summary';
  at: string;
  /** The code this invocation is about to exit with, stated in the stream itself. */
  exitCode: ExitCode;
  run: RunJson;
}

export type RunStreamLine =
  | RunStartedJson
  | PhaseStartedJson
  | PhaseCompletedJson
  | AgentEventJson
  | RunNoteJson
  | RunSummaryJson;

export interface RunJsonStreamOptions {
  state: RunState;
  /** `run` or `resume`, so a line says which command produced it. */
  command: string;
  /** Agent events are per-tool-call noise; `--verbose` is the opt-in. */
  verbose?: boolean;
  /** Injectable clock, so timestamps and durations are assertable in tests. */
  now?: () => Date;
  /** Injectable sink, so a test reads the lines without owning stdout. */
  write?: (line: RunStreamLine, command: string) => void;
}

export class RunJsonStream implements RunDisplay {
  private readonly options: RunJsonStreamOptions;
  private readonly now: () => Date;
  private active: { phase: Phase; startedAt: number } | undefined;

  constructor(options: RunJsonStreamOptions) {
    this.options = options;
    this.now = options.now ?? ((): Date => new Date());
  }

  start(): void {
    const state = this.options.state;
    this.emit({
      type: 'run_started',
      at: this.stamp(),
      runId: state.runId,
      shortId: state.shortId,
      issueRef: state.issueRef,
      agents: { ...state.config.agents },
    });
  }

  phaseChanged(phase: Phase, detail?: string): void {
    this.close('done');
    this.active = { phase, startedAt: this.now().getTime() };
    this.emit({
      type: 'phase_started',
      at: this.stamp(),
      phase,
      phaseLabel: phaseLabel(phase),
      detail: detail ?? null,
    });
  }

  /**
   * Deliberately silent. A role status is what the spinner says next to a phase
   * that has not finished — a redraw, not an event — and a stream of them would
   * bury the phase boundaries this format exists to report.
   */
  roleStatus(): void {}

  agentEvent(role: Role, event: AgentEvent): void {
    if (this.options.verbose !== true) return;
    this.emit({ type: 'agent_event', at: this.stamp(), role, event });
  }

  note(text: string): void {
    this.emit({ type: 'note', at: this.stamp(), message: text });
  }

  warn(text: string): void {
    this.emit({ type: 'warning', at: this.stamp(), message: text });
  }

  finish(finalPhase: Phase): void {
    this.close(finalPhase === 'COMPLETE' ? 'done' : 'failed');
  }

  /** The closing object: the whole run, and the code the command exits with. */
  summary(run: RunJson, exitCode: ExitCode): void {
    this.emit({ type: 'summary', at: this.stamp(), exitCode, run });
  }

  private close(status: 'done' | 'failed'): void {
    const active = this.active;
    if (active === undefined) return;
    this.active = undefined;
    this.emit({
      type: 'phase_completed',
      at: this.stamp(),
      phase: active.phase,
      phaseLabel: phaseLabel(active.phase),
      durationMs: Math.max(0, this.now().getTime() - active.startedAt),
      status,
    });
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  private emit(line: RunStreamLine): void {
    if (this.options.write !== undefined) {
      this.options.write(line, this.options.command);
      return;
    }
    emitJsonLine(this.options.command, line);
  }
}
