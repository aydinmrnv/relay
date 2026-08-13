import { basename } from 'node:path';

import type { TrackingConfig } from '../storage/config.ts';
import type { RunStore } from '../storage/runs.ts';
import { packageVersion } from '../update/installation.ts';
import { errorMessage } from '../util/errors.ts';
import type { RunObserver } from '../workflow/observer.ts';
import { phaseRole, type Phase } from '../workflow/phases.ts';
import type { RunState } from '../workflow/state.ts';
import {
  buildHeartbeatArgs,
  defaultProcessRunner,
  resolveWakaTimeCli,
  sendHeartbeat,
  type ExecutableResolver,
  type ProcessRunner,
} from './wakatime.ts';

const RATE_WINDOW_MS = 30_000;

export interface RunTrackerDependencies {
  runner?: ProcessRunner;
  resolveExecutable?: ExecutableResolver;
  version?: () => Promise<string>;
  now?: () => number;
  setInterval?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
  home?: string;
  rateWindowMs?: number;
}

export interface Tracker {
  heartbeat(phase: Phase): void;
  start(getPhase: () => Phase): void;
  stop(): Promise<void>;
}

export class RunTracker implements Tracker {
  private readonly config: TrackingConfig;
  private readonly state: RunState;
  private readonly observer: RunObserver;
  private readonly store: RunStore;
  private disabled = false;
  private lastSentAt: number | undefined;
  private inFlight: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly controller = new AbortController();
  private readonly runner: ProcessRunner;
  private readonly resolver: ExecutableResolver;
  private readonly version: () => Promise<string>;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<RunTrackerDependencies['setInterval']>;
  private readonly clearTimer: NonNullable<RunTrackerDependencies['clearInterval']>;
  private readonly rateWindowMs: number;

  constructor(
    config: TrackingConfig,
    state: RunState,
    observer: RunObserver,
    store: RunStore,
    dependencies: RunTrackerDependencies = {},
  ) {
    this.config = config;
    this.state = state;
    this.observer = observer;
    this.store = store;
    this.runner = dependencies.runner ?? defaultProcessRunner;
    this.resolver = dependencies.resolveExecutable ?? (async () => resolveWakaTimeCli(undefined, dependencies.home));
    this.version = dependencies.version ?? packageVersion;
    this.now = dependencies.now ?? Date.now;
    this.setTimer = dependencies.setInterval ?? setInterval;
    this.clearTimer = dependencies.clearInterval ?? clearInterval;
    this.rateWindowMs = dependencies.rateWindowMs ?? RATE_WINDOW_MS;
  }

  heartbeat(phase: Phase): void {
    const workspace = this.state.workspace;
    if (this.disabled || this.controller.signal.aborted || workspace === undefined) return;
    if (!this.config.includeAgentPhases && phaseRole(phase) !== undefined) return;
    if (this.inFlight !== undefined) return;

    const now = this.now();
    if (this.lastSentAt !== undefined && now - this.lastSentAt < this.rateWindowMs) return;
    this.lastSentAt = now;
    this.inFlight = this.dispatch(phase, workspace.path, workspace.branch).finally(() => {
      this.inFlight = undefined;
    });
  }

  start(getPhase: () => Phase): void {
    if (this.disabled || this.timer !== undefined) return;
    this.timer = this.setTimer(() => this.heartbeat(getPhase()), this.rateWindowMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    this.controller.abort();
    await this.inFlight?.catch(() => {});
  }

  private async dispatch(phase: Phase, entity: string, branch: string): Promise<void> {
    try {
      const binary = await this.resolver('wakatime-cli');
      if (binary === null) return await this.disable(phase, 'wakatime-cli not found');
      const version = this.config.plugin === null ? await this.version() : undefined;
      const plugin = this.config.plugin ?? `relay/${version} relay-wakatime/${version}`;
      const project = this.config.project ?? this.state.repository.name ?? basename(entity);
      const result = await sendHeartbeat(
        this.runner,
        binary,
        buildHeartbeatArgs({ entity, project, branch, plugin, category: 'coding' }),
        this.controller.signal,
      );
      if (!result.ok && !this.controller.signal.aborted) await this.disable(phase, result.reason);
    } catch (error) {
      if (!this.controller.signal.aborted) await this.disable(phase, errorMessage(error));
    }
  }

  private async disable(phase: Phase, reason: string): Promise<void> {
    if (this.disabled) return;
    this.disabled = true;
    const message = `WakaTime tracking disabled for this run: ${reason}`;
    try { this.observer.note(message); } catch { /* Tracking cannot affect the run. */ }
    try {
      await this.store.logEvent({
        timestamp: new Date(this.now()).toISOString(),
        runId: this.state.runId,
        phase,
        agent: null,
        type: 'notice',
        data: { text: `tracking: ${reason}` },
      });
    } catch { /* Tracking cannot affect the run. */ }
  }
}

export type TrackerFactory = (
  config: TrackingConfig,
  state: RunState,
  observer: RunObserver,
  store: RunStore,
) => Tracker;

export const createRunTracker: TrackerFactory = (config, state, observer, store) =>
  new RunTracker(config, state, observer, store);
