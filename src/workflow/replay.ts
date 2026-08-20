import type { AgentEvent } from '../agents/types.ts';
import type { LoggedEvent } from '../storage/runs.ts';
import type { Role } from '../storage/config.ts';
import type { RunObserver } from './observer.ts';

export function replayEvents(events: readonly LoggedEvent[], observer: RunObserver): void {
  for (const event of events) {
    if (event.type === 'phase_started') observer.phaseChanged(event.phase, event.message);
    else if (event.agent !== null && event.data !== undefined) {
      observer.agentEvent(event.agent as Role, { type: event.type, agent: event.agent, at: event.timestamp, ...event.data } as AgentEvent);
    } else if (['phase_failed', 'run_cancelled', 'budget_exceeded'].includes(event.type)) observer.warn(event.message ?? event.type);
    else if (event.message !== undefined) observer.note(event.message);
  }
}
