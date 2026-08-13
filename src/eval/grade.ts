/**
 * Judging a finished run.
 *
 * Two suites, two questions. The hidden acceptance suite asks whether the task
 * was actually done; the fixture's own visible suite — which passed before the
 * change — asks whether something else broke on the way. Both answers come from
 * a process exit code in a directory no agent ever had access to.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { git } from '../git/repository.ts';
import { runProcess } from '../process/runner.ts';
import { clip } from '../util/text.ts';
import {
  applyReferenceSolution,
  createGradingCheckout,
  overlayHiddenSuite,
  restoreProtectedPaths,
  type FixtureWorkspace,
} from './workspace.ts';
import type { Fixture, FixtureSuite, Grade, SuiteOutcome } from './types.ts';

/** How much suite output is kept for a failure. Enough to see which case broke. */
const MAX_OUTPUT_CHARS = 20_000;

export async function runSuite(
  suite: FixtureSuite,
  cwd: string,
  options: { signal?: AbortSignal } = {},
): Promise<SuiteOutcome> {
  const [command, ...args] = suite.command;
  if (command === undefined) {
    return { command: suite.command, exitCode: null, passed: false, durationMs: 0, timedOut: false };
  }

  const result = await runProcess(command, args, {
    cwd,
    timeoutMs: suite.timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
    env: {
      CI: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      // A grading suite is very often `node --test`, and Node's test runner
      // changes both its reporting and its exit code when it believes it is a
      // subtest of another run. Inheriting that would grade every fixture as
      // solved whenever the harness itself is run from inside a test.
      NODE_TEST_CONTEXT: undefined,
    },
  });

  const passed = result.exitCode === 0 && !result.timedOut && !result.aborted;
  return {
    command: suite.command,
    exitCode: result.exitCode,
    passed,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    // A passing suite's output says nothing a reader needs; a failing one is
    // the only place the reason for a lost point is written down.
    ...(passed ? {} : { output: clip(`${result.stdout}\n${result.stderr}`, MAX_OUTPUT_CHARS) }),
  };
}

export interface GradeOptions {
  /** Distinguishes concurrent grading checkouts inside one workspace. */
  label: string;
  signal?: AbortSignal;
  /** Skip the visible suite when only the acceptance verdict is wanted. */
  skipRegression?: boolean;
  /** Overlay the reference solution first. Only `--check-fixtures` sets this. */
  withReferenceSolution?: boolean;
}

/**
 * Grades one commit.
 *
 * The regression suite runs before the overlay and the acceptance suite after,
 * so a fixture whose hidden files happen to sit beside its visible ones still
 * gets two independent answers rather than one contaminated pair.
 */
export async function gradeCommit(
  workspace: FixtureWorkspace,
  sha: string,
  options: GradeOptions,
): Promise<Grade> {
  const { fixture } = workspace;
  const checkout = await createGradingCheckout(workspace, sha, options.label);
  const signalOpt = options.signal ? { signal: options.signal } : {};

  try {
    if (options.withReferenceSolution === true) await applyReferenceSolution(checkout.path, fixture);
    await restoreProtectedPaths(checkout.path, fixture);
    const regression =
      options.skipRegression === true ? null : await runSuite(fixture.regression, checkout.path, signalOpt);

    await overlayHiddenSuite(checkout.path, fixture);
    const acceptance = await runSuite(fixture.acceptance, checkout.path, signalOpt);

    return {
      solved: acceptance.passed,
      regressed: regression !== null && !regression.passed,
      acceptance,
      regression,
    };
  } finally {
    await checkout.dispose();
  }
}

/**
 * Grades a diff that was never committed — the state of the tree when code
 * review began, reconstructed from the patch the run stored for that round.
 *
 * This is what makes review yield an objective number rather than a count of
 * findings somebody said were important: a review that turned a failing change
 * into a passing one is visible here as a fact.
 */
export async function gradePatch(
  workspace: FixtureWorkspace,
  patch: string,
  options: GradeOptions,
): Promise<Grade> {
  const { fixture } = workspace;
  const checkout = await createGradingCheckout(workspace, workspace.baseSha, options.label);
  const signalOpt = options.signal ? { signal: options.signal } : {};

  try {
    const patchFile = join(workspace.dir, `${options.label}.patch`);
    await writeFile(patchFile, patch.endsWith('\n') ? patch : `${patch}\n`, 'utf8');

    try {
      await git(['apply', '--whitespace=nowarn', patchFile], { cwd: checkout.path, ...signalOpt });
    } catch (error) {
      // A patch that will not apply is a fact about the run, not a failure of
      // the harness: it is graded `unknown` rather than counted as a loss.
      return {
        solved: false,
        regressed: false,
        acceptance: null,
        regression: null,
        ungraded: `the stored patch did not apply: ${(error as Error).message}`,
      };
    }

    await restoreProtectedPaths(checkout.path, fixture);
    const regression =
      options.skipRegression === true ? null : await runSuite(fixture.regression, checkout.path, signalOpt);

    await overlayHiddenSuite(checkout.path, fixture);
    const acceptance = await runSuite(fixture.acceptance, checkout.path, signalOpt);

    return {
      solved: acceptance.passed,
      regressed: regression !== null && !regression.passed,
      acceptance,
      regression,
    };
  } finally {
    await checkout.dispose();
  }
}

export interface FixtureVerdict {
  fixture: Fixture;
  ok: boolean;
  /** What the fixture promised and what the base commit actually did. */
  problems: string[];
  acceptance: SuiteOutcome | null;
  regression: SuiteOutcome | null;
  /** Whether the reference solution satisfies the hidden suite, if there is one. */
  referenceSolves: boolean | null;
}

/**
 * Checks a fixture's own contract against its base commit.
 *
 * A fixture is only worth running if, before anything is changed, the hidden
 * suite *fails* and the visible suite *passes*. A hidden suite that already
 * passes measures nothing; a visible suite that already fails makes every run
 * look like a regression. Both are silent failures, which is why this exists as
 * a command rather than as a comment in the README.
 */
export async function verifyFixture(
  workspace: FixtureWorkspace,
  options: { signal?: AbortSignal } = {},
): Promise<FixtureVerdict> {
  const grade = await gradeCommit(workspace, workspace.baseSha, {
    label: 'verify',
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const problems: string[] = [];
  if (grade.acceptance?.passed === true) {
    problems.push('the hidden acceptance suite already passes at the base commit — this task is already done');
  }
  if (grade.acceptance?.timedOut === true) {
    problems.push('the hidden acceptance suite timed out at the base commit');
  }
  if (grade.regression !== null && !grade.regression.passed) {
    problems.push('the visible regression suite does not pass at the base commit — every run would look like a regression');
  }

  // The other half of the contract: the task has to be doable. An unsolvable
  // fixture lowers every arm's rate by the same amount and reads as a finding.
  let referenceSolves: boolean | null = null;
  if (workspace.fixture.solutionPaths.length === 0) {
    problems.push('there is no reference solution, so nothing shows the hidden suite can be satisfied at all');
  } else {
    const reference = await gradeCommit(workspace, workspace.baseSha, {
      label: 'verify-solution',
      withReferenceSolution: true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    referenceSolves = reference.solved && !reference.regressed;
    if (!reference.solved) problems.push('the reference solution does not pass the hidden acceptance suite');
    if (reference.regressed) problems.push('the reference solution fails the visible regression suite');
  }

  return {
    fixture: workspace.fixture,
    ok: problems.length === 0,
    problems,
    acceptance: grade.acceptance,
    regression: grade.regression,
    referenceSolves,
  };
}
