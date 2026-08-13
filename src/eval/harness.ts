/**
 * Running the fixture set across configurations.
 *
 * Every run here is a real `WorkflowEngine` run against a real git repository
 * with the real CLIs — the same engine `relay run` drives, reached through the
 * same seams. Nothing about the pipeline is stubbed for measurement, because a
 * harness that measured a simplified pipeline would be measuring the wrong
 * thing precisely where it matters.
 */
import { mkdir, rm } from 'node:fs/promises';

import type { AgentHarness } from '../agents/types.ts';
import { assertRemovableWorktreePath, removeWorktree } from '../git/worktree.ts';
import { RunStore } from '../storage/runs.ts';
import type { RelayConfig } from '../storage/config.ts';
import { createRunId, shortId } from '../util/ids.ts';
import { errorMessage } from '../util/errors.ts';
import type { EngineContext } from '../workflow/context.ts';
import { WorkflowEngine } from '../workflow/engine.ts';
import type { RunObserver } from '../workflow/observer.ts';
import { createRunState, type RunState } from '../workflow/state.ts';
import { isBlocking } from '../reviews/types.ts';
import type { ResolvedEvalConfig } from './configs.ts';
import { gradeCommit, gradePatch } from './grade.ts';
import { FixtureIssueProvider } from './issueProvider.ts';
import { findHiddenPaths, materializeFixture, type FixtureWorkspace } from './workspace.ts';
import type { EvalRunOutcome, Fixture, Grade, ReviewYield } from './types.ts';

/** One unit of work: a fixture, an arm, and which repetition this is. */
export interface EvalTask {
  fixture: Fixture;
  resolved: ResolvedEvalConfig;
  repeat: number;
}

export interface EvalProgressObserver {
  taskStarted(task: EvalTask, index: number, total: number): void;
  taskFinished(outcome: EvalRunOutcome, index: number, total: number): void;
  note(text: string): void;
  warn(text: string): void;
}

export const silentEvalObserver: EvalProgressObserver = {
  taskStarted() {},
  taskFinished() {},
  note() {},
  warn() {},
};

export interface EvalRunnerDeps {
  harnesses: Readonly<Record<string, AgentHarness>>;
  observer: EvalProgressObserver;
  signal: AbortSignal;
  /** Directory scratch repositories are created under. */
  workRoot: string;
  /** Leave scratch repositories and worktrees behind for inspection. */
  keep?: boolean;
  /** Forward the engine's own notes, prefixed with the run label. */
  verbose?: boolean;
}

/** Adapts the engine's observer onto the eval's, which reports per run, not per phase. */
function runObserver(label: string, deps: EvalRunnerDeps): RunObserver {
  return {
    phaseChanged() {},
    roleStatus() {},
    agentEvent() {},
    note: (text) => {
      if (deps.verbose === true) deps.observer.note(`${label}  ${text}`);
    },
    warn: (text) => {
      if (deps.verbose === true) deps.observer.warn(`${label}  ${text}`);
    },
  };
}

function buildRunState(fixture: Fixture, config: RelayConfig, repoRoot: string): RunState {
  return createRunState({
    runId: createRunId(new Date()),
    shortId: shortId(),
    issueRef: fixture.id,
    // No owner and no name: the scratch repository has no remote, and delivery
    // stops at a local commit. Nothing in this run can reach a forge.
    repository: { root: repoRoot, owner: null, name: null, defaultBranch: 'main' },
    config: structuredClone(config),
  });
}

function emptyReviewYield(rounds: number): ReviewYield {
  return {
    rounds,
    findings: 0,
    blocking: 0,
    upheld: 0,
    rejected: 0,
    preReview: 'unknown',
    postReview: 'unknown',
    rescued: false,
    broke: false,
  };
}

/**
 * What the code review was worth on this run.
 *
 * The finding counts describe the debate. The `pre`/`post` verdicts describe
 * the outcome, and they are what the claim actually rests on: if reviews raise
 * plenty of findings and never move a run from fail to pass, the findings were
 * not worth their turns however serious they sounded.
 */
