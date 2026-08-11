import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { WorkflowEngine } from '../src/workflow/engine.ts';
import type { EngineContext } from '../src/workflow/context.ts';
import { createRunState, type RunState } from '../src/workflow/state.ts';
import { RecordingObserver } from '../src/workflow/observer.ts';
import { RunStore } from '../src/storage/runs.ts';
import { DEFAULT_CONFIG, type RelayConfig } from '../src/storage/config.ts';
import { createRunId, shortId } from '../src/util/ids.ts';
import type { AgentHarness } from '../src/agents/types.ts';
import {
  FakeAgentHarness,
  approveReview,
  planText,
  requestChangesReview,
  responsesText,
  section,
} from './helpers/fakeHarness.ts';
import { createTempRepo, FakeIssueProvider, type TempRepo } from './helpers/tempRepo.ts';

let repo: TempRepo;

beforeEach(async () => {
  repo = await createTempRepo({ withPackageJson: true });
  process.env['RELAY_HOME'] = repo.relayHome;
});

afterEach(async () => {
  delete process.env['RELAY_HOME'];
  await repo.cleanup();
});

/** Implementation side effect: writes a real file so `git diff` is non-empty. */
function writesFile(name: string, contents: string) {
  return async (cwd: string): Promise<void> => {
    await writeFile(join(cwd, name), contents, 'utf8');
  };
}

interface Harness {
  claude: FakeAgentHarness;
  codex: FakeAgentHarness;
}

function buildContext(
  harnesses: Harness,
  options: { config?: Partial<RelayConfig['workflow']>; state?: RunState; signal?: AbortSignal } = {},
): { context: EngineContext; store: RunStore; observer: RecordingObserver; state: RunState } {
  const config = structuredClone(DEFAULT_CONFIG);
  Object.assign(config.workflow, options.config ?? {});

  const state =
    options.state ??
    createRunState({
      runId: createRunId(new Date()),
      shortId: shortId(),
      issueRef: '142',
      repository: { root: repo.root, owner: 'acme', name: 'widgets', defaultBranch: 'main' },
      config,
    });

  const store = new RunStore(repo.root, state.runId);
  const observer = new RecordingObserver();

  const context: EngineContext = {
    state,
    store,
    harnesses: harnesses as unknown as Record<'claude' | 'codex', AgentHarness>,
    issueProvider: new FakeIssueProvider(),
    observer,
    signal: options.signal ?? new AbortController().signal,
  };

  return { context, store, observer, state };
}

/** Agents scripted for a clean run: plan approved first time, code approved first time. */
function happyPathHarnesses(): Harness {
  return {
    claude: new FakeAgentHarness('claude', {
      planner: [{ text: planText() }],
      codeReviewer: [{ text: approveReview('Implementation matches the plan.') }],
    }),
    codex: new FakeAgentHarness('codex', {
      planReviewer: [{ text: approveReview('Plan is sound.') }],
      implementer: [
        {
          text: section('NOTES', 'Edited src/app.ts'),
          effect: writesFile('src/app.ts', 'export const value = 2;\n'),
        },
      ],
    }),
  };
}

