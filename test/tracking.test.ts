import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG } from '../src/storage/config.ts';
import type { RunStore, LoggedEvent } from '../src/storage/runs.ts';
import type { ProcessResult } from '../src/process/runner.ts';
import { RunTracker } from '../src/tracking/tracker.ts';
import { RecordingObserver } from '../src/workflow/observer.ts';
import { createRunState } from '../src/workflow/state.ts';

function result(ok = true): ProcessResult {
  return {
    command: '/wakatime-cli', args: [], cwd: '/work', exitCode: ok ? 0 : 1,
    signal: null, stdout: '', stderr: '', durationMs: 1, timedOut: false, aborted: false, ok,
  };
}

function setup(options: { workspace?: boolean; includeAgentPhases?: boolean; repositoryName?: string | null } = {}) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.tracking.enabled = true;
  config.tracking.includeAgentPhases = options.includeAgentPhases ?? true;
  const state = createRunState({
    runId: '20260812-120000-abcd', shortId: 'abcd', issueRef: '45', config,
    repository: { root: '/repo', owner: 'acme', name: options.repositoryName === undefined ? 'widgets' : options.repositoryName, defaultBranch: 'main' },
  });
  if (options.workspace !== false) {
    state.workspace = { path: '/tmp/worktrees/widget-run', branch: 'relay/45-abcd', baseSha: 'abc', baseRef: 'main', baseBranch: 'main' };
  }
  const observer = new RecordingObserver();
  const events: LoggedEvent[] = [];
  const store = { logEvent: async (event: LoggedEvent) => { events.push(event); } } as RunStore;
  return { config, state, observer, store, events };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('WakaTime run tracker', () => {
  it('builds a key-free versioned heartbeat argv with run fields', async () => {
    const fixture = setup();
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const tracker = new RunTracker(fixture.config.tracking, fixture.state, fixture.observer, fixture.store, {
      resolveExecutable: async () => '/wakatime-cli', version: async () => '1.2.3', now: () => 1,
      runner: async (command, args) => { calls.push({ command, args }); return result(); },
    });
    tracker.heartbeat('TESTING');
    await settle();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, [
      '--entity', '/tmp/worktrees/widget-run', '--entity-type', 'app', '--project', 'widgets',
      '--branch', 'relay/45-abcd', '--plugin', 'relay/1.2.3 relay-wakatime/1.2.3',
      '--category', 'coding', '--write',
    ]);
    assert.equal(calls[0]?.args.some((arg) => /api.?key/i.test(arg)), false);
  });

  it('falls back from repository name to worktree basename', async () => {
    const fixture = setup({ repositoryName: null });
    let args: readonly string[] = [];
    const tracker = new RunTracker(fixture.config.tracking, fixture.state, fixture.observer, fixture.store, {
      resolveExecutable: async () => '/wakatime-cli', version: async () => '1', now: () => 1,
      runner: async (_command, sent) => { args = sent; return result(); },
    });
    tracker.heartbeat('TESTING'); await settle();
    assert.equal(args[args.indexOf('--project') + 1], 'widget-run');
  });

  it('disables on a resolved non-zero result and records one notice on each surface', async () => {
    const fixture = setup();
    let calls = 0;
    const tracker = new RunTracker(fixture.config.tracking, fixture.state, fixture.observer, fixture.store, {
      resolveExecutable: async () => '/wakatime-cli', version: async () => '1', now: () => 1,
      runner: async () => { calls++; return result(false); },
    });
    tracker.heartbeat('TESTING'); await settle(); tracker.heartbeat('DELIVERING'); await settle();
    assert.equal(calls, 1);
    assert.equal(fixture.observer.notes.length, 1);
    assert.equal(fixture.events.filter((event) => event.type === 'notice').length, 1);
  });

  it('reserves the in-flight call and throttle window synchronously', async () => {
    const fixture = setup();
    let release!: (value: ProcessResult) => void;
    let calls = 0;
    const pending = new Promise<ProcessResult>((resolve) => { release = resolve; });
    const tracker = new RunTracker(fixture.config.tracking, fixture.state, fixture.observer, fixture.store, {
      resolveExecutable: async () => '/wakatime-cli', version: async () => '1', now: () => 100,
      runner: async () => { calls++; return pending; },
    });
    tracker.heartbeat('TESTING'); tracker.heartbeat('DELIVERING'); await settle();
    assert.equal(calls, 1);
    release(result()); await settle(); tracker.heartbeat('DELIVERING'); await settle();
    assert.equal(calls, 1);
  });

  it('waits for a workspace without disabling, then emits', async () => {
    const fixture = setup({ workspace: false });
    let calls = 0;
    const tracker = new RunTracker(fixture.config.tracking, fixture.state, fixture.observer, fixture.store, {
      resolveExecutable: async () => '/wakatime-cli', version: async () => '1', now: () => 1,
      runner: async () => { calls++; return result(); },
    });
    tracker.heartbeat('INITIALIZING'); tracker.heartbeat('FETCHING_ISSUE'); tracker.heartbeat('CREATING_WORKSPACE');
    fixture.state.workspace = { path: '/work', branch: 'relay/45', baseSha: 'x', baseRef: 'main', baseBranch: 'main' };
    tracker.heartbeat('PLANNING'); await settle();
    assert.equal(calls, 1); assert.equal(fixture.observer.notes.length, 0);
  });

  it('can exclude agent-driven phases', async () => {
    const fixture = setup({ includeAgentPhases: false });
    let calls = 0; let now = 0;
    const tracker = new RunTracker(fixture.config.tracking, fixture.state, fixture.observer, fixture.store, {
      resolveExecutable: async () => '/wakatime-cli', version: async () => '1', now: () => now,
      runner: async () => { calls++; return result(); }, rateWindowMs: 1,
    });
    tracker.heartbeat('IMPLEMENTING'); tracker.heartbeat('REVIEWING_CODE'); await settle();
    tracker.heartbeat('TESTING'); await settle(); now = 2; tracker.heartbeat('DELIVERING'); await settle();
    assert.equal(calls, 2);
  });

  it('aborts and awaits an in-flight invocation on stop', async () => {
    const fixture = setup();
    let aborted = false;
    const tracker = new RunTracker(fixture.config.tracking, fixture.state, fixture.observer, fixture.store, {
      resolveExecutable: async () => '/wakatime-cli', version: async () => '1', now: () => 1,
      runner: async (_command, _args, options) => new Promise((resolve) => {
        options?.signal?.addEventListener('abort', () => { aborted = true; resolve({ ...result(false), aborted: true }); });
      }),
    });
    tracker.heartbeat('TESTING'); await settle(); await tracker.stop();
    assert.equal(aborted, true); assert.equal(fixture.observer.notes.length, 0);
  });
});
