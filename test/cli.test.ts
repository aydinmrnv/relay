import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { runToJson, type RunJson } from '../src/cli/runJson.ts';
import { logsCommand, statusCommand } from '../src/cli/commands/inspect.ts';
import { RunStore } from '../src/storage/runs.ts';
import { DEFAULT_CONFIG } from '../src/storage/config.ts';
import { createRunId } from '../src/util/ids.ts';
import { createRunState, transition, type RunState } from '../src/workflow/state.ts';
import { recordTurnUsage } from '../src/workflow/usage.ts';
import { createTempRepo, type TempRepo } from './helpers/tempRepo.ts';

let repo: TempRepo;

beforeEach(async () => {
  repo = await createTempRepo();
});

afterEach(async () => {
  await repo.cleanup();
});

/** A run carrying every optional field, so the JSON contract is exercised in full. */
function populatedRun(root: string, createdAt = new Date('2026-08-11T10:00:00Z')): RunState {
  const state = createRunState({
    runId: createRunId(createdAt),
    shortId: 'aaa111',
    issueRef: '142',
    repository: { root, owner: 'acme', name: 'widgets', defaultBranch: 'main' },
    config: structuredClone(DEFAULT_CONFIG),
    now: createdAt,
  });

  state.issue = {
    number: 142,
    title: 'Add authentication rate limiting',
    url: 'https://github.com/acme/widgets/issues/142',
    state: 'open',
  };
  state.workspace = {
    path: '/tmp/workspaces/acme/widgets/issue-142-aaa111',
    branch: 'relay/142-aaa111',
    baseSha: 'abc1234def5678',
    baseRef: 'refs/heads/main',
    baseBranch: 'main',
  };
  state.diff = {
    fileCount: 2,
    additions: 40,
    deletions: 7,
    files: ['src/app.ts', 'test/app.test.ts'],
    patchFile: 'patches/final.patch',
    at: '2026-08-11T10:05:00Z',
  };
  state.tests = {
    discovered: true,
    command: ['npm', 'test'],
    reason: 'package.json scripts.test',
    exitCode: 0,
    passed: true,
    durationMs: 4200,
    timedOut: false,
    outputFile: 'tests/test-run.log',
    at: '2026-08-11T10:06:00Z',
  };
  state.rounds = { planReview: 2, codeReview: 1 };
  state.planApproved = true;
  state.reviews = [
    {
      round: 1,
      kind: 'plan',
      reviewer: 'codex',
      decision: 'request_changes',
      summary: 'Missing a test plan.',
      findings: [{ id: 'F1', severity: 'high', category: 'testing', summary: 'No tests named.' }],
      at: '2026-08-11T10:02:00Z',
    },
  ];
  state.usage = recordTurnUsage(undefined, 'PLANNING', { inputTokens: 1500, outputTokens: 300, costUsd: 0.12 });

  return state;
}

describe('run JSON projection', () => {
  it('includes the identity, issue, branch, diff, tests and round counts', () => {
    const json = runToJson(populatedRun(repo.root));

    assert.equal(json.shortId, 'aaa111');
    assert.equal(json.phase, 'INITIALIZING');
    assert.equal(json.phaseLabel, 'Initializing');
    assert.equal(json.terminal, false);

    assert.equal(json.issue?.number, 142);
    assert.equal(json.issue?.title, 'Add authentication rate limiting');
    assert.equal(json.issue?.url, 'https://github.com/acme/widgets/issues/142');

    assert.equal(json.branch, 'relay/142-aaa111');
    assert.equal(json.workspace?.baseBranch, 'main');

    assert.deepEqual(json.diff, {
      fileCount: 2,
      additions: 40,
      deletions: 7,
      files: ['src/app.ts', 'test/app.test.ts'],
      patchFile: 'patches/final.patch',
      at: '2026-08-11T10:05:00Z',
    });

    assert.equal(json.tests?.passed, true);
    assert.deepEqual(json.tests?.command, ['npm', 'test']);
    assert.equal(json.tests?.skippedReason, null);

    assert.deepEqual(json.rounds, { planReview: 2, codeReview: 1, maxPlanReview: 3, maxCodeReview: 2 });
    assert.equal(json.reviews[0]?.findings, 1);
    assert.equal(json.usage?.total.costUsd, 0.12);
  });

  it('reports absent facts as null rather than dropping the keys', () => {
    const bare = createRunState({
      runId: createRunId(new Date('2026-08-11T09:00:00Z')),
      shortId: 'bbb222',
      issueRef: '7',
      repository: { root: repo.root, owner: null, name: null, defaultBranch: 'main' },
      config: structuredClone(DEFAULT_CONFIG),
    });

    const json = runToJson(bare);
    for (const key of ['issue', 'branch', 'workspace', 'diff', 'tests', 'usage', 'error', 'finishedAt'] as const) {
      assert.equal(json[key], null, `${key} should be null`);
    }
    assert.deepEqual(json.reviews, []);
    assert.equal(json.repository.owner, null);
  });

  it('reports the effective agent per role', () => {
    const json = runToJson(populatedRun(repo.root));
    assert.deepEqual(json.agents, {
      planner: 'claude',
      planReviewer: 'codex',
      implementer: 'codex',
      codeReviewer: 'claude',
    });
  });

  it('surfaces a failure and marks the run terminal', () => {
    const state = populatedRun(repo.root);
    state.error = { message: 'codex (implementer) failed', phase: 'IMPLEMENTING', code: 'AGENT_FAILED' };
    transition(state, 'FAILED');

    const json = runToJson(state);
    assert.equal(json.terminal, true);
    assert.equal(json.phase, 'FAILED');
    assert.equal(json.error?.code, 'AGENT_FAILED');
    assert.ok(json.finishedAt !== null);
  });

  it('serializes without any terminal escape sequences', () => {
    const json = runToJson(populatedRun(repo.root));
    const serialized = JSON.stringify(json, null, 2);
    assert.ok(!serialized.includes('\u001B'), 'JSON must never carry colour codes');
    assert.deepEqual(JSON.parse(serialized), json);
  });
});