async function measureReviewYield(
  state: RunState,
  workspace: FixtureWorkspace,
  finalGrade: Grade,
  deps: EvalRunnerDeps,
): Promise<ReviewYield> {
  const rounds = state.rounds.codeReview;
  const yielded = emptyReviewYield(rounds);

  const codeReviews = state.reviews.filter((review) => review.kind === 'code');
  for (const review of codeReviews) {
    yielded.findings += review.findings.length;
    yielded.blocking += review.findings.filter(isBlocking).length;
    for (const response of review.responses ?? []) {
      if (response.response === 'ACCEPT') yielded.upheld += 1;
      if (response.response === 'REJECT') yielded.rejected += 1;
    }
  }

  const postReview = finalGrade.ungraded === undefined ? (finalGrade.solved ? 'pass' : 'fail') : 'unknown';
  yielded.postReview = postReview;

  // Nothing was revised, so the diff review saw is the diff that was graded.
  const revised = codeReviews.some((review) => (review.responses?.length ?? 0) > 0);
  if (!revised) {
    yielded.preReview = postReview;
    return yielded;
  }

  const patch = await new RunStore(state.repository.root, state.runId).readArtifact('patches/implementation.patch');
  if (patch === undefined || patch.trim().length === 0) return yielded;

  const before = await gradePatch(workspace, patch, {
    label: `pre-review-${state.shortId}`,
    skipRegression: true,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });

  yielded.preReview = before.ungraded === undefined ? (before.solved ? 'pass' : 'fail') : 'unknown';
  yielded.rescued = yielded.preReview === 'fail' && postReview === 'pass';
  yielded.broke = yielded.preReview === 'pass' && postReview === 'fail';
  return yielded;
}

/**
 * Runs one fixture under one configuration, once, and grades it.
 *
 * Never throws for a failed run: a configuration that cannot finish a task is a
 * result, and a harness that aborted the sweep on the first crash would only
 * ever measure the easy fixtures.
 */
export async function runEvalTask(task: EvalTask, deps: EvalRunnerDeps): Promise<EvalRunOutcome> {
  const { fixture, resolved, repeat } = task;
  const label = `${fixture.id}/${resolved.spec.name}#${repeat}`;
  const startedAt = new Date();

  const workspace = await materializeFixture(fixture, {
    parent: deps.workRoot,
    label: `${resolved.spec.name}-${repeat}-${shortId(4)}`,
  });

  const state = buildRunState(fixture, resolved.config, workspace.root);
  const store = new RunStore(workspace.root, state.runId);

  const context: EngineContext = {
    state,
    store,
    harnesses: deps.harnesses,
    issueProvider: new FixtureIssueProvider(fixture),
    observer: runObserver(label, deps),
    signal: deps.signal,
  };

  let error: string | undefined;
  const began = Date.now();
  try {
    await new WorkflowEngine(context).run();
  } catch (caught) {
    // The engine records failures in state itself; this only catches the
    // exceptional case where it could not even do that.
    error = errorMessage(caught);
  }
  const wallClockMs = Date.now() - began;

  let grade: Grade = { solved: false, regressed: false, acceptance: null, regression: null, ungraded: 'not graded' };
  let hiddenTouched = false;

  try {
    if (state.workspace !== undefined) {
      hiddenTouched = (await findHiddenPaths(state.workspace.path, fixture)).length > 0;
    }

    // A run stopped from outside — Ctrl-C, `relay stop`, a cost ceiling — says
    // nothing about the configuration it was running. It is excluded rather
    // than scored, even when it committed partial work on the way out, because
    // counting it would drag an arm's rate down for a reason the arm did not
    // cause.
    const stopped = state.stopped;
    const sha = state.commit?.sha;

    grade =
      stopped !== undefined
        ? {
            solved: false,
            regressed: false,
            acceptance: null,
            regression: null,
            ungraded: `the run was stopped rather than finishing: ${stopped.detail}`,
          }
        : sha === undefined
          ? {
              solved: false,
              regressed: false,
              acceptance: null,
              regression: null,
              ungraded: `the run ended in ${state.phase} with no commit on its branch`,
            }
          : await gradeCommit(workspace, sha, {
              label: `final-${state.shortId}`,
              ...(deps.signal ? { signal: deps.signal } : {}),
            });
  } catch (caught) {
    grade = {
      solved: false,
      regressed: false,
      acceptance: null,
      regression: null,
      ungraded: `grading failed: ${errorMessage(caught)}`,
    };
  }

  let review = emptyReviewYield(state.rounds.codeReview);
  try {
    review = await measureReviewYield(state, workspace, grade, deps);
  } catch (caught) {
    deps.observer.warn(`${label}: could not measure review yield: ${errorMessage(caught)}`);
  }

  // The run's worktree lives under the Relay workspaces root, not inside the
  // scratch directory, so removing the scratch directory would orphan it. Over
  // a few hundred runs that is a lot of disk nobody asked for.
  if (deps.keep !== true) {
    if (state.workspace !== undefined) {
      try {
        await removeWorktree(workspace.root, state.workspace.path, { force: true });
      } catch {
        try {
          // Same guard `removeWorktree` uses: inside the workspaces root, at
          // least three levels deep, or nothing is removed at all.
          await rm(assertRemovableWorktreePath(state.workspace.path), { recursive: true, force: true });
        } catch {
          deps.observer.warn(`${label}: could not remove the worktree at ${state.workspace.path}.`);
        }
      }
    }
    await workspace.cleanup();
  }

  const reported = error ?? state.error?.message;

  return {
    fixtureId: fixture.id,
    fixtureKind: fixture.kind,
    configName: resolved.spec.name,
    repeat,
    runId: state.runId,
    phase: state.phase,
    startedAt: startedAt.toISOString(),
    wallClockMs,
    solved: grade.solved,
    regressed: grade.regressed,
    changedFiles: state.diff?.fileCount ?? 0,
    planRounds: state.rounds.planReview,
    codeRounds: state.rounds.codeReview,
    turns: state.usage?.total.turns ?? 0,
    usage: state.usage?.total ?? null,
    review,
    grade,
    ...(hiddenTouched ? { hiddenPathTouched: true } : {}),
    // The engine records its own failures in state; `error` is only set when it
    // could not even do that.
    ...(reported === undefined ? {} : { error: reported }),
  };
}