describe('workflow engine — happy path', () => {
  it('runs every phase and completes', async () => {
    const harnesses = happyPathHarnesses();
    const { context, store, state } = buildContext(harnesses);

    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'COMPLETE');
    assert.equal(final.error, undefined);
    assert.deepEqual(
      final.history.map((entry) => entry.phase),
      [
        'INITIALIZING',
        'FETCHING_ISSUE',
        'CREATING_WORKSPACE',
        'PLANNING',
        'REVIEWING_PLAN',
        'IMPLEMENTING',
        'REVIEWING_CODE',
        'TESTING',
        'COMPLETE',
      ],
    );

    assert.equal(final.planApproved, true);
    assert.equal(final.rounds.planReview, 1);
    assert.equal(final.rounds.codeReview, 1);
    assert.ok((await store.readArtifact('plan.md'))?.includes('## Summary'));
    assert.ok((await store.readArtifact('issue.md'))?.includes('Add authentication rate limiting'));
    assert.ok((await store.readArtifact('summary.md'))?.includes('Relay run'));
    assert.equal(state.pid, undefined);
  });

  it('gives each role to the configured agent, with reviewers on the other model', async () => {
    const harnesses = happyPathHarnesses();
    const { context } = buildContext(harnesses);
    await new WorkflowEngine(context).run();

    assert.deepEqual(
      harnesses.claude.calls.map((call) => call.role),
      ['planner', 'codeReviewer'],
    );
    assert.deepEqual(
      harnesses.codex.calls.map((call) => call.role),
      ['planReviewer', 'implementer'],
    );
  });

  it('runs read-only roles without write capability', async () => {
    const harnesses = happyPathHarnesses();
    const { context } = buildContext(harnesses);
    await new WorkflowEngine(context).run();

    for (const call of [...harnesses.claude.calls, ...harnesses.codex.calls]) {
      const expected = call.role === 'implementer' ? 'write' : 'read_only';
      assert.equal(call.capability, expected, `${call.role} should be ${expected}`);
    }
  });

  it('measures the diff with git and records it in state', async () => {
    const harnesses = happyPathHarnesses();
    const { context, store } = buildContext(harnesses);
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.diff?.fileCount, 1);
    assert.deepEqual(final.diff?.files, ['src/app.ts']);
    assert.ok((final.diff?.additions ?? 0) > 0);

    const patch = await store.readArtifact(final.diff!.patchFile);
    assert.match(patch ?? '', /export const value = 2;/);
  });

  it('runs the project test command and records the result', async () => {
    const harnesses = happyPathHarnesses();
    const { context } = buildContext(harnesses);
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.tests?.discovered, true);
    assert.deepEqual(final.tests?.command, ['npm', 'test']);
    assert.equal(final.tests?.passed, true);
  });

  it('gives the reviewer the real diff, not the agent summary', async () => {
    const harnesses = happyPathHarnesses();
    const { context } = buildContext(harnesses);
    await new WorkflowEngine(context).run();

    const reviewPrompt = harnesses.claude.calls.find((call) => call.role === 'codeReviewer')?.prompt ?? '';
    assert.match(reviewPrompt, /produced by Relay from git/);
    assert.match(reviewPrompt, /\+export const value = 2;/);
  });
});

