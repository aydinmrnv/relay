import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { WorkflowEngine } from '../src/workflow/engine.ts';
import { RunStore } from '../src/storage/runs.ts';
import {
  FakeAgentHarness,
  approveReview,
  planText,
  requestChangesReview,
  responsesText,
  section,
} from './helpers/fakeHarness.ts';
import {
  buildEngineContext,
  happyPathHarnesses,
  writesFile,
  type BuildContextOptions,
  type Harness,
} from './helpers/engine.ts';
import { createTempRepo, type TempRepo } from './helpers/tempRepo.ts';

let repo: TempRepo;

beforeEach(async () => {
  repo = await createTempRepo({ withPackageJson: true });
  process.env['RELAY_HOME'] = repo.relayHome;
});

afterEach(async () => {
  delete process.env['RELAY_HOME'];
  await repo.cleanup();
});

function buildContext(harnesses: Harness, options: BuildContextOptions = {}) {
  return buildEngineContext(repo, harnesses, options);
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
        'DELIVERING',
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

    // Each reviewer takes two turns: reading ahead during the phase it will
    // review, then the review itself in that same session.
    assert.deepEqual(
      harnesses.claude.calls.map((call) => `${call.role}${call.purpose === undefined ? '' : `:${call.purpose}`}`),
      ['planner', 'codeReviewer:prime', 'codeReviewer'],
    );
    assert.deepEqual(
      harnesses.codex.calls.map((call) => `${call.role}${call.purpose === undefined ? '' : `:${call.purpose}`}`),
      ['planReviewer:prime', 'planReviewer', 'implementer'],
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

  it('accumulates the tokens each turn reported, per phase and per run', async () => {
    const harnesses: Harness = {
      claude: new FakeAgentHarness('claude', {
        planner: [{ text: planText(), usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.1 } }],
        codeReviewer: [{ text: approveReview(), usage: { inputTokens: 400, outputTokens: 40, costUsd: 0.05 } }],
      }),
      codex: new FakeAgentHarness('codex', {
        // Codex reports tokens but no price, as the real CLI does.
        planReviewer: [{ text: approveReview(), usage: { inputTokens: 500, outputTokens: 50 } }],
        implementer: [
          {
            text: section('NOTES', 'Edited src/app.ts'),
            effect: writesFile('src/app.ts', 'export const value = 2;\n'),
            usage: { inputTokens: 2000, outputTokens: 800 },
          },
        ],
      }),
    };

    const { context, store } = buildContext(harnesses);
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'COMPLETE');
    assert.equal(final.usage?.total.inputTokens, 3900);
    assert.equal(final.usage?.total.outputTokens, 1090);
    assert.equal(final.usage?.total.turns, 4);
    // Only the two Claude turns priced themselves; the total says so honestly.
    assert.ok(Math.abs((final.usage?.total.costUsd ?? 0) - 0.15) < 1e-9);

    assert.equal(final.usage?.byPhase.PLANNING?.inputTokens, 1000);
    assert.equal(final.usage?.byPhase.REVIEWING_PLAN?.inputTokens, 500);
    assert.equal(final.usage?.byPhase.IMPLEMENTING?.outputTokens, 800);
    assert.equal(final.usage?.byPhase.REVIEWING_PLAN?.costUsd, undefined);
    assert.equal(final.usage?.byPhase.TESTING, undefined);

    assert.match((await store.readArtifact('summary.md')) ?? '', /- Usage: 3\.9k in \/ 1\.1k out · \$0\.15 · 4 turns/);
  });

  it('records nothing when no CLI reports usage', async () => {
    const { context } = buildContext(happyPathHarnesses());
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.usage, undefined);
    assert.ok(!((await new RunStore(repo.root, final.runId).readArtifact('summary.md')) ?? '').includes('Usage'));
  });

  it('gives the reviewer the real diff, not the agent summary', async () => {
    const harnesses = happyPathHarnesses();
    const { context } = buildContext(harnesses);
    await new WorkflowEngine(context).run();

    const reviewPrompt =
      harnesses.claude.calls.find((call) => call.role === 'codeReviewer' && call.purpose === undefined)?.prompt ?? '';
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
    const reviewerCalls = harnesses.codex.calls.filter(
      (call) => call.role === 'planReviewer' && call.purpose === undefined,
    );
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

describe('workflow engine — transient failures', () => {
  it('retries a rate-limited turn with backoff and finishes the run', async () => {
    const delays: number[] = [];
    const harnesses = happyPathHarnesses();
    harnesses.claude = new FakeAgentHarness('claude', {
      planner: [
        { text: '', ok: false, error: 'claude exited with code 1: API Error: 429 rate_limit_error' },
        { text: '', ok: false, error: 'claude exited with code 1: API Error: 429 rate_limit_error' },
        { text: planText() },
      ],
      codeReviewer: [{ text: approveReview() }],
    });

    const { context, observer, store } = buildContext(harnesses, { delays });
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'COMPLETE');
    assert.equal(harnesses.claude.calls.filter((call) => call.role === 'planner').length, 3);

    // Backoff grew between attempts, and no retry was silent.
    assert.equal(delays.length, 2);
    assert.ok(delays[1]! > delays[0]!);
    assert.equal(observer.warnings.filter((line) => /transient error/.test(line)).length, 2);

    const events = await store.readEvents();
    assert.equal(events.filter((event) => event.type === 'notice' && /retrying in/.test(String(event.data?.['text']))).length, 2);
    assert.equal(events.filter((event) => event.type === 'turn_failed').length, 2);
  });

  it('does not retry an authentication failure', async () => {
    const delays: number[] = [];
    const harnesses: Harness = {
      claude: new FakeAgentHarness('claude', {
        planner: [
          { text: '', ok: false, error: 'claude exited with code 1: 401 Unauthorized' },
          { text: planText() },
        ],
      }),
      codex: new FakeAgentHarness('codex'),
    };

    const { context } = buildContext(harnesses, { delays });
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'FAILED');
    assert.equal(final.error?.phase, 'PLANNING');
    assert.equal(harnesses.claude.calls.filter((call) => call.role === 'planner').length, 1);
    assert.deepEqual(delays, []);
  });

  it('gives up after the configured number of retries', async () => {
    const delays: number[] = [];
    const harnesses: Harness = {
      claude: new FakeAgentHarness('claude', {
        planner: Array.from({ length: 5 }, () => ({
          text: '',
          ok: false,
          error: 'claude exited with code 1: 503 Service Unavailable',
        })),
      }),
      codex: new FakeAgentHarness('codex'),
    };

    const { context } = buildContext(harnesses, { delays, config: { maxTransientRetries: 1 } });
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'FAILED');
    assert.equal(harnesses.claude.calls.filter((call) => call.role === 'planner').length, 2);
    assert.equal(delays.length, 1);
    assert.match(final.error?.message ?? '', /after 2 attempts/);
  });

  it('honours maxTransientRetries = 0', async () => {
    const harnesses: Harness = {
      claude: new FakeAgentHarness('claude', {
        planner: [
          { text: '', ok: false, error: 'claude exited with code 1: rate limit exceeded' },
          { text: planText() },
        ],
      }),
      codex: new FakeAgentHarness('codex'),
    };

    const { context } = buildContext(harnesses, { config: { maxTransientRetries: 0 } });
    assert.equal((await new WorkflowEngine(context).run()).phase, 'FAILED');
    assert.equal(harnesses.claude.calls.filter((call) => call.role === 'planner').length, 1);
  });

  it('resumes the failed session when the CLI reported one, and starts fresh when it did not', async () => {
    const harnesses = happyPathHarnesses();
    harnesses.claude = new FakeAgentHarness('claude', {
      planner: [
        // Died before the CLI announced a session: there is nothing to resume.
        { text: '', ok: false, started: false, error: 'claude exited with code 1: ECONNRESET' },
        { text: '', ok: false, error: 'claude exited with code 1: ECONNRESET' },
        { text: planText() },
      ],
      codeReviewer: [{ text: approveReview() }],
    });

    const { context } = buildContext(harnesses);
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'COMPLETE');
    const plannerCalls = harnesses.claude.calls.filter((call) => call.role === 'planner');
    assert.deepEqual(
      plannerCalls.map((call) => call.resumed),
      [false, false, true],
    );
  });

  it('records the tokens a failed attempt spent as well as the successful one', async () => {
    const harnesses = happyPathHarnesses();
    harnesses.claude = new FakeAgentHarness('claude', {
      planner: [
        {
          text: '',
          ok: false,
          error: 'claude exited with code 1: 429 rate limit',
          usage: { inputTokens: 900, outputTokens: 10 },
        },
        { text: planText(), usage: { inputTokens: 1000, outputTokens: 200 } },
      ],
      codeReviewer: [{ text: approveReview() }],
    });

    const { context } = buildContext(harnesses);
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'COMPLETE');
    assert.equal(final.usage?.byPhase.PLANNING?.inputTokens, 1900);
    assert.equal(final.usage?.byPhase.PLANNING?.turns, 2);
  });
});

