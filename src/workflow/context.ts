import { AGENT_PROVIDERS } from '../agents/index.ts';
import type { AgentHarness } from '../agents/types.ts';
import { RelayError } from '../util/errors.ts';
import type { IssueProvider } from '../github/types.ts';
import type { AgentProvider, Role } from '../storage/config.ts';
import type { RunStore } from '../storage/runs.ts';
import type { RunObserver } from './observer.ts';
import type { RunState } from './state.ts';
import type { Phase } from './phases.ts';
import type { PrimingTask } from './priming.ts';
import type { BackgroundTestRun } from './backgroundTests.ts';
import type { Tracker } from '../tracking/tracker.ts';

export interface EngineContext {
  state: RunState;
  store: RunStore;
  /** Every installed harness, keyed by provider. Roles map onto these. */
  harnesses: Readonly<Record<AgentProvider, AgentHarness>>;
  issueProvider: IssueProvider;
  observer: RunObserver;
  signal: AbortSignal;
  /** Injected so retry backoff can be tested without waiting for it. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Cached issue markdown for the current run, loaded from disk on resume. */
  issueMarkdown?: string;
  /** Reviewers reading the repository ahead of the turn that will review it. */
  priming?: Partial<Record<Role, PrimingTask>>;
  /** The project's suite, running against the current diff while review happens. */
  backgroundTests?: BackgroundTestRun | undefined;
  /** Best-effort reporting of Relay's own orchestration activity. */
  tracker?: Tracker;
}

/** Outcome of a phase handler: the phase to move to, plus an optional note. */
export interface PhaseResult {
  next: Phase;
  note?: string;
}

export function harnessFor(context: EngineContext, role: Role): AgentHarness {
  const provider = providerNameFor(context, role);
  const harness = context.harnesses[provider];
  if (harness === undefined) {
    // Reachable when a run recorded a provider that is no longer registered,
    // e.g. state written by a build that shipped an extra harness.
    throw new RelayError(`No harness is registered for agent "${provider}" (role ${role}).`, {
      code: 'UNKNOWN_AGENT',
      hint: `Registered agents: ${AGENT_PROVIDERS.join(', ')}. Check .relay/config.json.`,
    });
  }
  return harness;
}

export function providerNameFor(context: EngineContext, role: Role): AgentProvider {
  return context.state.agents[role]?.provider ?? context.state.config.agents[role];
}
