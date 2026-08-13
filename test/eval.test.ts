import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_AGENT_PAIR,
  EVAL_COMPARISONS,
  EVAL_CONFIGS,
  EVAL_CONFIG_NAMES,
  evalComparison,
  evalConfigSpec,
  providersUsed,
  resolveEvalConfigs,
} from '../src/eval/configs.ts';
import {
  calibrationFrom,
  estimateEval,
  estimateTurns,
  samplesFromResults,
  samplesFromRuns,
} from '../src/eval/estimate.ts';
import { defaultFixturesDir, loadFixtures, readFixture } from '../src/eval/fixtures.ts';
import { gradeCommit, runSuite, verifyFixture } from '../src/eval/grade.ts';
import { planTasks } from '../src/eval/harness.ts';
import { FixtureIssueProvider } from '../src/eval/issueProvider.ts';
import {
  aggregate,
  comparisonVerdicts,
  loadResults,
  renderResultsMarkdown,
  resultRows,
  writeResults,
  writeResultsIndex,
} from '../src/eval/report.ts';
import { compareProportions, proportion, summarize } from '../src/eval/stats.ts';
import {
  assertHiddenSuiteAbsent,
  createGradingCheckout,
  findHiddenPaths,
  materializeFixture,
  restoreProtectedPaths,
} from '../src/eval/workspace.ts';
import type { EvalResults, EvalRunOutcome, Fixture } from '../src/eval/types.ts';
import { collect, parseAgentPair, resolveArms } from '../src/cli/commands/eval.ts';
import { DEFAULT_CONFIG } from '../src/storage/config.ts';
import { isRelayError } from '../src/util/errors.ts';
import { createRunState } from '../src/workflow/state.ts';
import { git } from '../src/git/repository.ts';
import { branchNameFor, worktreePathFor } from '../src/git/worktree.ts';
import { issueIdentity } from '../src/issues/identity.ts';
import { renderIssueMarkdown } from '../src/github/types.ts';

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

