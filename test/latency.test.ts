import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

import { WorkflowEngine } from '../src/workflow/engine.ts';
import { DEFAULT_CONFIG, mergeConfig } from '../src/storage/config.ts';
import { displayPhasesFor } from '../src/workflow/phases.ts';
import { RelayError } from '../src/util/errors.ts';
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

/** The turns that did real work, with the reviewers' read-ahead filtered out. */
function workTurns(harness: FakeAgentHarness, role: string) {
  return harness.calls.filter((call) => call.role === role && call.purpose === undefined);
}

function primeTurns(harness: FakeAgentHarness, role: string) {
  return harness.calls.filter((call) => call.role === role && call.purpose === 'prime');
}

describe('reviewer priming', () => {
  it('starts the plan reviewer during planning and reviews in that same session', async () => {
    const harnesses = happyPathHarnesses();
    const { context } = buildContext(harnesses);
    await new WorkflowEngine(context).run();

    const primes = primeTurns(harnesses.codex, 'planReviewer');
    assert.equal(primes.length, 1);
    assert.match(primes[0]?.prompt ?? '', /read ahead/);
    // Priming is reading, never a verdict: it must not be asked for one.
    assert.ok(!/adversarially review/.test(primes[0]?.prompt ?? ''));

    // The review continued the primed conversation rather than starting cold.
    const review = workTurns(harnesses.codex, 'planReviewer')[0];
    assert.equal(review?.resumed, true);
    assert.equal(review?.sessionId, primes[0]?.sessionId);
    assert.match(review?.prompt ?? '', /already read this repository/);
  });

  it('primes the code reviewer while the implementer writes the code', async () => {
    const harnesses = happyPathHarnesses();
    const { context } = buildContext(harnesses);
    await new WorkflowEngine(context).run();

    // Started before the implementer's turn finished, so it overlaps the work.
    const order = harnesses.claude.calls.map((call) => call.purpose ?? 'work');
    assert.deepEqual(order, ['work', 'prime', 'work']);

    const prime = primeTurns(harnesses.claude, 'codeReviewer')[0];
    assert.match(prime?.prompt ?? '', /implementing this issue right now/);
    // It is primed on the plan, which exists by then.
    assert.match(prime?.prompt ?? '', /## The plan being implemented/);

    assert.equal(workTurns(harnesses.claude, 'codeReviewer')[0]?.resumed, true);
  });

  it('attributes a primed turn to the phase it belongs to, not the one it ran in', async () => {
    const harnesses: Harness = {
      claude: new FakeAgentHarness('claude', {
        planner: [{ text: planText() }],
        codeReviewer: [{ text: approveReview() }],
      }),
      codex: new FakeAgentHarness('codex', {
        'planReviewer:prime': [{ text: 'read the code', usage: { inputTokens: 700, outputTokens: 30 } }],
        planReviewer: [{ text: approveReview() }],
        implementer: [{ text: section('NOTES', 'done'), effect: writesFile('src/app.ts', 'export const v = 1;\n') }],
      }),
    };

    const { context, store } = buildContext(harnesses);
    const final = await new WorkflowEngine(context).run();

    // The tokens belong to the review, even though they were spent while the
    // planner was still planning.
    assert.equal(final.usage?.byPhase.REVIEWING_PLAN?.inputTokens, 700);
    assert.equal(final.usage?.byPhase.PLANNING?.inputTokens, undefined);

    const events = await store.readEvents();
    const primed = events.find((event) => event.data?.['purpose'] === 'prime');
    assert.equal(primed?.phase, 'REVIEWING_PLAN');
  });

  it('falls back to a cold review when the read-ahead fails', async () => {
    const harnesses = happyPathHarnesses();
    harnesses.codex.script('planReviewer:prime', { text: '', ok: false, error: 'rate limited' });

    const { context, observer } = buildContext(harnesses, { config: { maxTransientRetries: 0 } });
    const final = await new WorkflowEngine(context).run();

    // A speculative turn must never be able to take a run down.
    assert.equal(final.phase, 'COMPLETE');

    const review = workTurns(harnesses.codex, 'planReviewer')[0];
    assert.equal(review?.resumed, false);
    assert.ok(!/already read this repository/.test(review?.prompt ?? ''));
    assert.match(observer.notes.join(' '), /could not read ahead/);
  });

  it('abandons a read-ahead that is still going when its review comes up', async () => {
    // A reviewer that is still reading when its turn arrives. Waiting for it
    // would invert the whole point, so the review starts without it.
    let release = (): void => {};
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });

    const harnesses = happyPathHarnesses();
    harnesses.codex.script('planReviewer:prime', {
      text: 'still reading',
      effect: async () => {
        await stalled;
      },
    });

    const { context, observer, state } = buildContext(harnesses);
    state.config.timeouts.primeGraceMs = 50;

    // The stalled turn is a fake with no process to kill, so the test plays the
    // part the OS plays in a real run and lets it die shortly after the abort.
    const timer = setTimeout(400).then(release);

    const final = await new WorkflowEngine(context).run();
    await timer;

    assert.equal(final.phase, 'COMPLETE');
    assert.match(observer.notes.join(' '), /still reading when its review came up/);

    // Cold, not resumed into a half-finished reading.
    const review = workTurns(harnesses.codex, 'planReviewer')[0];
    assert.equal(review?.resumed, false);
    assert.ok(!/already read this repository/.test(review?.prompt ?? ''));
  });

  it('primes nobody when the run asks not to', async () => {
    const harnesses = happyPathHarnesses();
    const { context } = buildContext(harnesses, { config: { primeReviewers: false } });
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'COMPLETE');
    assert.equal(primeTurns(harnesses.codex, 'planReviewer').length, 0);
    assert.equal(primeTurns(harnesses.claude, 'codeReviewer').length, 0);
    assert.equal(workTurns(harnesses.codex, 'planReviewer')[0]?.resumed, false);
  });

  it('still resumes the reviewer between rounds', async () => {
    const finding = { id: 'F1', severity: 'high', category: 'correctness', summary: 'Wrong module' };

    const harnesses: Harness = {
      claude: new FakeAgentHarness('claude', {
        planner: [
          { text: planText() },
          { text: responsesText([{ findingId: 'F1', response: 'ACCEPT', reasoning: 'fixed' }], '## Summary\nv2') },
        ],
        codeReviewer: [{ text: approveReview() }],
      }),
      codex: new FakeAgentHarness('codex', {
        planReviewer: [{ text: requestChangesReview([finding]) }, { text: approveReview() }],
        implementer: [{ text: section('NOTES', 'done'), effect: writesFile('src/app.ts', 'export const v = 2;\n') }],
      }),
    };

    const { context } = buildContext(harnesses);
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.rounds.planReview, 2);
    const reviews = workTurns(harnesses.codex, 'planReviewer');
    assert.deepEqual(
      reviews.map((call) => call.resumed),
      [true, true],
    );
  });
});