describe('workflow engine — plan debate', () => {
  it('sends findings back, revises, and re-reviews in the same sessions', async () => {
    const finding = {
      id: 'F1',
      severity: 'high',
      category: 'architecture',
      summary: 'Ignores the existing RateLimiter',
      evidence: 'src/limit.ts:10',
    };

    const harnesses: Harness = {
      claude: new FakeAgentHarness('claude', {
        planner: [
          { text: planText('First attempt') },
          { text: responsesText([{ findingId: 'F1', response: 'ACCEPT', reasoning: 'Will reuse it' }], '## Summary\nRevised plan reusing RateLimiter') },
        ],
        codeReviewer: [{ text: approveReview() }],
      }),
      codex: new FakeAgentHarness('codex', {
        planReviewer: [{ text: requestChangesReview([finding]) }, { text: approveReview('Now correct.') }],
        implementer: [{ text: section('NOTES', 'done'), effect: writesFile('src/app.ts', 'export const value = 3;\n') }],
      }),
    };

    const { context, store } = buildContext(harnesses);
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'COMPLETE');
    assert.equal(final.rounds.planReview, 2);
    assert.equal(final.planApproved, true);

    // The revised plan replaced the original.
    assert.match((await store.readArtifact('plan.md')) ?? '', /Revised plan reusing RateLimiter/);

    // The revision reached the planner's existing session, and the second
    // review continued the reviewer's session.
    const plannerCalls = harnesses.claude.calls.filter((call) => call.role === 'planner');
    assert.equal(plannerCalls[1]?.resumed, true);
    assert.match(plannerCalls[1]?.prompt ?? '', /Ignores the existing RateLimiter/);

    const reviewerCalls = harnesses.codex.calls.filter((call) => call.role === 'planReviewer');
    assert.equal(reviewerCalls[1]?.resumed, true);

    const round = final.reviews.find((review) => review.kind === 'plan' && review.round === 1);
    assert.equal(round?.responses?.[0]?.response, 'ACCEPT');
  });

  it('stops debating at the round limit and proceeds unapproved', async () => {
    const finding = { id: 'F1', severity: 'high', category: 'correctness', summary: 'Still wrong' };

    const harnesses: Harness = {
      claude: new FakeAgentHarness('claude', {
        planner: [
          { text: planText() },
          ...Array.from({ length: 5 }, () => ({
            text: responsesText([{ findingId: 'F1', response: 'ACCEPT', reasoning: 'ok' }], '## Summary\nagain'),
          })),
        ],
        codeReviewer: [{ text: approveReview() }],
      }),
      codex: new FakeAgentHarness('codex', {
        // Never satisfied.
        planReviewer: Array.from({ length: 5 }, () => ({ text: requestChangesReview([finding]) })),
        implementer: [{ text: section('NOTES', 'done'), effect: writesFile('src/app.ts', 'export const value = 4;\n') }],
      }),
    };

    const { context, observer } = buildContext(harnesses, { config: { maxPlanReviewRounds: 2 } });
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'COMPLETE');
    assert.equal(final.rounds.planReview, 2);
    assert.equal(final.planApproved, false);
    assert.match(observer.warnings.join(' '), /Plan review limit reached/);
  });

  it('keeps the previous plan when the planner rejects every finding', async () => {
    const finding = { id: 'F1', severity: 'high', category: 'correctness', summary: 'Wrong assumption' };

    const harnesses: Harness = {
      claude: new FakeAgentHarness('claude', {
        planner: [
          { text: planText('Original approach') },
          { text: responsesText([{ findingId: 'F1', response: 'REJECT', reasoning: 'src/limit.ts does not exist' }]) },
        ],
        codeReviewer: [{ text: approveReview() }],
      }),
      codex: new FakeAgentHarness('codex', {
        planReviewer: [{ text: requestChangesReview([finding]) }, { text: approveReview() }],
        implementer: [{ text: section('NOTES', 'done'), effect: writesFile('src/app.ts', 'export const value = 5;\n') }],
      }),
    };

    const { context, store, observer } = buildContext(harnesses);
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'COMPLETE');
    assert.match((await store.readArtifact('plan.md')) ?? '', /Original approach/);
    assert.match(observer.warnings.join(' '), /rejected every finding/);
  });
});

