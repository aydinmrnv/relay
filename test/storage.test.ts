import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

import { RunStore, listRuns, resolveRun } from '../src/storage/runs.ts';
import { mergeConfig, DEFAULT_CONFIG, loadConfig, writeConfig, AGENT_PROVIDERS, ROLES } from '../src/storage/config.ts';
import { createRunState, transition } from '../src/workflow/state.ts';
import { atomicWriteFile, readJsonFile } from '../src/storage/atomic.ts';
import { redact } from '../src/util/redact.ts';
import { createRunId, isRunId } from '../src/util/ids.ts';
import { RelayError } from '../src/util/errors.ts';
import { createTempRepo, type TempRepo } from './helpers/tempRepo.ts';

describe('config', () => {
  it('returns defaults when no config file exists', async () => {
    const repo = await createTempRepo();
    try {
      assert.deepEqual(await loadConfig(repo.root), DEFAULT_CONFIG);
    } finally {
      await repo.cleanup();
    }
  });

  it('round-trips a written config', async () => {
    const repo = await createTempRepo();
    try {
      const config = structuredClone(DEFAULT_CONFIG);
      config.workflow.maxPlanReviewRounds = 5;
      await writeConfig(repo.root, config);
      assert.equal((await loadConfig(repo.root)).workflow.maxPlanReviewRounds, 5);
    } finally {
      await repo.cleanup();
    }
  });

  it('merges partial config over defaults', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { agents: { planner: 'codex' }, workflow: { maxCodeReviewRounds: 1 } });
    assert.equal(merged.agents.planner, 'codex');
    assert.equal(merged.agents.implementer, 'codex');
    assert.equal(merged.workflow.maxCodeReviewRounds, 1);
    assert.equal(merged.workflow.maxPlanReviewRounds, DEFAULT_CONFIG.workflow.maxPlanReviewRounds);
  });

  it('rejects unknown agents and roles rather than ignoring them', () => {
    assert.throws(() => mergeConfig(DEFAULT_CONFIG, { agents: { planner: 'gpt5' } }), RelayError);
    assert.throws(() => mergeConfig(DEFAULT_CONFIG, { agents: { architect: 'claude' } }), RelayError);
  });

  it('accepts every registered agent for every role, without a hardcoded union', () => {
    for (const provider of AGENT_PROVIDERS) {
      for (const role of ROLES) {
        assert.equal(mergeConfig(DEFAULT_CONFIG, { agents: { [role]: provider } }).agents[role], provider);
      }
      assert.equal(mergeConfig(DEFAULT_CONFIG, { models: { [provider]: 'some-model' } }).models[provider], 'some-model');
    }
  });

  it('names the registered agents when rejecting an unknown one', () => {
    assert.throws(
      () => mergeConfig(DEFAULT_CONFIG, { models: { gemini: 'flash' } }),
      (error: unknown) => error instanceof RelayError && AGENT_PROVIDERS.every((name) => error.message.includes(name)),
    );
  });

  it('rejects out-of-range and non-integer round limits', () => {
    assert.throws(() => mergeConfig(DEFAULT_CONFIG, { workflow: { maxPlanReviewRounds: -1 } }), RelayError);
    assert.throws(() => mergeConfig(DEFAULT_CONFIG, { workflow: { maxPlanReviewRounds: 99 } }), RelayError);
    assert.throws(() => mergeConfig(DEFAULT_CONFIG, { workflow: { maxPlanReviewRounds: 1.5 } }), RelayError);
  });

  it('delivers as far as a pull request by default, and validates the policy', () => {
    // The default is the end of the work Relay can be accountable for: the
    // change reaches review, and no shared branch has moved.
    assert.equal(DEFAULT_CONFIG.workflow.deliver, 'pr');
    assert.equal(mergeConfig(DEFAULT_CONFIG, { workflow: { deliver: 'merge' } }).workflow.deliver, 'merge');
    assert.equal(mergeConfig(DEFAULT_CONFIG, { workflow: { deliver: 'none' } }).workflow.deliver, 'none');
    assert.throws(() => mergeConfig(DEFAULT_CONFIG, { workflow: { deliver: 'yolo' } }), RelayError);
    assert.throws(() => mergeConfig(DEFAULT_CONFIG, { workflow: { deliver: true } }), RelayError);
  });

  it('offers the merge by default, and lets a repository turn the question off', () => {
    assert.equal(DEFAULT_CONFIG.workflow.offerMerge, true);
    assert.equal(mergeConfig(DEFAULT_CONFIG, { workflow: { offerMerge: false } }).workflow.offerMerge, false);
    assert.throws(() => mergeConfig(DEFAULT_CONFIG, { workflow: { offerMerge: 'sometimes' } }), RelayError);
  });

  it('validates the merge method, which repositories are allowed to forbid', () => {
    assert.equal(DEFAULT_CONFIG.workflow.mergeMethod, 'squash');
    assert.equal(mergeConfig(DEFAULT_CONFIG, { workflow: { mergeMethod: 'rebase' } }).workflow.mergeMethod, 'rebase');
    assert.throws(() => mergeConfig(DEFAULT_CONFIG, { workflow: { mergeMethod: 'fast-forward' } }), RelayError);
  });

  it('bounds the transient retry count', () => {
    assert.equal(DEFAULT_CONFIG.workflow.maxTransientRetries, 2);
    assert.equal(mergeConfig(DEFAULT_CONFIG, { workflow: { maxTransientRetries: 0 } }).workflow.maxTransientRetries, 0);
    assert.throws(() => mergeConfig(DEFAULT_CONFIG, { workflow: { maxTransientRetries: -1 } }), RelayError);
    assert.throws(() => mergeConfig(DEFAULT_CONFIG, { workflow: { maxTransientRetries: 50 } }), RelayError);
  });

  it('rejects a malformed test command', () => {
    assert.throws(() => mergeConfig(DEFAULT_CONFIG, { tests: { command: 'npm test' } }), RelayError);
    assert.throws(() => mergeConfig(DEFAULT_CONFIG, { tests: { command: [] } }), RelayError);
    assert.deepEqual(mergeConfig(DEFAULT_CONFIG, { tests: { command: ['npm', 'test'] } }).tests.command, ['npm', 'test']);
  });

  it('defaults and validates WakaTime tracking', () => {
    assert.deepEqual(DEFAULT_CONFIG.tracking, {
      enabled: false,
      plugin: null,
      project: null,
      includeAgentPhases: true,
    });
    assert.deepEqual(
      mergeConfig(DEFAULT_CONFIG, {
        tracking: { enabled: true, plugin: 'relay/test', project: 'widgets', includeAgentPhases: false },
      }).tracking,
      { enabled: true, plugin: 'relay/test', project: 'widgets', includeAgentPhases: false },
    );
    for (const tracking of [{ enabled: 'yes' }, { plugin: 42 }, 'enabled']) {
      assert.throws(
        () => mergeConfig(DEFAULT_CONFIG, { tracking }),
        (error: unknown) => error instanceof RelayError && error.code === 'BAD_CONFIG',
      );
    }
  });

  it('rejects a non-object config file', () => {
    assert.throws(() => mergeConfig(DEFAULT_CONFIG, ['nope']), RelayError);
  });
});