/**
 * Every task in the sweep, ordered so a partial result is still a comparison.
 *
 * Repetitions are the outermost loop: an eval stopped halfway through has one
 * complete pass over every fixture and every arm rather than three passes over
 * the first third of the fixtures, which would compare nothing.
 */
export function planTasks(
  fixtures: readonly Fixture[],
  configs: readonly ResolvedEvalConfig[],
  repeats: number,
): EvalTask[] {
  const tasks: EvalTask[] = [];
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const fixture of fixtures) {
      for (const resolved of configs) tasks.push({ fixture, resolved, repeat });
    }
  }
  return tasks;
}

/** Runs the sweep, at most `concurrency` runs at a time. */
export async function runEvalTasks(
  tasks: readonly EvalTask[],
  deps: EvalRunnerDeps,
  options: { concurrency?: number } = {},
): Promise<EvalRunOutcome[]> {
  await mkdir(deps.workRoot, { recursive: true });

  const outcomes: EvalRunOutcome[] = new Array<EvalRunOutcome>(tasks.length);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 1, tasks.length));
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (deps.signal.aborted) return;
      const index = next;
      next += 1;
      const task = tasks[index];
      if (task === undefined) return;

      deps.observer.taskStarted(task, index + 1, tasks.length);
      try {
        const outcome = await runEvalTask(task, deps);
        outcomes[index] = outcome;
        deps.observer.taskFinished(outcome, index + 1, tasks.length);
      } catch (error) {
        // Materializing or cleaning up threw. Recorded as an ungraded run so
        // the sweep's denominators stay honest.
        const outcome: EvalRunOutcome = {
          fixtureId: task.fixture.id,
          fixtureKind: task.fixture.kind,
          configName: task.resolved.spec.name,
          repeat: task.repeat,
          runId: 'none',
          phase: 'FAILED',
          startedAt: new Date().toISOString(),
          wallClockMs: 0,
          solved: false,
          regressed: false,
          changedFiles: 0,
          planRounds: 0,
          codeRounds: 0,
          turns: 0,
          usage: null,
          review: emptyReviewYield(0),
          grade: {
            solved: false,
            regressed: false,
            acceptance: null,
            regression: null,
            ungraded: `the harness could not run this task: ${errorMessage(error)}`,
          },
          error: errorMessage(error),
        };
        outcomes[index] = outcome;
        deps.observer.warn(`${task.fixture.id}/${task.resolved.spec.name}: ${errorMessage(error)}`);
        deps.observer.taskFinished(outcome, index + 1, tasks.length);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return outcomes.filter((outcome): outcome is EvalRunOutcome => outcome !== undefined);
}