describe('tests alongside the code review', () => {
  /** Resolves once `name` appears in the worktree, or false after `timeoutMs`. */
  async function waitForFile(cwd: string, name: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await access(join(cwd, name));
        return true;
      } catch {
        if (Date.now() > deadline) return false;
        await setTimeout(10);
      }
    }
  }

  it('has the suite already running when the reviewer starts reading', async () => {
    let testsWereRunning = false;

    const harnesses = happyPathHarnesses();
    harnesses.claude = new FakeAgentHarness('claude', {
      planner: [{ text: planText() }],
      codeReviewer: [
        {
          text: approveReview(),
          // Runs at the top of the review turn: if the marker the suite writes
          // is already there, the two really are overlapping rather than
          // taking turns.
          effect: async (cwd: string) => {
            testsWereRunning = await waitForFile(cwd, 'suite-started', 2_000);
          },
        },
      ],
    });

    const { context, state } = buildContext(harnesses);
    state.config.tests.command = [
      'node',
      '-e',
      'require("node:fs").writeFileSync("suite-started","1");setTimeout(()=>process.exit(0),300)',
    ];

    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'COMPLETE');
    assert.equal(testsWereRunning, true, 'the suite should already be running during the code review');
    assert.equal(final.tests?.passed, true);
  });

  it('runs the suite during the review and reports it as evidence', async () => {
    const harnesses = happyPathHarnesses();
    const { context, observer } = buildContext(harnesses);
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.tests?.passed, true);
    assert.deepEqual(final.tests?.command, ['npm', 'test']);
    assert.match(observer.notes.join('\n'), /Tests ran alongside the code review/);

    // The reviewer is told not to duplicate the run Relay is already doing.
    const review = workTurns(harnesses.claude, 'codeReviewer')[0];
    assert.match(review?.prompt ?? '', /running this project's test suite against this exact diff right now/);
  });

  it('discards a suite that ran against code the revision replaced', async () => {
    const finding = { id: 'F1', severity: 'high', category: 'correctness', summary: 'Broken', impact: 'BLOCKING' };

    const harnesses: Harness = {
      claude: new FakeAgentHarness('claude', {
        planner: [{ text: planText() }],
        codeReviewer: [{ text: requestChangesReview([finding]) }, { text: approveReview('Fixed.') }],
      }),
      codex: new FakeAgentHarness('codex', {
        planReviewer: [{ text: approveReview() }],
        implementer: [
          { text: section('NOTES', 'first pass'), effect: writesFile('src/app.ts', 'export const value = 31;\n') },
          {
            text: responsesText([{ findingId: 'F1', response: 'ACCEPT', reasoning: 'fixed' }]),
            effect: writesFile('src/app.ts', 'export const value = 32;\n'),
          },
        ],
      }),
    };

    const { context } = buildContext(harnesses);
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'COMPLETE');
    assert.equal(final.rounds.codeReview, 2);
    // Whatever ran during the first review tested code that no longer exists;
    // what is recorded is a run against the diff the run actually produced.
    assert.equal(final.tests?.passed, true);
    assert.equal(final.diff?.additions !== undefined, true);
  });

  it('runs the suite in the test phase when concurrency is off', async () => {
    const harnesses = happyPathHarnesses();
    const { context, observer } = buildContext(harnesses, { config: { concurrentTests: false } });
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.tests?.passed, true);
    assert.match(observer.notes.join('\n'), /Ran tests:/);
    assert.ok(!observer.notes.join('\n').includes('alongside the code review'));

    // And the implementer is told to verify itself, since nothing else will.
    const implement = workTurns(harnesses.codex, 'implementer')[0];
    assert.match(implement?.prompt ?? '', /Verify your work by running/);
  });

  it('tells the implementer to skip the full suite Relay is about to run', async () => {
    const harnesses = happyPathHarnesses();
    const { context } = buildContext(harnesses);
    await new WorkflowEngine(context).run();

    const implement = workTurns(harnesses.codex, 'implementer')[0];
    assert.match(implement?.prompt ?? '', /you do not need to run the full suite yourself/);
    assert.match(implement?.prompt ?? '', /narrow checks only you can run/);
  });

  it('still records a missing suite rather than claiming one ran', async () => {
    await writeFile(join(repo.root, 'package.json'), JSON.stringify({ name: 'temp' }), 'utf8');
    await repo.commit('no test script');

    const { context } = buildContext(happyPathHarnesses());
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'COMPLETE');
    assert.equal(final.tests?.discovered, false);
  });
});