describe('atomic writes', () => {
  it('leaves no temporary files behind', async () => {
    const repo = await createTempRepo();
    try {
      const path = `${repo.root}/data.json`;
      await atomicWriteFile(path, '{"a":1}');
      assert.equal(await readFile(path, 'utf8'), '{"a":1}');

      const entries = await readdir(repo.root);
      assert.equal(entries.filter((entry) => entry.includes('.tmp')).length, 0);
    } finally {
      await repo.cleanup();
    }
  });

  it('overwrites cleanly on a second write', async () => {
    const repo = await createTempRepo();
    try {
      const path = `${repo.root}/data.json`;
      await atomicWriteFile(path, '{"a":1}');
      await atomicWriteFile(path, '{"a":2}');
      assert.deepEqual(await readJsonFile(path), { a: 2 });
    } finally {
      await repo.cleanup();
    }
  });

  it('returns undefined for missing or corrupt json', async () => {
    assert.equal(await readJsonFile('/nonexistent/file.json'), undefined);
  });
});

describe('run ids', () => {
  it('produces sortable, validatable ids', () => {
    const earlier = createRunId(new Date('2026-01-01T00:00:00Z'));
    const later = createRunId(new Date('2026-06-01T00:00:00Z'));
    assert.ok(isRunId(earlier) && isRunId(later));
    assert.ok(earlier < later);
    assert.equal(isRunId('../../etc/passwd'), false);
    assert.equal(isRunId('nonsense'), false);
  });
});