describe('workflow engine — delivering the work', () => {
  it('commits to the run branch, crediting every agent that contributed', async () => {
    const { context, state } = buildContext(happyPathHarnesses(), { config: { deliver: 'branch' } });
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'COMPLETE');
    assert.ok(final.commit !== undefined);
    assert.equal(final.commit?.branch, state.workspace?.branch);

    const worktree = final.workspace!.path;
    const log = await repo.git('-C', worktree, 'log', '-1', '--format=%H%n%B');
    assert.ok(log.startsWith(final.commit!.sha));
    assert.match(log, /Add authentication rate limiting \(#142\)/);
    assert.match(log, /Co-Authored-By: Claude <noreply@anthropic\.com>/);
    assert.match(log, /Co-Authored-By: Codex <noreply@openai\.com>/);
    assert.match(log, /Tests: `npm test` passed/);

    // The commit lands on the run branch only — main is untouched.
    assert.equal(await repo.git('-C', worktree, 'status', '--porcelain'), '');
    assert.equal(await repo.git('rev-parse', 'main'), final.workspace!.baseSha);
  });

  it('leaves the work in the worktree when delivery is off', async () => {
    const { context, store } = buildContext(happyPathHarnesses(), { config: { deliver: 'none' } });
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.commit, undefined);
    assert.equal(await repo.git('-C', final.workspace!.path, 'rev-parse', 'HEAD'), final.workspace!.baseSha);
    assert.match((await store.readArtifact('summary.md')) ?? '', /not committed/);
    assert.equal(final.delivery?.reached, 'none');
  });

  it('does not fail the run when the commit itself fails', async () => {
    const { context, observer } = buildContext(happyPathHarnesses(), { config: { deliver: 'branch' } });
    const engine = new WorkflowEngine(context);

    // The worktree disappears between the last phase and the commit.
    const original = context.observer.phaseChanged.bind(context.observer);
    context.observer.phaseChanged = (phase, detail): void => {
      original(phase, detail);
      if (phase === 'TESTING') context.state.workspace = { ...context.state.workspace!, path: '/nonexistent/worktree' };
    };

    const final = await engine.run();
    assert.equal(final.phase, 'COMPLETE');
    assert.equal(final.commit, undefined);
    assert.match(observer.warnings.join(' '), /Could not commit/);
    // The step is recorded as skipped rather than silently missing.
    assert.equal(final.delivery?.steps.find((step) => step.step === 'commit')?.status, 'skipped');
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
    assert.match(summary, /## Delivery/);
    assert.match(summary, new RegExp(`relay deliver ${final.runId}`));
  });
});