describe('inline planning', () => {
  function inlineHarnesses(): Harness {
    return {
      claude: new FakeAgentHarness('claude', {
        codeReviewer: [{ text: approveReview('Matches the issue.') }],
      }),
      codex: new FakeAgentHarness('codex', {
        implementer: [
          {
            text: [
              section('PLAN', '## Summary\nAdd the rate limiter to src/app.ts'),
              section('NOTES', 'Edited src/app.ts'),
            ].join('\n\n'),
            effect: writesFile('src/app.ts', 'export const value = 42;\n'),
          },
        ],
      }),
    };
  }

  it('skips the planner and plan review entirely', async () => {
    const harnesses = inlineHarnesses();
    const { context, store } = buildContext(harnesses, { config: { plan: 'inline' } });
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'COMPLETE');
    assert.deepEqual(
      final.history.map((entry) => entry.phase),
      [
        'INITIALIZING',
        'FETCHING_ISSUE',
        'CREATING_WORKSPACE',
        'IMPLEMENTING',
        'REVIEWING_CODE',
        'TESTING',
        'DELIVERING',
        'COMPLETE',
      ],
    );
    assert.equal(final.rounds.planReview, 0);
    assert.equal(workTurns(harnesses.claude, 'planner').length, 0);
    assert.equal(harnesses.codex.calls.filter((call) => call.role === 'planReviewer').length, 0);

    // The plan the implementer followed is still an artifact on disk.
    assert.match((await store.readArtifact('plan.md')) ?? '', /Add the rate limiter to src\/app\.ts/);
  });

  it('still has the other model review the diff', async () => {
    const harnesses = inlineHarnesses();
    const { context } = buildContext(harnesses, { config: { plan: 'inline' } });
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.rounds.codeReview, 1);
    const review = workTurns(harnesses.claude, 'codeReviewer')[0];
    assert.match(review?.prompt ?? '', /\+export const value = 42;/);
    assert.match(review?.prompt ?? '', /Add the rate limiter/);
    // Nothing challenged this plan upstream, so the approach is in scope here.
    assert.match(review?.prompt ?? '', /No reviewer approved this plan/);
    assert.ok(!/## The approved plan/.test(review?.prompt ?? ''));
  });

  it('reviews against the issue when the implementer states no plan', async () => {
    const harnesses = inlineHarnesses();
    harnesses.codex = new FakeAgentHarness('codex', {
      implementer: [
        { text: section('NOTES', 'just did it'), effect: writesFile('src/app.ts', 'export const value = 9;\n') },
      ],
    });

    const { context, observer } = buildContext(harnesses, { config: { plan: 'inline' } });
    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'COMPLETE');
    assert.match(observer.warnings.join(' '), /did not state a plan/);
    assert.match(workTurns(harnesses.claude, 'codeReviewer')[0]?.prompt ?? '', /no written plan/);
  });

  it('leaves the two plan steps off the progress checklist', () => {
    assert.deepEqual(displayPhasesFor({ plan: 'inline' }), [
      'FETCHING_ISSUE',
      'CREATING_WORKSPACE',
      'IMPLEMENTING',
      'REVIEWING_CODE',
      'TESTING',
      'DELIVERING',
    ]);
    assert.ok(displayPhasesFor({ plan: 'review' }).includes('PLANNING'));
  });

  it('goes straight from the diff to the tests when both reviews are off', async () => {
    const harnesses = inlineHarnesses();
    const { context, observer, store } = buildContext(harnesses, {
      config: { plan: 'inline', reviewCode: false },
    });

    const final = await new WorkflowEngine(context).run();

    assert.equal(final.phase, 'COMPLETE');
    assert.deepEqual(
      final.history.map((entry) => entry.phase),
      [
        'INITIALIZING',
        'FETCHING_ISSUE',
        'CREATING_WORKSPACE',
        'IMPLEMENTING',
        'TESTING',
        'DELIVERING',
        'COMPLETE',
      ],
    );

    // No review turn, and no read-ahead for a review that never happens.
    assert.deepEqual(harnesses.claude.calls, []);
    assert.equal(final.rounds.codeReview, 0);
    assert.equal(final.reviews.length, 0);

    // The tests still ran, and the run says out loud what it skipped.
    assert.equal(final.tests?.passed, true);
    assert.match(observer.warnings.join(' '), /No code review on this run/);
    assert.match((await store.readArtifact('summary.md')) ?? '', /Code review: skipped/);
  });

  it('tells the implementer that nothing downstream will read its diff', async () => {
    const harnesses = inlineHarnesses();
    const { context } = buildContext(harnesses, { config: { plan: 'inline', reviewCode: false } });
    await new WorkflowEngine(context).run();

    const implement = workTurns(harnesses.codex, 'implementer')[0];
    assert.match(implement?.prompt ?? '', /no plan reviewer and no code reviewer on this run/);
  });

  it('asks the implementer for human-looking comments only under --tuff', async () => {
    const plain = inlineHarnesses();
    await new WorkflowEngine(buildContext(plain, { config: { plan: 'inline' } }).context).run();
    assert.ok(!/Writing style for this run/.test(workTurns(plain.codex, 'implementer')[0]?.prompt ?? ''));

    const tuff = inlineHarnesses();
    await new WorkflowEngine(buildContext(tuff, { config: { plan: 'inline', typos: true } }).context).run();
    const prompt = workTurns(tuff.codex, 'implementer')[0]?.prompt ?? '';

    assert.match(prompt, /Writing style for this run/);
    assert.match(prompt, /occasional typo left in rather than corrected/);
    // The boundary matters more than the instruction: a typo in an identifier
    // is a bug, and the prompt has to say so.
    assert.match(prompt, /Identifiers, string literals, API names, file paths/);
  });

  it('treats a run recorded before the flag existed as reviewed', async () => {
    const harnesses = inlineHarnesses();
    const { context, state } = buildContext(harnesses, { config: { plan: 'inline' } });
    // What `state.json` looks like for a run that predates `workflow.reviewCode`.
    delete (state.config.workflow as { reviewCode?: boolean }).reviewCode;

    const final = await new WorkflowEngine(context).run();

    assert.equal(final.rounds.codeReview, 1);
    assert.equal(workTurns(harnesses.claude, 'codeReviewer').length, 1);
  });

  it('leaves the code review off the checklist when it is skipped too', () => {
    assert.deepEqual(displayPhasesFor({ plan: 'inline', reviewCode: false }), [
      'FETCHING_ISSUE',
      'CREATING_WORKSPACE',
      'IMPLEMENTING',
      'TESTING',
      'DELIVERING',
    ]);
    assert.ok(displayPhasesFor({ plan: 'review', reviewCode: false }).includes('PLANNING'));
    assert.ok(!displayPhasesFor({ plan: 'review', reviewCode: false }).includes('REVIEWING_CODE'));
  });
});

