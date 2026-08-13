import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveExecutable, runProcess, type ProcessResult, type ProcessRunOptions } from '../process/runner.ts';
import type { RelayConfig } from '../storage/config.ts';
import type { RunStore } from '../storage/runs.ts';
import { redact } from '../util/redact.ts';
import type { RunObserver } from '../workflow/observer.ts';
import type { RunState } from '../workflow/state.ts';

export type TrackingRunner = (
  command: string,
  args: readonly string[],
  options?: ProcessRunOptions,
) => Promise<ProcessResult>;

export interface WakatimeTrackerOptions {
  tracking: RelayConfig['tracking'];
  state: RunState;
  store: RunStore;
  observer: RunObserver;
  version: string;
  run?: TrackingRunner;
  resolve?: (command: string) => Promise<string | null>;
  now?: () => number;
  minimumIntervalMs?: number;
}

/** Best-effort WakaTime reporting. This class never reads tracker configuration or credentials. */
export class WakatimeTracker {
  readonly minimumIntervalMs: number;
  private readonly controller = new AbortController();
  private readonly run: TrackingRunner;
  private readonly resolve: (command: string) => Promise<string | null>;
  private readonly now: () => number;
  private inFlight = false;
  private disabled = false;
  private stopped = false;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private readonly options: WakatimeTrackerOptions;

  constructor(options: WakatimeTrackerOptions) {
    this.options = options;
    this.run = options.run ?? runProcess;
    this.resolve = options.resolve ?? resolveExecutable;
    this.now = options.now ?? Date.now;
    this.minimumIntervalMs = options.minimumIntervalMs ?? 120_000;
  }

  heartbeat(): void {
    if (this.disabled || this.stopped || this.inFlight || this.options.state.workspace === undefined) return;
    const now = this.now();
    if (now - this.lastSentAt < this.minimumIntervalMs) return;
    this.lastSentAt = now;
    this.inFlight = true;
    void this.send().catch((error: unknown) => this.fail(error)).finally(() => {
      this.inFlight = false;
    });
  }

  stop(): void {
    this.stopped = true;
    this.controller.abort();
  }

  private async send(): Promise<void> {
    const workspace = this.options.state.workspace;
    if (workspace === undefined) return;
    const cli = await this.resolve(join(homedir(), '.wakatime', 'wakatime-cli'));
    if (cli === null) {
      this.fail(new Error('wakatime-cli was not found'));
      return;
    }
    const project = this.options.tracking.project ?? this.options.state.repository.name;
    const plugin = this.options.tracking.plugin.replaceAll('<version>', this.options.version);
    const args = [
      '--entity', workspace.path,
      '--entity-type', 'file',
      '--branch', workspace.branch,
      '--category', 'coding',
      '--plugin', plugin,
      '--write',
      ...(project === null ? [] : ['--project', project]),
    ];
    const result = await this.run(cli, args, { timeoutMs: 5_000, signal: this.controller.signal });
    if (!result.ok && !this.stopped) this.fail(new Error(result.timedOut ? 'wakatime-cli timed out' : 'wakatime-cli failed'));
  }

  private fail(error: unknown): void {
    if (this.disabled || this.stopped) return;
    this.disabled = true;
    const detail = error instanceof Error ? error.message : String(error);
    const message = redact(`Relay activity tracking disabled: ${detail}. The run will continue.`);
    this.options.observer.warn(message);
    void this.options.store.logEvent({
      timestamp: new Date().toISOString(),
      runId: this.options.state.runId,
      phase: this.options.state.phase,
      agent: null,
      type: 'notice',
      message,
    }).catch(() => {});
  }
}
