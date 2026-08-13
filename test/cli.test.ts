import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { SCHEMA_VERSION, type JsonDocument } from '../src/cli/json.ts';
import { runToJson, type RunJson } from '../src/cli/runJson.ts';
import { logsCommand, statusCommand } from '../src/cli/commands/inspect.ts';
import { applyOverrides, printNextSteps, printOutcome } from '../src/cli/commands/run.ts';
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

describe('delivery CLI flags', () => {
  it('maps each explicit flag to the intended ceiling', () => {
    assert.equal(applyOverrides(DEFAULT_CONFIG, {}).workflow.deliver, 'branch');
    assert.equal(applyOverrides(DEFAULT_CONFIG, { commit: true }).workflow.deliver, 'branch');
    assert.equal(applyOverrides(DEFAULT_CONFIG, { push: true }).workflow.deliver, 'push');
    assert.equal(applyOverrides(DEFAULT_CONFIG, { pr: true }).workflow.deliver, 'pr');
    assert.equal(applyOverrides(DEFAULT_CONFIG, { merge: true }).workflow.deliver, 'merge');
    assert.equal(applyOverrides(DEFAULT_CONFIG, { deliver: 'pr' }).workflow.deliver, 'pr');
  });
});

describe('workflow CLI flags', () => {
  it('--fast drops both reviews, not just the plan one', () => {
    const config = applyOverrides(DEFAULT_CONFIG, { fast: true });

    assert.equal(config.workflow.plan, 'inline');
    assert.equal(config.workflow.reviewCode, false);
  });

  it('leaves both reviews on by default', () => {
    const config = applyOverrides(DEFAULT_CONFIG, {});

    assert.equal(config.workflow.plan, 'review');
    assert.equal(config.workflow.reviewCode, true);
    assert.equal(config.workflow.typos, false);
  });

  it('--tuff turns on the typos, and nothing else', () => {
    const config = applyOverrides(DEFAULT_CONFIG, { tuff: true });

    assert.equal(config.workflow.typos, true);
    assert.equal(config.workflow.plan, 'review');
    assert.equal(config.workflow.reviewCode, true);
  });

  it('combines the fast, merge and typo flags', () => {
    const config = applyOverrides(DEFAULT_CONFIG, { fast: true, merge: true, tuff: true });

    assert.equal(config.workflow.plan, 'inline');
    assert.equal(config.workflow.reviewCode, false);
    assert.equal(config.workflow.deliver, 'merge');
    assert.equal(config.workflow.typos, true);
  });
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

    assert.deepEqual(json.rounds, { planReview: 2, codeReview: 1, maxPlanReview: 2, maxCodeReview: 2 });
    assert.equal(json.reviews[0]?.findings, 1);
    assert.equal(json.usage?.total.costUsd, 0.12);
  });

  it('reports an unpriced usage bucket as a null cost, not a missing key', () => {
    const state = populatedRun(repo.root);
    // A Codex turn: real tokens, no price. The key must survive as null so a
    // consumer can tell "not reported" from "free".
    state.usage = recordTurnUsage(undefined, 'IMPLEMENTING', { inputTokens: 2000, outputTokens: 450 });

    const json = runToJson(state);
    const total = json.usage?.total;
    assert.ok(total !== undefined);
    assert.deepEqual(total, { inputTokens: 2000, outputTokens: 450, costUsd: null, turns: 1 });
    assert.ok('costUsd' in total);
    assert.deepEqual(json.usage?.byPhase.IMPLEMENTING, {
      inputTokens: 2000,
      outputTokens: 450,
      costUsd: null,
      turns: 1,
    });

    const roundTripped = JSON.parse(JSON.stringify(json)) as typeof json;
    assert.equal(roundTripped.usage?.total.costUsd, null);
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

  it('prints every run under `runs`, newest first', async () => {
    const older = populatedRun(repo.root, new Date('2026-08-11T10:00:00Z'));
    const newer = populatedRun(repo.root, new Date('2026-08-11T11:00:00Z'));
    newer.shortId = 'ccc333';

    for (const state of [older, newer]) await persist(state);

    const parsed = JSON.parse(await captureStatus([undefined, { json: true }])) as JsonDocument<{
      runs: RunJson[];
    }>;
    assert.equal(parsed.schema, SCHEMA_VERSION);
    assert.ok(Array.isArray(parsed.runs));
    assert.equal(parsed.runs.length, 2);
    // Newest first, matching the human listing.
    assert.equal(parsed.runs[0]?.runId, newer.runId);
    assert.equal(parsed.runs[1]?.runId, older.runId);
  });

  it('prints an empty list when there are no runs, not prose', async () => {
    assert.deepEqual(JSON.parse(await captureStatus([undefined, { json: true }])), {
      schema: SCHEMA_VERSION,
      command: 'status',
      runs: [],
    });
  });

  it('prints a single run under `run` for a named run', async () => {
    const state = populatedRun(repo.root);
    await persist(state);

    const parsed = JSON.parse(await captureStatus([state.shortId, { json: true }])) as { run: RunJson };
    assert.equal(parsed.run.runId, state.runId);
    assert.equal(parsed.run.issue?.number, 142);
    assert.equal(parsed.run.branch, 'relay/142-aaa111');
  });

  it('resolves "latest" like every other run reference', async () => {
    const state = populatedRun(repo.root);
    await persist(state);

    const parsed = JSON.parse(await captureStatus(['latest', { json: true }])) as { run: RunJson };
    assert.equal(parsed.run.runId, state.runId);
  });

  it('emits nothing but the JSON document', async () => {
    const state = populatedRun(repo.root);
    await persist(state);

    const output = await captureStatus([state.shortId, { json: true }]);
    assert.ok(output.trimStart().startsWith('{'));
    assert.ok(output.trimEnd().endsWith('}'));
    assert.ok(!output.includes('\u001B'));
  });

  it('marks a completed run whose diff was never committed as unlanded', async () => {
    // A real branch, still pointing at the commit the run branched from: the
    // shape of every finished run Relay has not committed.
    const baseSha = await repo.git('rev-parse', 'HEAD');
    const state = populatedRun(repo.root);
    state.workspace = { ...state.workspace!, branch: 'relay/142-aaa111', baseSha };
    transition(state, 'FETCHING_ISSUE');
    for (const phase of ['CREATING_WORKSPACE', 'PLANNING', 'REVIEWING_PLAN', 'IMPLEMENTING', 'REVIEWING_CODE', 'TESTING', 'DELIVERING', 'COMPLETE'] as const) {
      transition(state, phase);
    }
    await repo.git('branch', 'relay/142-aaa111', baseSha);
    await persist(state);

    const parsed = (JSON.parse(await captureStatus([state.shortId, { json: true }])) as { run: RunJson }).run;
    assert.equal(parsed.landing, 'unlanded');
    assert.equal(parsed.unlanded, true);
    assert.equal(parsed.commit, null);

    // The human listing flags it too, rather than reporting a clean success.
    assert.match(await captureStatus([undefined, {}]), /unlanded/);

    // Once something is committed on the branch, it is no longer stranded.
    await repo.writeFile('landed.txt', 'work\n');
    await repo.git('add', '-A');
    await repo.git('commit', '-q', '-m', 'work');
    await repo.git('branch', '-f', 'relay/142-aaa111', 'HEAD');

    const landed = (JSON.parse(await captureStatus([state.shortId, { json: true }])) as { run: RunJson }).run;
    assert.equal(landed.landing, 'committed');
    assert.equal(landed.unlanded, false);
  });

  it('reports a commit Relay made without having to ask git', async () => {
    const state = populatedRun(repo.root);
    state.commit = {
      sha: 'f'.repeat(40),
      branch: 'relay/142-aaa111',
      subject: 'Add authentication rate limiting (#142)',
      at: '2026-08-11T10:07:00Z',
    };

    const json = runToJson(state);
    assert.equal(json.landing, 'committed');
    assert.equal(json.unlanded, false);
    assert.equal(json.commit?.subject, 'Add authentication rate limiting (#142)');
  });

  it('keeps the human table as the default', async () => {
    const state = populatedRun(repo.root);
    await persist(state);

    const output = await captureStatus([undefined, {}]);
    assert.ok(output.includes('Relay runs in'));
    assert.throws(() => JSON.parse(output));
  });
});

