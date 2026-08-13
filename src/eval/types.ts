/**
 * The vocabulary of `relay eval`.
 *
 * Relay exists because of one empirical claim — that specialized agents
 * reviewing each other's engineering work produce better changes than one agent
 * working alone. Everything in this directory exists to measure that claim
 * rather than assert it, so the types here are deliberately about *evidence*:
 * what a fixture promises, what a suite returned, what a configuration cost.
 */
import type { RelayConfig } from '../storage/config.ts';
import type { Phase } from '../workflow/phases.ts';
import type { UsageTotals } from '../workflow/usage.ts';

export const FIXTURE_KINDS = ['bug', 'feature', 'refactor'] as const;
export type FixtureKind = (typeof FIXTURE_KINDS)[number];

export function isFixtureKind(value: unknown): value is FixtureKind {
  return typeof value === 'string' && (FIXTURE_KINDS as readonly string[]).includes(value);
}

/** A command a fixture declares, run by the harness and judged by its exit code. */
export interface FixtureSuite {
  command: readonly string[];
  timeoutMs: number;
}

/**
 * Where the task came from.
 *
 * `snapshot` records the upstream repository and the commit it was pinned at,
 * because a fixture that says only "from a real project" is not reproducible.
 * `authored` says plainly that the task was written for this harness.
 */
export interface FixtureSource {
  kind: 'authored' | 'snapshot';
  repository?: string;
  commit?: string;
  license?: string;
  note?: string;
}

export interface Fixture {
  id: string;
  /** Absolute path of the fixture directory. */
  dir: string;
  title: string;
  kind: FixtureKind;
  /** The task text agents receive as the issue body, verbatim. */
  task: string;
  source: FixtureSource;
  /** The hidden suite. Passing it is what "solved" means. */
  acceptance: FixtureSuite;
  /**
   * The visible suite that already passed before the change. Failing it
   * afterwards is a regression: the change broke something it should not have.
   */
  regression: FixtureSuite;
  /** Paths the hidden overlay adds, relative to the repository root. */
  hiddenPaths: readonly string[];
  /**
   * Files restored from the fixture before grading — the visible tests.
   *
   * A change is judged against the behaviour contract that existed when it
   * started, not against the one it left behind. Without this, deleting the
   * assertion that catches your bug is a winning move.
   */
  protectedPaths: readonly string[];
  /**
   * A reference solution, used by `--check-fixtures` and by nothing else.
   *
   * It is how the fixture proves it is solvable at all: overlay it and the
   * hidden suite must pass. A fixture whose hidden suite nothing can satisfy
   * would quietly drag every arm's solve rate down by the same amount and look
   * like a finding.
   */
  solutionPaths: readonly string[];
}

export interface SuiteOutcome {
  command: readonly string[];
  exitCode: number | null;
  /** Exit code 0 and nothing else. An agent's claim is never evidence. */
  passed: boolean;
  durationMs: number;
  timedOut: boolean;
  /** Clipped output, kept only for failures — a passing suite says nothing. */
  output?: string;
}

export interface Grade {
  solved: boolean;
  regressed: boolean;
  acceptance: SuiteOutcome | null;
  regression: SuiteOutcome | null;
  /** Why the run could not be graded at all, when it could not. */
  ungraded?: string;
}

/**
 * What the review turns were worth, measured two ways.
 *
 * `upheld` / `rejected` are the implementer's own verdict on the reviewer's
 * findings, which is a judgement and not ground truth. `rescued` and `broke`
 * are objective: the hidden suite is run against the diff as it stood when
 * review began *and* against the delivered diff, so a review that turned a
 * failing change into a passing one is visible as a fact.
 */
export interface ReviewYield {
  rounds: number;
  findings: number;
  blocking: number;
  upheld: number;
  rejected: number;
  preReview: 'pass' | 'fail' | 'unknown';
  postReview: 'pass' | 'fail' | 'unknown';
  rescued: boolean;
  broke: boolean;
}

export interface EvalRunOutcome {
  fixtureId: string;
  fixtureKind: FixtureKind;
  configName: string;
  /** 1-based repetition index. Model calls are not deterministic; N is why. */
  repeat: number;
  runId: string;
  phase: Phase;
  startedAt: string;
  wallClockMs: number;
  solved: boolean;
  regressed: boolean;
  changedFiles: number;
  planRounds: number;
  codeRounds: number;
  /** Agent turns the run actually took, as counted by the usage ledger. */
  turns: number;
  usage: UsageTotals | null;
  review: ReviewYield;
  grade: Grade;
  /**
   * True when a hidden-suite path existed in the worktree after the run. The
   * overlay overwrites it before grading, so this cannot change a result — it
   * is recorded because an agent writing to that path at all is worth knowing.
   */
  hiddenPathTouched?: boolean;
  error?: string;
}

/** Which model actually produced a result. A number attached to none expires silently. */
export interface EvalModelRecord {
  provider: string;
  /** Version string the CLI reported for itself. */
  cli: string;
  /** Model pinned in config, or `default` when the CLI chose. */
  model: string;
}

export interface EvalConfigRecord {
  name: string;
  summary: string;
  question: string;
  config: RelayConfig;
}

export interface EvalFixtureRecord {
  id: string;
  kind: FixtureKind;
  title: string;
  source: FixtureSource;
}

export interface EvalResults {
  version: 1;
  evalId: string;
  startedAt: string;
  finishedAt: string;
  relayVersion: string;
  host: { platform: string; nodeVersion: string };
  models: EvalModelRecord[];
  repeats: number;
  /** Runs executed concurrently. Above 1, wall-clock numbers are contended. */
  concurrency: number;
  fixtures: EvalFixtureRecord[];
  configs: EvalConfigRecord[];
  outcomes: EvalRunOutcome[];
}