describe('run store', () => {
  let repo: TempRepo;

  before(async () => {
    repo = await createTempRepo();
  });

  after(async () => {
    await repo.cleanup();
  });

  it('rejects a run id that could escape the runs directory', () => {
    assert.throws(() => new RunStore(repo.root, '../../etc'), RelayError);
  });

  it('persists and reloads run state', async () => {
    const state = createRunState({
      runId: createRunId(new Date('2026-08-11T10:00:00Z')),
      shortId: 'aaa111',
      issueRef: '142',
      repository: { root: repo.root, owner: 'acme', name: 'widgets', defaultBranch: 'main' },
      config: structuredClone(DEFAULT_CONFIG),
    });

    const store = new RunStore(repo.root, state.runId);
    await store.init();
    transition(state, 'FETCHING_ISSUE');
    await store.saveState(state);

    const reloaded = await new RunStore(repo.root, state.runId).loadState();
    assert.equal(reloaded.runId, state.runId);
    assert.equal(reloaded.phase, 'FETCHING_ISSUE');
    assert.equal(reloaded.config.agents.implementer, 'codex');
  });

  it('reports a missing run rather than returning empty state', async () => {
    const store = new RunStore(repo.root, createRunId(new Date()));
    await assert.rejects(() => store.loadState(), RelayError);
  });

  it('appends events as JSONL and reads them back', async () => {
    const runId = createRunId(new Date('2026-08-11T11:00:00Z'));
    const store = new RunStore(repo.root, runId);
    await store.init();

    await store.logEvent({ timestamp: '2026-08-11T11:00:00Z', runId, phase: 'PLANNING', agent: 'planner', type: 'message' });
    await store.logEvent({ timestamp: '2026-08-11T11:00:01Z', runId, phase: 'PLANNING', agent: 'planner', type: 'tool' });

    const events = await store.readEvents();
    assert.equal(events.length, 2);
    assert.equal(events[0]?.type, 'message');
    assert.equal(events[1]?.phase, 'PLANNING');
  });

  it('redacts credential-shaped strings before they reach the log', async () => {
    const runId = createRunId(new Date('2026-08-11T11:30:00Z'));
    const store = new RunStore(repo.root, runId);
    await store.init();

    await store.logEvent({
      timestamp: '2026-08-11T11:30:00Z',
      runId,
      phase: 'IMPLEMENTING',
      agent: 'implementer',
      type: 'command',
      message: 'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz012345',
      data: { nested: { key: 'sk-ant-api03-verysecretvaluehere1234' } },
    });

    const raw = await readFile(store.path('events.jsonl'), 'utf8');
    assert.ok(!raw.includes('ghp_abcdefghijklmnopqrstuvwxyz012345'));
    assert.ok(!raw.includes('sk-ant-api03-verysecretvaluehere1234'));
    assert.match(raw, /redacted/);
  });

  it('records and clears a cancellation request', async () => {
    const runId = createRunId(new Date('2026-08-11T12:00:00Z'));
    const store = new RunStore(repo.root, runId);
    await store.init();

    assert.equal(await store.cancelRequested(), false);
    await store.requestCancel('user asked');
    assert.equal(await store.cancelRequested(), true);
    await store.clearCancel();
    assert.equal(await store.cancelRequested(), false);
  });

  it('lists runs newest first and resolves references', async () => {
    const runs = await listRuns(repo.root);
    assert.ok(runs.length >= 1);
    for (let i = 0; i < runs.length - 1; i += 1) {
      assert.ok(runs[i]!.runId >= runs[i + 1]!.runId);
    }

    const latest = await resolveRun(repo.root, 'latest');
    assert.equal(latest.runId, runs[0]!.runId);
    assert.equal((await resolveRun(repo.root, latest.runId)).runId, latest.runId);
    assert.equal((await resolveRun(repo.root, latest.shortId)).runId, latest.runId);

    await assert.rejects(() => resolveRun(repo.root, 'zzz999'), RelayError);
  });
});

describe('redaction', () => {
  it('masks the token shapes Relay might encounter', () => {
    assert.ok(!redact('ghp_abcdefghijklmnopqrstuvwxyz012345').includes('ghp_'));
    assert.ok(!redact('sk-ant-api03-abcdefghijklmnop').includes('sk-ant'));
    assert.ok(!redact('AKIAIOSFODNN7EXAMPLE').includes('AKIA'));
    assert.match(redact('API_TOKEN=hunter2'), /API_TOKEN=\[redacted\]/);
    assert.match(redact('Authorization: Bearer abc.def'), /redacted/);
  });

  it('leaves ordinary text alone', () => {
    const text = 'Refactored src/app.ts to reuse the existing RateLimiter.';
    assert.equal(redact(text), text);
  });
});
