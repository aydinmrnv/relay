import type { AgentEvent } from '../agents/types.ts';
import type { Role } from '../storage/config.ts';
import type { Phase } from '../workflow/phases.ts';
import { phaseRole } from '../workflow/phases.ts';
import type { RunObserver } from '../workflow/observer.ts';
import type { RunState } from '../workflow/state.ts';
import type { WakatimeTracker } from './wakatime.ts';

export class TrackingObserver implements RunObserver {
  private timer: NodeJS.Timeout | undefined;
  private readonly observer: RunObserver;
  private readonly tracker: WakatimeTracker;
  private readonly state: RunState;
  private readonly includeAgentPhases: boolean;

  constructor(
    observer: RunObserver,
    tracker: WakatimeTracker,
    state: RunState,
    includeAgentPhases: boolean,
  ) {
    this.observer = observer;
    this.tracker = tracker;
    this.state = state;
    this.includeAgentPhases = includeAgentPhases;
  }

  phaseChanged(phase: Phase, detail?: string): void {
    this.observer.phaseChanged(phase, detail);
    this.attempt(phase);
    if (this.timer === undefined) {
      this.timer = setInterval(() => this.attempt(this.state.phase), this.tracker.minimumIntervalMs);
      this.timer.unref?.();
    }
  }

  roleStatus(role: Role, status: string): void { this.observer.roleStatus(role, status); }
  agentEvent(role: Role, event: AgentEvent): void { this.observer.agentEvent(role, event); }
  note(text: string): void { this.observer.note(text); }
  warn(text: string): void { this.observer.warn(text); }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.tracker.stop();
  }

  private attempt(phase: Phase): void {
    if (!this.includeAgentPhases && phaseRole(phase) !== undefined) return;
    this.tracker.heartbeat();
  }
}