describe('workflow engine — code review', () => {
  it('returns only blocking findings to the implementer', async () => {
    const findings = [
      { id: 'F1', severity: 'high', category: 'correctness', summary: 'Off-by-one in the window', impact: 'BLOCKING' },
      { id: 'F2', severity: 'low', category: 'maintainability', summary: 'Rename a variable', impact: 'SUGGESTION' },
    ];

    const harnesses: Harness = {
      claude: new FakeAgentHarness('claude', {
        planner: [{ text: planText() }],
        codeReviewer: [{ text: requestChangesReview(findings) }, { text: approveReview('Fixed.') }],
      }),
      codex: new FakeAgentHarness('codex', {
        planReviewer: [{ text: approveReview() }],
        implementer: [
          { text: section('NOTES', 'first pass'), effect: writesFile('src/app.ts', 'export const value = 6;\n') },
          {
            text: responsesText([{ findingId: 'F1', response: 'ACCEPT', reasoning: 'fixed the boundary' }]),
            effect: writesFile('src/app.ts', 'export const value = 7;\n'),
          },
        ],
      }),
    };

    const { context } = buildContext(harnesses);
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'COMPLETE');
    assert.equal(final.rounds.codeReview, 2);

    const revisionPrompt = harnesses.codex.calls.filter((call) => call.role === 'implementer')[1]?.prompt ?? '';
    assert.match(revisionPrompt, /Off-by-one in the window/);
    // The suggestion was not sent back; it costs a round and was not blocking.
    assert.ok(!revisionPrompt.includes('Rename a variable'));
  });

  it('surfaces unaddressed findings in the summary rather than dropping them', async () => {
    const findings = [
      { id: 'F1', severity: 'medium', category: 'testing', summary: 'No test for the error path', impact: 'NON_BLOCKING' },
    ];

    const harnesses: Harness = {
      claude: new FakeAgentHarness('claude', {
        planner: [{ text: planText() }],
        codeReviewer: [{ text: requestChangesReview(findings) }],
      }),
      codex: new FakeAgentHarness('codex', {
        planReviewer: [{ text: approveReview() }],
        implementer: [{ text: section('NOTES', 'done'), effect: writesFile('src/app.ts', 'export const value = 8;\n') }],
      }),
    };

    const { context, store } = buildContext(harnesses);
    const final = await new WorkflowEngine(context).run();

    // No blocking findings, so the run proceeds — but the finding is reported.
    assert.equal(final.phase, 'COMPLETE');
    assert.equal(final.rounds.codeReview, 1);
    assert.match((await store.readArtifact('summary.md')) ?? '', /Unresolved findings/);
    assert.match((await store.readArtifact('summary.md')) ?? '', /No test for the error path/);
  });

  it('stops at the code review round limit', async () => {
    const finding = { id: 'F1', severity: 'critical', category: 'security', summary: 'Still broken', impact: 'BLOCKING' };

    const harnesses: Harness = {
      claude: new FakeAgentHarness('claude', {
        planner: [{ text: planText() }],
        codeReviewer: Array.from({ length: 4 }, () => ({ text: requestChangesReview([finding]) })),
      }),
      codex: new FakeAgentHarness('codex', {
        planReviewer: [{ text: approveReview() }],
        implementer: [
          { text: section('NOTES', 'first'), effect: writesFile('src/app.ts', 'export const value = 9;\n') },
          ...Array.from({ length: 4 }, (_, index) => ({
            text: responsesText([{ findingId: 'F1', response: 'ACCEPT', reasoning: 'tried again' }]),
            effect: writesFile('src/app.ts', `export const value = ${10 + index};\n`),
          })),
        ],
      }),
    };

    const { context, observer } = buildContext(harnesses, { config: { maxCodeReviewRounds: 2 } });
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'COMPLETE');
    assert.equal(final.rounds.codeReview, 2);
    assert.match(observer.warnings.join(' '), /Code review limit reached/);
  });
});