test('summarize reports spread, and no spread for a single sample', () => {
  const many = summarize([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(many.n, 8);
  assert.equal(many.mean, 5);
  assert.ok(Math.abs(many.stdDev - 2.13809) < 0.001);
  assert.equal(many.min, 2);
  assert.equal(many.max, 9);

  assert.equal(summarize([3]).stdDev, 0);
  assert.equal(summarize([]).n, 0);
});

test('a proportion at the extremes still has an interval', () => {
  const perfect = proportion(5, 5);
  assert.equal(perfect.rate, 1);
  assert.equal(perfect.high, 1);
  // The whole point of Wilson over the normal approximation: 5/5 is not "100%".
  assert.ok(perfect.low < 1 && perfect.low > 0.5, `low was ${perfect.low}`);

  const none = proportion(0, 5);
  assert.equal(none.low, 0);
  assert.ok(none.high > 0 && none.high < 1);

  assert.equal(proportion(0, 0).n, 0);
});

test('comparing proportions is inconclusive unless the intervals separate', () => {
  assert.equal(compareProportions(proportion(2, 3), proportion(1, 3)), 'inconclusive');
  assert.equal(compareProportions(proportion(60, 60), proportion(0, 60)), 'a');
  assert.equal(compareProportions(proportion(0, 60), proportion(60, 60)), 'b');
  assert.equal(compareProportions(proportion(0, 0), proportion(1, 1)), 'inconclusive');
});

// ---------------------------------------------------------------------------
// Configurations
// ---------------------------------------------------------------------------

test('every comparison names configurations that exist', () => {
  for (const comparison of EVAL_COMPARISONS) {
    assert.ok(comparison.configs.length >= 2, `${comparison.name} needs at least two arms`);
    for (const name of comparison.configs) {
      assert.ok(EVAL_CONFIG_NAMES.includes(name), `${comparison.name} names unknown arm ${name}`);
    }
  }
});

test('the arms differ in exactly the way they claim to', () => {
  const [pair] = [DEFAULT_AGENT_PAIR];
  const byName = new Map(EVAL_CONFIGS.map((spec) => [spec.name, spec.build(pair!)]));

  const solo = byName.get('solo')!;
  assert.equal(solo.workflow.plan, 'inline');
  assert.equal(solo.workflow.reviewCode, false);
  assert.equal(new Set(Object.values(solo.agents)).size, 1);

  const same = byName.get('same-model')!;
  assert.equal(same.workflow.plan, 'review');
  assert.equal(same.workflow.reviewCode, true);
  assert.equal(new Set(Object.values(same.agents)).size, 1);

  const cross = byName.get('cross-model')!;
  assert.equal(new Set(Object.values(cross.agents)).size, 2);
  assert.equal(cross.agents.planner, cross.agents.codeReviewer);
  assert.equal(cross.agents.implementer, cross.agents.planReviewer);

  // Every arm publishes nothing: an eval must not be able to reach a forge.
  for (const config of byName.values()) {
    assert.equal(config.workflow.deliver, 'branch');
    assert.equal(config.github.autoPush, false);
    assert.equal(config.github.autoPr, false);
    assert.equal(config.github.autoMerge, false);
    assert.equal(config.workflow.offerMerge, false);
  }

  assert.equal(byName.get('code-rounds-1')!.workflow.maxCodeReviewRounds, 1);
  assert.equal(byName.get('code-rounds-3')!.workflow.maxCodeReviewRounds, 3);
  assert.equal(byName.get('no-plan-review')!.workflow.plan, 'inline');
  assert.equal(byName.get('no-plan-review')!.workflow.reviewCode, true);
});

test('resolved arms carry the repository model pins', () => {
  const resolved = resolveEvalConfigs(['cross-model'], DEFAULT_AGENT_PAIR, { claude: 'haiku' });
  assert.equal(resolved[0]!.config.models['claude'], 'haiku');
  assert.deepEqual(providersUsed(resolved).sort(), ['claude', 'codex']);
});

test('unknown arms and comparisons are refused with the list of known ones', () => {
  assert.throws(
    () => evalConfigSpec('nope'),
    (error: unknown) => isRelayError(error) && error.code === 'UNKNOWN_EVAL_CONFIG',
  );
  assert.throws(
    () => evalComparison('nope'),
    (error: unknown) => isRelayError(error) && error.code === 'UNKNOWN_EVAL_COMPARISON',
  );
});

// ---------------------------------------------------------------------------
// Estimating before spending
// ---------------------------------------------------------------------------

test('turn counts follow the state machine, not a guess', () => {
  const solo = structuredClone(DEFAULT_CONFIG);
  solo.workflow.plan = 'inline';
  solo.workflow.reviewCode = false;
  // One implementation turn, and nothing else can happen.
  assert.deepEqual(estimateTurns(solo), { min: 1, max: 1 });

  const noPriming = structuredClone(DEFAULT_CONFIG);
  noPriming.workflow.primeReviewers = false;
  // Best case: planner, plan review, implement, code review. Worst: a review
  // and a revision for each of the two rounds on each side, minus the revision
  // that never follows the last round.
  assert.deepEqual(estimateTurns(noPriming), { min: 4, max: 8 });

  // Two reviewers reading ahead, one turn each, in every case.
  const primed = structuredClone(DEFAULT_CONFIG);
  assert.deepEqual(estimateTurns(primed), { min: 6, max: 10 });

  const threeRounds = structuredClone(DEFAULT_CONFIG);
  threeRounds.workflow.maxCodeReviewRounds = 3;
  assert.ok(estimateTurns(threeRounds).max > estimateTurns(primed).max);
});

test('cost is unknown until something has been measured', () => {
  const configs = resolveEvalConfigs(['cross-model'], DEFAULT_AGENT_PAIR);
  const blind = estimateEval(configs, { fixtures: 10, repeats: 3 });

  assert.equal(blind.runs, 30);
  assert.equal(blind.costUsd, undefined);
  assert.equal(blind.wallClockMs, undefined);
  assert.match(blind.basis, /no measured runs/);

  const calibration = calibrationFrom(
    [
      { turns: 6, costUsd: 0.6, wallClockMs: 60_000 },
      { turns: 4, wallClockMs: 40_000 },
    ],
    'a test',
  );
  assert.ok(calibration !== undefined);
  assert.equal(calibration.msPerTurn, 10_000);
  assert.ok(Math.abs(calibration.usdPerTurn! - 0.1) < 1e-9);
  assert.equal(calibration.unpricedSamples, 1);

  const priced = estimateEval(configs, { fixtures: 10, repeats: 3, calibration });
  assert.ok(priced.costUsd !== undefined && priced.costUsd.min > 0);
  assert.ok(priced.wallClockMs !== undefined && priced.wallClockMs.max > priced.wallClockMs.min);
  assert.match(priced.basis, /reported no price, so the cost shown is a floor/);
});

test('concurrency divides the estimated wall-clock and nothing else', () => {
  const configs = resolveEvalConfigs(['cross-model'], DEFAULT_AGENT_PAIR);
  const calibration = calibrationFrom([{ turns: 10, costUsd: 1, wallClockMs: 100_000 }], 'a test')!;

  const serial = estimateEval(configs, { fixtures: 4, repeats: 1, calibration });
  const parallel = estimateEval(configs, { fixtures: 4, repeats: 1, concurrency: 4, calibration });

  assert.equal(parallel.wallClockMs!.max, serial.wallClockMs!.max / 4);
  assert.deepEqual(parallel.costUsd, serial.costUsd);
});

test('calibration samples come from recorded runs of either kind', () => {
  const state = createRunState({
    runId: '20260101T000000-abcdef',
    shortId: 'abcdef',
    issueRef: '1',
    repository: { root: '/tmp', owner: null, name: null, defaultBranch: 'main' },
    config: structuredClone(DEFAULT_CONFIG),
    now: new Date('2026-01-01T00:00:00Z'),
  });
  state.finishedAt = '2026-01-01T00:05:00Z';
  state.usage = { total: { inputTokens: 1, outputTokens: 1, turns: 5, costUsd: 0.5 }, byPhase: {} };

  assert.deepEqual(samplesFromRuns([state]), [{ turns: 5, costUsd: 0.5, wallClockMs: 300_000 }]);

  // A run that reported no turns tells an estimate nothing.
  const unbilled = structuredClone(state);
  delete unbilled.usage;
  assert.deepEqual(samplesFromRuns([unbilled]), []);

  const results = { outcomes: [{ turns: 3, usage: { costUsd: 0.3 }, wallClockMs: 1000 }] } as unknown as EvalResults;
  assert.deepEqual(samplesFromResults([results]), [{ turns: 3, costUsd: 0.3, wallClockMs: 1000 }]);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

test('every shipped fixture loads and declares what it needs to', async () => {
  const fixtures = await loadFixtures(defaultFixturesDir());
  assert.ok(fixtures.length >= 20, `expected at least 20 fixtures, found ${fixtures.length}`);

  for (const fixture of fixtures) {
    assert.ok(fixture.task.trim().length > 0, `${fixture.id} has an empty task`);
    assert.ok(fixture.acceptance.command.length > 0);
    assert.ok(fixture.regression.command.length > 0);
    assert.ok(fixture.hiddenPaths.length > 0, `${fixture.id} has no hidden suite`);
    assert.ok(fixture.protectedPaths.length > 0, `${fixture.id} protects no visible tests`);
    assert.ok(fixture.solutionPaths.length > 0, `${fixture.id} has no reference solution`);

    for (const path of fixture.hiddenPaths) {
      assert.ok(!fixture.protectedPaths.includes(path), `${fixture.id}: ${path} is both hidden and visible`);
    }
  }

  const kinds = new Set(fixtures.map((fixture) => fixture.kind));
  assert.deepEqual([...kinds].sort(), ['bug', 'feature', 'refactor']);
});

test('a fixture can be selected by id, and a bad id is an error', async () => {
  const one = await loadFixtures(defaultFixturesDir(), { only: ['semver-compare'] });
  assert.deepEqual(one.map((fixture) => fixture.id), ['semver-compare']);

  await assert.rejects(
    loadFixtures(defaultFixturesDir(), { only: ['not-a-fixture'] }),
    (error: unknown) => isRelayError(error) && error.code === 'NO_FIXTURES',
  );
});

test('a malformed fixture is refused rather than half-loaded', async () => {
  const base = await mkdtemp(join(tmpdir(), 'relay-eval-fixture-'));
  const dir = join(base, 'broken');

  const write = async (manifest: Record<string, unknown>): Promise<void> => {
    await mkdir(join(dir, 'repo', 'test'), { recursive: true });
    await mkdir(join(dir, 'hidden'), { recursive: true });
    await writeFile(join(dir, 'task.md'), 'do a thing\n', 'utf8');
    await writeFile(join(dir, 'repo', 'test', 'a.test.js'), '', 'utf8');
    await writeFile(join(dir, 'hidden', 'b.test.js'), '', 'utf8');
    await writeFile(join(dir, 'fixture.json'), JSON.stringify(manifest), 'utf8');
  };

  const good = {
    title: 'A thing',
    kind: 'bug',
    source: { kind: 'authored' },
    acceptance: { command: ['node', '--test', 'b.test.js'] },
    regression: { command: ['node', '--test', 'test/a.test.js'] },
  };

  try {
    await write(good);
    const fixture = await readFixture(dir, 'broken');
    assert.equal(fixture.kind, 'bug');
    assert.deepEqual(fixture.protectedPaths, ['test/a.test.js']);
    assert.deepEqual(fixture.solutionPaths, []);

    await write({ ...good, kind: 'chore' });
    await assert.rejects(readFixture(dir, 'broken'), /kind must be one of/);

    // A pinned snapshot with no commit is not pinned.
    await write({ ...good, source: { kind: 'snapshot', repository: 'a/b' } });
    await assert.rejects(readFixture(dir, 'broken'), /requires both source.repository and source.commit/);

    // Commands are screened exactly as a project's own test script is.
    await write({ ...good, acceptance: { command: ['rm', '-rf', '/'] } });
    await assert.rejects(readFixture(dir, 'broken'), /recursive delete/);

    await write({ ...good, protected: ['test/nope.js'] });
    await assert.rejects(readFixture(dir, 'broken'), /not in repo\//);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a hidden path that also exists in repo/ is refused at load time', async () => {
  const base = await mkdtemp(join(tmpdir(), 'relay-eval-leak-'));
  const dir = join(base, 'leaky');
  try {
    await mkdir(join(dir, 'repo', 'tests-hidden'), { recursive: true });
    await mkdir(join(dir, 'hidden', 'tests-hidden'), { recursive: true });
    await writeFile(join(dir, 'task.md'), 'do a thing\n', 'utf8');
    await writeFile(join(dir, 'repo', 'tests-hidden', 'a.test.js'), '', 'utf8');
    await writeFile(join(dir, 'hidden', 'tests-hidden', 'a.test.js'), '', 'utf8');
    await writeFile(
      join(dir, 'fixture.json'),
      JSON.stringify({
        title: 'Leaky',
        kind: 'bug',
        source: { kind: 'authored' },
        acceptance: { command: ['node', '--test', 'tests-hidden/a.test.js'] },
        regression: { command: ['node', '--test', 'tests-hidden/a.test.js'] },
        protected: [],
      }),
      'utf8',
    );

    await assert.rejects(readFixture(dir, 'leaky'), /also exist under repo\//);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a fixture is presented to the engine as an ordinary issue', async () => {
  const [fixture] = await loadFixtures(defaultFixturesDir(), { only: ['semver-compare'] });
  const issue = await new FixtureIssueProvider(fixture!).getIssue();

  assert.equal(issue.id, 'fixture:semver-compare');
  assert.equal(issue.title, fixture!.title);
  assert.equal(issue.body, fixture!.task.trim());
  assert.equal(issue.state, 'open');
  assert.equal(issue.repository, null);
  assert.deepEqual(issue.labels, ['bug']);

  // No tracker behind it, so no number to invent and no URL to follow.
  assert.equal(issue.number, null);
  assert.equal(issue.url, '');
  assert.doesNotMatch(renderIssueMarkdown(issue), /URL:|#null/);
});

test('a numberless fixture still names a branch and a worktree', async () => {
  const [fixture] = await loadFixtures(defaultFixturesDir(), { only: ['semver-compare'] });
  const issue = await new FixtureIssueProvider(fixture!).getIssue();
  const identity = issueIdentity(issue);

  // Named after the title, exactly as a spec file or a `--prompt` is.
  assert.equal(typeof identity, 'string');
  const branch = branchNameFor(identity, 'x7f2q3');
  assert.match(branch, /^relay\/version-comparison-orders/);
  assert.doesNotMatch(branch, /null|undefined/);
  assert.match(
    worktreePathFor({ owner: null, name: null, root: '/tmp/semver-compare' }, identity, 'x7f2q3'),
    /issue-version-comparison-orders[a-z0-9-]*-x7f2q3$/,
  );
});

// ---------------------------------------------------------------------------
// The hidden-suite guarantee, and grading
// ---------------------------------------------------------------------------

async function withFixture(
  id: string,
  body: (fixture: Fixture, parent: string) => Promise<void>,
): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), 'relay-eval-work-'));
  try {
    const [fixture] = await loadFixtures(defaultFixturesDir(), { only: [id] });
    await body(fixture!, parent);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

test('a materialized fixture is a git repository with no hidden suite in it', async () => {
  await withFixture('semver-compare', async (fixture, parent) => {
    const workspace = await materializeFixture(fixture, { parent, label: 'test' });
    try {
      assert.deepEqual(await findHiddenPaths(workspace.root, fixture), []);
      assert.match(workspace.baseSha, /^[0-9a-f]{40}$/);

      // The visible tree is exactly what the agents get, and it is committed.
      const tracked = (await git(['ls-files'], { cwd: workspace.root })).split('\n');
      assert.ok(tracked.includes('src/semver.js'));
      assert.ok(tracked.includes('test/semver.test.js'));
      for (const path of fixture.hiddenPaths) assert.ok(!tracked.includes(path), `${path} is tracked`);
      // The reference solution replaces a source file, so its paths overlap
      // with repo/ by design; what matters is that its *contents* are not here.
      const source = await readFile(join(workspace.root, 'src', 'semver.js'), 'utf8');
      assert.ok(!source.includes('Reference solution'), 'the reference solution was materialized');
    } finally {
      await workspace.cleanup();
    }
  });
});

test('a leaked hidden suite stops the harness instead of being graded around', async () => {
  await withFixture('semver-compare', async (fixture, parent) => {
    const workspace = await materializeFixture(fixture, { parent, label: 'leak' });
    try {
      const leaked = join(workspace.root, fixture.hiddenPaths[0]!);
      await mkdir(join(leaked, '..'), { recursive: true });
      await writeFile(leaked, '// snuck in\n', 'utf8');

      await assert.rejects(
        assertHiddenSuiteAbsent(workspace.root, fixture),
        (error: unknown) => isRelayError(error) && error.code === 'HIDDEN_SUITE_LEAKED',
      );
    } finally {
      await workspace.cleanup();
    }
  });
});

test('a fixture holds its contract: hidden fails at base, visible passes, the reference solves it', async () => {
  await withFixture('semver-compare', async (fixture, parent) => {
    const workspace = await materializeFixture(fixture, { parent, label: 'verify' });
    try {
      const verdict = await verifyFixture(workspace);
      assert.deepEqual(verdict.problems, []);
      assert.equal(verdict.ok, true);
      assert.equal(verdict.referenceSolves, true);
      assert.equal(verdict.acceptance?.passed, false);
      assert.equal(verdict.regression?.passed, true);
    } finally {
      await workspace.cleanup();
    }
  });
});

test('grading restores the visible tests, so deleting them is not a way to pass', async () => {
  await withFixture('semver-compare', async (fixture, parent) => {
    const workspace = await materializeFixture(fixture, { parent, label: 'cheat' });
    try {
      // The cheapest way to a green regression suite: delete the assertions.
      await rm(join(workspace.root, 'test'), { recursive: true, force: true });
      await writeFile(join(workspace.root, 'src', 'semver.js'), 'export const broken = true;\n', 'utf8');
      await git(['add', '-A'], { cwd: workspace.root });
      await git(
        ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '--no-verify', '--message', 'delete the tests'],
        { cwd: workspace.root },
      );
      const sha = await git(['rev-parse', 'HEAD'], { cwd: workspace.root });

      const grade = await gradeCommit(workspace, sha, { label: 'cheat' });
      assert.equal(grade.solved, false);
      assert.equal(grade.regressed, true, 'the deleted suite was restored and still failed');
    } finally {
      await workspace.cleanup();
    }
  });
});

test('grading happens in a checkout of its own, never in the tree that was graded', async () => {
  await withFixture('semver-compare', async (fixture, parent) => {
    const workspace = await materializeFixture(fixture, { parent, label: 'isolation' });
    try {
      const checkout = await createGradingCheckout(workspace, workspace.baseSha, 'isolation');
      try {
        assert.notEqual(checkout.path, workspace.root);
        await restoreProtectedPaths(checkout.path, fixture);
        const restored = await readFile(join(checkout.path, 'test', 'semver.test.js'), 'utf8');
        assert.match(restored, /parse splits a plain version/);

        // Overlaying into the grading checkout leaves the graded tree untouched.
        assert.deepEqual(await findHiddenPaths(workspace.root, fixture), []);
      } finally {
        await checkout.dispose();
      }
    } finally {
      await workspace.cleanup();
    }
  });
});

test('a suite is judged by its exit code and keeps output only when it fails', async () => {
  const base = await mkdtemp(join(tmpdir(), 'relay-eval-suite-'));
  try {
    const passed = await runSuite({ command: ['node', '-e', 'console.log("fine")'], timeoutMs: 30_000 }, base);
    assert.equal(passed.passed, true);
    assert.equal(passed.exitCode, 0);
    assert.equal(passed.output, undefined);

    const failed = await runSuite(
      { command: ['node', '-e', 'console.error("nope"); process.exit(3)'], timeoutMs: 30_000 },
      base,
    );
    assert.equal(failed.passed, false);
    assert.equal(failed.exitCode, 3);
    assert.match(failed.output ?? '', /nope/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Sweep planning and reporting
// ---------------------------------------------------------------------------

test('repetitions are the outermost loop, so a half-finished sweep still compares', () => {
  const fixtures = [{ id: 'a' }, { id: 'b' }] as unknown as Fixture[];
  const configs = resolveEvalConfigs(['solo', 'cross-model'], DEFAULT_AGENT_PAIR);
  const tasks = planTasks(fixtures, configs, 2);

  assert.equal(tasks.length, 8);
  assert.deepEqual(
    tasks.slice(0, 4).map((task) => `${task.fixture.id}/${task.resolved.spec.name}#${task.repeat}`),
    ['a/solo#1', 'a/cross-model#1', 'b/solo#1', 'b/cross-model#1'],
  );
  // The first pass covers every fixture and arm before anything repeats.
  assert.equal(new Set(tasks.slice(0, 4).map((task) => task.repeat)).size, 1);
});

function outcome(overrides: Partial<EvalRunOutcome>): EvalRunOutcome {
  return {
    fixtureId: 'f',
    fixtureKind: 'bug',
    configName: 'cross-model',
    repeat: 1,
    runId: '20260101T000000-abcdef',
    phase: 'COMPLETE',
    startedAt: '2026-01-01T00:00:00.000Z',
    wallClockMs: 60_000,
    solved: true,
    regressed: false,
    changedFiles: 1,
    planRounds: 1,
    codeRounds: 1,
    turns: 6,
    usage: { inputTokens: 100, outputTokens: 50, turns: 6, costUsd: 0.5 },
    review: {
      rounds: 1,
      findings: 2,
      blocking: 1,
      upheld: 1,
      rejected: 0,
      preReview: 'fail',
      postReview: 'pass',
      rescued: true,
      broke: false,
    },
    grade: { solved: true, regressed: false, acceptance: null, regression: null },
    ...overrides,
  };
}

function results(outcomes: EvalRunOutcome[]): EvalResults {
  return {
    version: 1,
    evalId: '20260101T000000-abcdef',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T01:00:00.000Z',
    relayVersion: '0.1.0',
    host: { platform: 'darwin', nodeVersion: 'v22.6.0' },
    models: [
      { provider: 'claude', cli: '2.1.210', model: 'default' },
      { provider: 'codex', cli: '0.20.0', model: 'default' },
    ],
    repeats: 2,
    concurrency: 1,
    fixtures: [{ id: 'f', kind: 'bug', title: 'A thing', source: { kind: 'authored' } }],
    configs: [
      { name: 'solo', summary: 'one agent', question: 'does a second help?', config: structuredClone(DEFAULT_CONFIG) },
      { name: 'cross-model', summary: 'the default', question: 'baseline', config: structuredClone(DEFAULT_CONFIG) },
    ],
    outcomes,
  };
}

test('an ungraded run is excluded from the rate rather than counted as a loss', () => {
  const aggregates = aggregate(
    results([
      outcome({ configName: 'cross-model', solved: true }),
      outcome({ configName: 'cross-model', solved: false }),
      outcome({
        configName: 'cross-model',
        solved: false,
        grade: { solved: false, regressed: false, acceptance: null, regression: null, ungraded: 'no commit' },
      }),
    ]),
  );

  const cross = aggregates.find((entry) => entry.name === 'cross-model')!;
  assert.equal(cross.runs, 3);
  assert.equal(cross.ungraded, 1);
  assert.equal(cross.solveRate.n, 2);
  assert.equal(cross.solveRate.successes, 1);
  assert.equal(cross.rescued, 3);
});

test('unpriced runs are reported as unpriced, not as free', () => {
  const aggregates = aggregate(
    results([
      outcome({ usage: { inputTokens: 1, outputTokens: 1, turns: 6 } }),
      outcome({ usage: { inputTokens: 1, outputTokens: 1, turns: 6, costUsd: 1 } }),
    ]),
  );
  const cross = aggregates.find((entry) => entry.name === 'cross-model')!;
  assert.equal(cross.pricedRuns, 1);
  assert.equal(cross.costUsd?.mean, 1);

  const none = aggregate(results([outcome({ usage: null })])).find((entry) => entry.name === 'cross-model')!;
  assert.equal(none.costUsd, null);
  assert.match(resultRows([none])[0]![3]!, /not reported/);
});

test('a comparison that cannot separate the arms says so', () => {
  const aggregates = aggregate(
    results([
      ...Array.from({ length: 3 }, () => outcome({ configName: 'solo', solved: false })),
      ...Array.from({ length: 3 }, () => outcome({ configName: 'cross-model', solved: true })),
    ]),
  );

  const verdicts = comparisonVerdicts(aggregates);
  const secondAgent = verdicts.find((verdict) => verdict.name === 'second-agent');
  assert.ok(secondAgent !== undefined);
  assert.equal(secondAgent.baseline, 'cross-model');
  // 0/3 against 3/3 is suggestive and not significant, and the report says which.
  assert.ok(secondAgent.lines.some((line) => line.includes('inconclusive')), secondAgent.lines.join('\n'));
});

test('the published table names the models it was produced with', async () => {
  const markdown = renderResultsMarkdown([results([outcome({}), outcome({ configName: 'solo', solved: false })])]);
  assert.match(markdown, /claude 2\.1\.210/);
  assert.match(markdown, /codex 0\.20\.0/);
  assert.match(markdown, /95% CI/);
  assert.match(markdown, /## The comparisons/);
  assert.match(markdown, /cross-model/);

  // With nothing recorded the file must read as the absence of evidence rather
  // than as a table of zeroes.
  const empty = renderResultsMarkdown([]);
  assert.match(empty, /No session has been recorded yet/);
  assert.doesNotMatch(empty, /\| *0% *\|/);
  assert.doesNotMatch(empty, /95% CI/);
});

test('sessions accumulate in the results directory rather than replacing each other', async () => {
  const base = await mkdtemp(join(tmpdir(), 'relay-eval-results-'));
  try {
    const first = results([outcome({})]);
    const second = { ...results([outcome({ solved: false })]), evalId: '20260102T000000-bcdefg' };

    await writeResults(base, first);
    await writeResults(base, second);

    const loaded = await loadResults(base);
    assert.equal(loaded.length, 2);
    assert.deepEqual(loaded.map((entry) => entry.evalId), [first.evalId, second.evalId]);

    const path = await writeResultsIndex(base, loaded);
    const markdown = await readFile(path, 'utf8');
    assert.match(markdown, /2 across 2 eval session/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The command's own argument handling
// ---------------------------------------------------------------------------

test('arms come from --compare and --config, and default to the headline claim', () => {
  assert.deepEqual(resolveArms({}).sort(), ['cross-model', 'solo', 'solo-planner']);
  assert.deepEqual(resolveArms({ config: ['solo'] }), ['solo']);
  assert.deepEqual(resolveArms({ compare: ['code-rounds'] }), ['code-rounds-1', 'cross-model', 'code-rounds-3']);
  // A configuration named twice is still one arm.
  assert.deepEqual(resolveArms({ compare: ['second-model'], config: ['cross-model'] }), ['same-model', 'cross-model']);
});

test('repeatable options accept both repetition and commas', () => {
  assert.deepEqual(collect('a', collect('b')), ['b', 'a']);
  assert.deepEqual(collect('a, b ,,c'), ['a', 'b', 'c']);
});

test('the agent pair is validated against the registry', () => {
  assert.deepEqual(parseAgentPair('codex,claude', DEFAULT_AGENT_PAIR), { planner: 'codex', implementer: 'claude' });
  assert.deepEqual(parseAgentPair(undefined, DEFAULT_AGENT_PAIR), DEFAULT_AGENT_PAIR);
  assert.throws(() => parseAgentPair('claude', DEFAULT_AGENT_PAIR), /two agent names/);
  assert.throws(() => parseAgentPair('claude,nope', DEFAULT_AGENT_PAIR), /unknown agent/);
});