describe('speed configuration', () => {
  it('defaults to priming, concurrent tests and the full plan review', () => {
    assert.equal(DEFAULT_CONFIG.workflow.plan, 'review');
    assert.equal(DEFAULT_CONFIG.workflow.primeReviewers, true);
    assert.equal(DEFAULT_CONFIG.workflow.concurrentTests, true);
    assert.equal(DEFAULT_CONFIG.workflow.maxPlanReviewRounds, 2);
  });

  it('accepts the new workflow keys and rejects nonsense', () => {
    const config = mergeConfig(DEFAULT_CONFIG, {
      workflow: { plan: 'inline', primeReviewers: false, concurrentTests: false },
      timeouts: { primingMs: 120_000 },
    });

    assert.equal(config.workflow.plan, 'inline');
    assert.equal(config.workflow.primeReviewers, false);
    assert.equal(config.workflow.concurrentTests, false);
    assert.equal(config.timeouts.primingMs, 120_000);

    assert.throws(() => mergeConfig(DEFAULT_CONFIG, { workflow: { plan: 'sometimes' } }), RelayError);
    assert.throws(() => mergeConfig(DEFAULT_CONFIG, { workflow: { primeReviewers: 'yes' } }), RelayError);
  });

  it('takes a model per role as well as per provider', () => {
    const config = mergeConfig(DEFAULT_CONFIG, { models: { claude: 'opus', codeReviewer: 'haiku' } });

    assert.equal(config.models['claude'], 'opus');
    assert.equal(config.models['codeReviewer'], 'haiku');
    assert.throws(() => mergeConfig(DEFAULT_CONFIG, { models: { reviewer: 'haiku' } }), RelayError);
  });

  it('puts a reviewer on its own model without moving the other seats', async () => {
    const harnesses = happyPathHarnesses();
    const { context, state } = buildContext(harnesses);
    state.config.models = { claude: 'opus', codeReviewer: 'haiku' };

    const models: Array<string | undefined> = [];
    const original = harnesses.claude.start.bind(harnesses.claude);
    harnesses.claude.start = async (options) => {
      models.push(options.model);
      return original(options);
    };

    await new WorkflowEngine(context).run();

    // planner on the provider's model, code reviewer on its own.
    assert.deepEqual(models, ['opus', 'haiku']);
  });
});