describe('empty states', () => {
  it('tells a new user how to start instead of printing a bare header', async () => {
    const output = await captureStatus([undefined, {}]);

    assert.match(output, /No runs yet/);
    assert.match(output, /relay run <issue-number>/);
    assert.match(output, /relay doctor/);
    assert.ok(!output.includes('Relay runs in'), 'an empty listing has no table to head');
  });

  it('says why a run has no events and what to do about it', async () => {
    const state = populatedRun(repo.root);
    await persist(state);

    const output = await capture(() => logsCommand(state.shortId, {}));
    assert.match(output, /No events recorded/);
    assert.match(output, /no agent has taken a turn yet/);
    assert.match(output, /relay watch/);
  });
});

describe('run outcome summary', () => {
  /** Walks a run to COMPLETE, ten seconds per phase. */
  function completed(root: string): RunState {
    const state = populatedRun(root);
    let at = new Date(state.createdAt).getTime();
    const step = (phase: Parameters<typeof transition>[1]): void => {
      at += 10_000;
      transition(state, phase, { now: new Date(at) });
    };
    for (const phase of [
      'FETCHING_ISSUE',
      'CREATING_WORKSPACE',
      'PLANNING',
      'REVIEWING_PLAN',
      'REVISING_PLAN',
      'REVIEWING_PLAN',
      'IMPLEMENTING',
      'REVIEWING_CODE',
      'TESTING',
      'DELIVERING',
      'COMPLETE',
    ] as const) {
      step(phase);
    }
    return state;
  }

  it('prints one block with phases, result and the next command', async () => {
    const state = completed(repo.root);
    const store = await persist(state);

    const output = await capture(async () => {
      printOutcome(state, store);
      printNextSteps(state, store);
    });

    assert.match(output, /Run complete/);
    // Where the time went, with revision rounds folded into their review.
    assert.match(output, /Phases/);
    assert.match(output, /Planning\s+10\.0s/);
    assert.match(output, /Plan review\s+30\.0s\s+3 rounds/);
    // What it produced.
    assert.match(output, /Changes\s+2 file\(s\), \+40 [−-]7/);
    assert.match(output, /Tests\s+npm test → passed/);
    assert.match(output, /Reviews\s+plan 2 round\(s\), code 1 round\(s\)/);
    assert.match(output, /Usage\s+1\.5k in \/ 300 out · \$0\.12 · 1 turn/);
    // And what to do next.
    assert.match(output, new RegExp(`relay diff ${state.runId}`));
  });

  it('warns that completed work is uncommitted and gives the command that keeps it', async () => {
    const state = completed(repo.root);
    const store = await persist(state);

    const output = await capture(async () => {
      printOutcome(state, store);
      printNextSteps(state, store);
    });
    assert.match(output, /Commit\s+none — the work is staged but uncommitted/);
    // Delivery is idempotent, so the way out of this state is to run it again.
    assert.match(output, new RegExp(`relay deliver ${state.runId}`));
  });

  it('says nothing about committing when the run already committed', async () => {
    const state = completed(repo.root);
    state.commit = {
      sha: 'a'.repeat(40),
      branch: 'relay/142-aaa111',
      subject: 'Add authentication rate limiting (#142)',
      at: '2026-08-11T10:07:00Z',
    };
    const store = await persist(state);

    const output = await capture(async () => {
      printOutcome(state, store);
      printNextSteps(state, store);
    });
    assert.match(output, /Commit\s+aaaaaaaa on relay\/142-aaa111/);
    assert.ok(!output.includes('--commit'), output);
    // Nothing recorded a shortfall, so the closing line offers the next stage
    // rather than explaining a blocker that does not exist.
    assert.match(output, /The work is on relay\/142-aaa111/);
    assert.match(output, new RegExp(`relay deliver ${state.runId} --to pr`));
  });

  it('names the agent that failed, the phase, and the two useful commands', async () => {
    const state = populatedRun(repo.root);
    transition(state, 'FETCHING_ISSUE');
    for (const phase of ['CREATING_WORKSPACE', 'PLANNING', 'REVIEWING_PLAN', 'IMPLEMENTING'] as const) {
      transition(state, phase);
    }
    state.error = { message: 'codex exited with status 1', phase: 'IMPLEMENTING', code: 'AGENT_FAILED' };
    transition(state, 'FAILED');
    const store = await persist(state);

    const output = await capture(async () => {
      printOutcome(state, store);
      printNextSteps(state, store);
    });

    assert.match(output, /Run failed during Implementation/);
    // The implementer is codex by default: the report names it rather than
    // blaming "the run".
    assert.match(output, /codex \(implementer\) did not finish its turn\./);
    assert.match(output, /codex exited with status 1/);
    assert.match(output, new RegExp(`relay logs ${state.runId}`));
    assert.match(output, new RegExp(`relay resume ${state.runId}`));
    // A failed run has no diff worth reviewing, so it does not offer one.
    assert.ok(!output.includes(`relay diff ${state.runId}`), output);
  });

  it('offers a resume for a cancelled run', async () => {
    const state = populatedRun(repo.root);
    transition(state, 'FETCHING_ISSUE');
    transition(state, 'CANCELLED');
    const store = await persist(state);

    const output = await capture(async () => {
      printOutcome(state, store);
      printNextSteps(state, store);
    });
    assert.match(output, /Run cancelled/);
    assert.match(output, new RegExp(`relay resume ${state.runId}`));
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