describe('workflow engine — failure handling', () => {
  it('fails the run when an agent subprocess fails', async () => {
    const harnesses: Harness = {
      claude: new FakeAgentHarness('claude', {
        planner: [{ text: '', ok: false, error: 'claude exited with code 1' }],
      }),
      codex: new FakeAgentHarness('codex'),
    };

    const { context, store } = buildContext(harnesses);
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'FAILED');
    assert.equal(final.error?.phase, 'PLANNING');
    assert.match(final.error?.message ?? '', /claude exited with code 1/);
    assert.match((await store.readArtifact('summary.md')) ?? '', /Failure/);
  });

  it('does not trust an implementer that changed nothing', async () => {
    const harnesses: Harness = {
      claude: new FakeAgentHarness('claude', {
        planner: [{ text: planText() }],
      }),
      codex: new FakeAgentHarness('codex', {
        planReviewer: [{ text: approveReview() }],
        // Claims success, touches no files.
        implementer: [{ text: section('NOTES', 'All done! Implemented everything.') }],
      }),
    };

    const { context } = buildContext(harnesses);
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'FAILED');
    assert.equal(final.error?.phase, 'IMPLEMENTING');
    assert.match(final.error?.message ?? '', /changed no files/);
  });

  it('asks once for a re-send when structured output does not parse', async () => {
    const harnesses: Harness = {
      claude: new FakeAgentHarness('claude', {
        planner: [{ text: planText() }],
        codeReviewer: [{ text: approveReview() }],
      }),
      codex: new FakeAgentHarness('codex', {
        planReviewer: [{ text: 'The plan looks fine to me, honestly.' }, { text: approveReview() }],
        implementer: [{ text: section('NOTES', 'done'), effect: writesFile('src/app.ts', 'export const value = 20;\n') }],
      }),
    };

    const { context, observer } = buildContext(harnesses);
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'COMPLETE');
    // One review round, but two calls: the original plus the repair.
    assert.equal(final.rounds.planReview, 1);
    const reviewerCalls = harnesses.codex.calls.filter((call) => call.role === 'planReviewer');
    assert.equal(reviewerCalls.length, 2);
    assert.equal(reviewerCalls[1]?.resumed, true);
    assert.match(reviewerCalls[1]?.prompt ?? '', /could not be parsed/);
    assert.match(observer.warnings.join(' '), /unparseable/);
  });

  it('fails when the agent cannot produce parseable output even after a retry', async () => {
    const harnesses: Harness = {
      claude: new FakeAgentHarness('claude', { planner: [{ text: planText() }] }),
      codex: new FakeAgentHarness('codex', {
        planReviewer: [{ text: 'nope' }, { text: 'still nope' }],
      }),
    };

    const { context } = buildContext(harnesses);
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'FAILED');
    assert.match(final.error?.message ?? '', /could not produce parseable output/);
  });

  it('fails cleanly when a required agent is unavailable', async () => {
    const harnesses: Harness = {
      claude: new FakeAgentHarness('claude').setAvailability({
        available: false,
        detail: 'not found',
        hint: 'Install Claude Code.',
      }),
      codex: new FakeAgentHarness('codex'),
    };

    const { context, observer } = buildContext(harnesses);
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'FAILED');
    assert.equal(final.error?.phase, 'INITIALIZING');
    assert.match(observer.notes.join(' ') + observer.warnings.join(' '), /Install Claude Code/);
  });
});

describe('workflow engine — cancellation and resume', () => {
  it('cancels at a phase boundary when the sentinel file is present', async () => {
    const harnesses = happyPathHarnesses();
    const { context, store, state } = buildContext(harnesses);

    // Simulate `relay stop` landing after the first phase by requesting
    // cancellation from inside the observer.
    const original = context.observer.phaseChanged.bind(context.observer);
    context.observer.phaseChanged = (phase, detail): void => {
      original(phase, detail);
      if (phase === 'PLANNING') void store.requestCancel('test');
    };

    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'CANCELLED');
    assert.ok(final.finishedAt !== undefined);
    // The workspace survives cancellation.
    assert.ok(state.workspace !== undefined);
  });

  it('stops when the abort signal fires', async () => {
    const controller = new AbortController();
    const harnesses = happyPathHarnesses();
    const { context } = buildContext(harnesses, { signal: controller.signal });
    controller.abort();

    const final = await new WorkflowEngine(context).run();
    assert.equal(final.phase, 'CANCELLED');
  });

  it('resumes an interrupted run from its persisted phase, reusing the worktree', async () => {
    // First attempt: the planner fails, so the run stops after the workspace exists.
    const failing: Harness = {
      claude: new FakeAgentHarness('claude', { planner: [{ text: '', ok: false, error: 'network blip' }] }),
      codex: new FakeAgentHarness('codex'),
    };

    const first = buildContext(failing);
    const failed = await new WorkflowEngine(first.context).run();

    assert.equal(failed.phase, 'FAILED');
    const workspacePath = failed.workspace?.path;
    assert.ok(workspacePath !== undefined);

    // Reload state from disk exactly as `relay resume` does.
    const reloaded = await new RunStore(repo.root, failed.runId).loadState();
    reloaded.phase = 'PLANNING';
    delete reloaded.error;
    delete reloaded.finishedAt;

    const second = buildContext(happyPathHarnesses(), { state: reloaded });
    const final = await new WorkflowEngine(second.context).run();

    assert.equal(final.phase, 'COMPLETE');
    // Same worktree and branch: the run continued rather than starting over.
    assert.equal(final.workspace?.path, workspacePath);
    assert.equal(final.issue?.number, 142);

    // The issue was fetched once, in the first attempt.
    const events = await new RunStore(repo.root, failed.runId).readEvents();
    assert.ok(events.some((event) => event.phase === 'PLANNING' && event.type === 'phase_failed'));
  });

  it('keeps a complete audit trail of every phase and agent turn', async () => {
    const harnesses = happyPathHarnesses();
    const { context, store } = buildContext(harnesses);
    await new WorkflowEngine(context).run();

    const events = await store.readEvents();
    const types = new Set(events.map((event) => event.type));

    assert.ok(types.has('phase_started'));
    assert.ok(types.has('phase_completed'));
    assert.ok(types.has('turn_completed'));
    assert.ok(types.has('tests'));

    // Every event carries the fields the log format promises.
    for (const event of events) {
      assert.ok(typeof event.timestamp === 'string' && event.timestamp.length > 0);
      assert.ok(typeof event.runId === 'string');
      assert.ok(typeof event.phase === 'string');
      assert.ok(typeof event.type === 'string');
    }

    // Invocations are recorded so a run can be explained after the fact.
    const turn = events.find((event) => event.type === 'turn_completed');
    assert.match(String(turn?.data?.['invocation'] ?? ''), /--fake/);
  });
});

