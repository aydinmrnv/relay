import type { RunStore } from '../storage/runs.ts';
import { packageVersion } from '../update/installation.ts';
import type { RunObserver } from '../workflow/observer.ts';
import type { RunState } from '../workflow/state.ts';
import { TrackingObserver } from './observer.ts';
import { WakatimeTracker, type WakatimeTrackerOptions } from './wakatime.ts';

export interface CreateTrackingOptions {
  state: RunState;
  store: RunStore;
  observer: RunObserver;
  signal: AbortSignal;
  version?: string;
  tracker?: Omit<WakatimeTrackerOptions, 'tracking' | 'state' | 'store' | 'observer' | 'version'>;
}

export async function createTracking(options: CreateTrackingOptions): Promise<{ observer: RunObserver; stop: () => void }> {
  if (options.state.config.tracking?.enabled !== true) return { observer: options.observer, stop() {} };
  const tracker = new WakatimeTracker({
    ...options.tracker,
    tracking: options.state.config.tracking,
    state: options.state,
    store: options.store,
    observer: options.observer,
    version: options.version ?? await packageVersion(),
  });
  const observer = new TrackingObserver(
    options.observer,
    tracker,
    options.state,
    options.state.config.tracking.includeAgentPhases,
  );
  const stop = (): void => observer.stop();
  options.signal.addEventListener('abort', stop, { once: true });
  return { observer, stop };
}
