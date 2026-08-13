import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ProcessResult } from '../src/process/runner.ts';
import { DEFAULT_CONFIG } from '../src/storage/config.ts';
import { RunStore } from '../src/storage/runs.ts';
import { createTracking } from '../src/tracking/index.ts';
import { TrackingObserver } from '../src/tracking/observer.ts';
import { WakatimeTracker, type TrackingRunner } from '../src/tracking/wakatime.ts';
import { RecordingObserver } from '../src/workflow/observer.ts';
import type { RunState } from '../src/workflow/state.ts';
import { createRunId } from '../src/util/ids.ts';
import { createTempRepo, type TempRepo } from './helpers/tempRepo.ts';

const repos: TempRepo[] = [];
afterEach(async () => { while (repos.length > 0) await repos.pop()?.cleanup(); });

async function fixture(enabled = true): Promise<{ state: RunState; store: RunStore; observer: RecordingObserver }> {
  const repo = await createTempRepo();
  repos.push(repo);
  const runId = createRunId(new Date());
  const store = new RunStore(repo.root, runId);
  await store.init();
  const config = structuredClone(DEFAULT_CONFIG);
  config.tracking.enabled = enabled;
  const state = {
    runId,
    phase: 'TESTING',
    config,
    repository: { root: repo.root, owner: 'owner', name: 'project', defaultBranch: 'main' },
    workspace: { path: `${repo.root}/worktree`, branch: 'relay/45', baseSha: 'abc', baseRef: 'main', baseBranch: 'main' },
  } as RunState;
  return { state, store, observer: new RecordingObserver() };
}

function result(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { command: '/cli', args: [], cwd: '/', exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1, timedOut: false, aborted: false, ok: true, ...overrides };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

describe('WakaTime tracking', () => {
  it('does nothing when disabled', async () => {
    const f = await fixture(false);
    let calls = 0;
    const assembled = await createTracking({ ...f, signal: new AbortController().signal, version: '1.2.3', tracker: { run: async () => { calls++; return result(); } } });
    assert.equal(assembled.observer, f.observer);
    assembled.observer.phaseChanged('TESTING');
    assert.equal(calls, 0);
  });

  it('builds credential-free argv and applies project semantics', async () => {
    const f = await fixture();
    let args: readonly string[] = [];
    const tracker = new WakatimeTracker({ ...f, tracking: f.state.config.tracking, version: '1.2.3', resolve: async () => '/cli', run: async (_command, value) => { args = value; return result(); } });
    tracker.heartbeat();
    await settle();
    assert.deepEqual(args.slice(0, 6), ['--entity', f.state.workspace?.path, '--entity-type', 'file', '--branch', 'relay/45']);
    assert.equal(args[args.indexOf('--plugin') + 1], 'relay/1.2.3 relay-wakatime/1.2.3');
    assert.equal(args[args.indexOf('--project') + 1], 'project');
    assert.ok(args.includes('--category') && args.includes('coding') && args.includes('--write'));
    assert.equal(args.some((arg) => /key|token/i.test(arg)), false);

    f.state.config.tracking.project = null;
    f.state.repository.name = null;
    args = [];
    new WakatimeTracker({ ...f, tracking: f.state.config.tracking, version: '1', resolve: async () => '/cli', run: async (_c, value) => { args = value; return result(); } }).heartbeat();
    await settle();
    assert.equal(args.includes('--project'), false);
  });

  it('rate limits globally and filters agent phases', async () => {
    const f = await fixture();
    let now = 0;
    let calls = 0;
    const tracker = new WakatimeTracker({ ...f, tracking: f.state.config.tracking, version: '1', resolve: async () => '/cli', run: async () => { calls++; return result(); }, now: () => now, minimumIntervalMs: 100 });
    const observer = new TrackingObserver(f.observer, tracker, f.state, false);
    f.state.phase = 'IMPLEMENTING'; observer.phaseChanged('IMPLEMENTING');
    assert.equal(calls, 0);
    f.state.phase = 'TESTING'; observer.phaseChanged('TESTING'); await settle();
    f.state.phase = 'DELIVERING'; observer.phaseChanged('DELIVERING'); await settle();
    assert.equal(calls, 1);
    now = 101; observer.phaseChanged('DELIVERING'); await settle();
    assert.equal(calls, 2);
    observer.stop();
  });

  for (const [name, run] of [
    ['missing executable', undefined],
    ['non-zero exit', async () => result({ exitCode: 1, ok: false, stderr: 'sk-secret-that-must-not-appear' })],
    ['timeout', async () => result({ exitCode: null, timedOut: true, ok: false })],
    ['runner throw', async () => { throw new Error('API_KEY=sk-abcdefghijklmnopqrstuvwxyz'); }],
  ] as const) {
    it(`disables after one sanitized notice: ${name}`, async () => {
      const f = await fixture();
      const runner = run as TrackingRunner | undefined;
      const tracker = new WakatimeTracker({ ...f, tracking: f.state.config.tracking, version: '1', resolve: async () => runner === undefined ? null : '/cli', ...(runner === undefined ? {} : { run: runner }), minimumIntervalMs: 0 });
      tracker.heartbeat(); await settle(); tracker.heartbeat(); await settle();
      const notices = (await f.store.readEvents()).filter((event) => event.type === 'notice');
      assert.equal(notices.length, 1);
      assert.equal(f.observer.warnings.length, 1);
      assert.doesNotMatch(notices[0]?.message ?? '', /abcdefghijklmnopqrstuvwxyz|must-not-appear/);
    });
  }

  it('aborts an in-flight heartbeat without awaiting it', async () => {
    const f = await fixture();
    let aborted = false;
    const run: TrackingRunner = async (_c, _a, options) => await new Promise((resolve) => {
      options?.signal?.addEventListener('abort', () => { aborted = true; resolve(result({ aborted: true, ok: false })); });
    });
    const tracker = new WakatimeTracker({ ...f, tracking: f.state.config.tracking, version: '1', resolve: async () => '/cli', run });
    tracker.heartbeat(); await settle(); tracker.stop();
    assert.equal(aborted, true);
  });
});