/** Runs a command from inside the temp repo and returns everything it wrote to stdout. */
async function capture(run: () => Promise<unknown>): Promise<string> {
  const originalCwd = process.cwd();
  const originalWrite = process.stdout.write.bind(process.stdout);
  let captured = '';

  process.chdir(repo.root);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;

  try {
    await run();
  } finally {
    process.stdout.write = originalWrite;
    process.chdir(originalCwd);
  }
  return captured;
}

function captureStatus(args: Parameters<typeof statusCommand>): Promise<string> {
  return capture(() => statusCommand(...args));
}

/** Writes a run to disk so the inspect commands can resolve it. */
async function persist(state: RunState): Promise<RunStore> {
  const store = new RunStore(repo.root, state.runId);
  await store.init();
  await store.saveState(state);
  return store;
}

describe('relay status --json', () => {
  beforeEach(() => {
    // NO_COLOR must not be what makes the output parseable.
    delete process.env['NO_COLOR'];
  });

  it('prints a JSON array of every run', async () => {
    const older = populatedRun(repo.root, new Date('2026-08-11T10:00:00Z'));
    const newer = populatedRun(repo.root, new Date('2026-08-11T11:00:00Z'));
    newer.shortId = 'ccc333';

    for (const state of [older, newer]) await persist(state);

    const parsed = JSON.parse(await captureStatus([undefined, { json: true }])) as RunJson[];
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 2);
    // Newest first, matching the human listing.
    assert.equal(parsed[0]?.runId, newer.runId);
    assert.equal(parsed[1]?.runId, older.runId);
  });

  it('prints an empty array when there are no runs, not prose', async () => {
    assert.deepEqual(JSON.parse(await captureStatus([undefined, { json: true }])), []);
  });

  it('prints a single object for a named run', async () => {
    const state = populatedRun(repo.root);
    await persist(state);

    const parsed = JSON.parse(await captureStatus([state.shortId, { json: true }])) as RunJson;
    assert.ok(!Array.isArray(parsed));
    assert.equal(parsed.runId, state.runId);
    assert.equal(parsed.issue?.number, 142);
    assert.equal(parsed.branch, 'relay/142-aaa111');
  });

  it('resolves "latest" like every other run reference', async () => {
    const state = populatedRun(repo.root);
    await persist(state);

    const parsed = JSON.parse(await captureStatus(['latest', { json: true }])) as RunJson;
    assert.equal(parsed.runId, state.runId);
  });

  it('emits nothing but the JSON document', async () => {
    const state = populatedRun(repo.root);
    await persist(state);

    const output = await captureStatus([state.shortId, { json: true }]);
    assert.ok(output.trimStart().startsWith('{'));
    assert.ok(output.trimEnd().endsWith('}'));
    assert.ok(!output.includes('\u001B'));
  });

  it('keeps the human table as the default', async () => {
    const state = populatedRun(repo.root);
    await persist(state);

    const output = await captureStatus([undefined, {}]);
    assert.ok(output.includes('Relay runs in'));
    assert.throws(() => JSON.parse(output));
  });
});

describe('relay logs usage breakdown', () => {
  it('attributes spend to the phases that caused it', async () => {
    const state = populatedRun(repo.root);
    state.usage = recordTurnUsage(state.usage, 'REVIEWING_PLAN', { inputTokens: 800, outputTokens: 90 });
    const store = await persist(state);
    await store.logEvent({
      timestamp: '2026-08-11T10:01:00Z',
      runId: state.runId,
      phase: 'PLANNING',
      agent: 'planner',
      type: 'turn_completed',
    });

    const output = await capture(() => logsCommand(state.shortId, {}));

    assert.match(output, /Usage by phase/);
    assert.match(output, /Planning\s+1\.5k in \/ 300 out · \$0\.12 · 1 turn/);
    // Codex reports no price, so its phase must not invent one.
    assert.match(output, /Plan review\s+800 in \/ 90 out · 1 turn/);
    assert.match(output, /Total\s+2\.3k in \/ 390 out · \$0\.12 · 2 turns/);
  });

  it('says nothing about usage when none was recorded', async () => {
    const state = populatedRun(repo.root);
    delete state.usage;
    const store = await persist(state);
    await store.logEvent({
      timestamp: '2026-08-11T10:01:00Z',
      runId: state.runId,
      phase: 'PLANNING',
      agent: 'planner',
      type: 'turn_completed',
    });

    assert.ok(!(await capture(() => logsCommand(state.shortId, {}))).includes('Usage'));
  });
});