describe('workflow engine — tests phase', () => {
  it('records a failing suite without failing the run', async () => {
    await writeFile(
      join(repo.root, 'package.json'),
      JSON.stringify({ name: 'temp', scripts: { test: 'node -e "process.exit(1)"' } }, null, 2),
      'utf8',
    );
    await repo.commit('failing tests');

    const harnesses = happyPathHarnesses();
    const { context, observer } = buildContext(harnesses);
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'COMPLETE');
    assert.equal(final.tests?.passed, false);
    assert.equal(final.tests?.exitCode, 1);
    assert.match(observer.warnings.join(' '), /Tests failed/);
  });

  it('skips tests when the project has none', async () => {
    await writeFile(join(repo.root, 'package.json'), JSON.stringify({ name: 'temp' }), 'utf8');
    await repo.commit('no test script');

    const harnesses = happyPathHarnesses();
    const { context } = buildContext(harnesses);
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'COMPLETE');
    assert.equal(final.tests?.discovered, false);
    assert.match(final.tests?.skippedReason ?? '', /no scripts.test/);
  });

  it('honours workflow.runTests = false', async () => {
    const harnesses = happyPathHarnesses();
    const { context } = buildContext(harnesses, { config: { runTests: false } });
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.tests?.discovered, false);
    assert.match(final.tests?.skippedReason ?? '', /disabled/);
  });
});

describe('run artifacts', () => {
  it('writes the artifact chain agents exchanged', async () => {
    const harnesses = happyPathHarnesses();
    const { context, store } = buildContext(harnesses);
    const final = await new WorkflowEngine(context).run();

    for (const artifact of ['issue.md', 'plan.md', 'summary.md', 'implementation-notes.md', 'state.json']) {
      assert.ok((await store.readArtifact(artifact)) !== undefined, `missing ${artifact}`);
    }

    assert.ok((await store.readArtifact('reviews/plan-round-1.json')) !== undefined);
    assert.ok((await store.readArtifact('reviews/code-round-1.json')) !== undefined);
    assert.ok((await store.readArtifact(final.diff!.patchFile)) !== undefined);

    const summary = await readFile(store.path('summary.md'), 'utf8');
    assert.match(summary, /does not push, merge, or open pull requests/);
  });
});
