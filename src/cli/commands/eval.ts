/**
 * `relay eval` — the harness that measures Relay's own central claim.
 *
 * The claim is that specialized agents reviewing and challenging each other's
 * engineering work produce better changes than one agent working alone. Every
 * design decision downstream of it — two review rounds and not three, the plan
 * reviewed by a different model, `--fast` dropping the plan stage — is a
 * hypothesis that has never been tested. This command tests them.
 *
 * It is expensive, and it says so before it starts.
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { platform } from 'node:os';

import {
  DEFAULT_AGENT_PAIR,
  evalComparison,
  evalConfigSpec,
  providersUsed,
  resolveEvalConfigs,
  type AgentPair,
  type ResolvedEvalConfig,
} from '../../eval/configs.ts';
import {
  calibrationFrom,
  estimateEval,
  formatCostRange,
  formatCount,
  formatRange,
  formatWallClockRange,
  samplesFromResults,
  samplesFromRuns,
  type Calibration,
  type EvalEstimate,
} from '../../eval/estimate.ts';
import { defaultFixturesDir, loadFixtures } from '../../eval/fixtures.ts';
import { verifyFixture } from '../../eval/grade.ts';
import { planTasks, runEvalTasks, type EvalProgressObserver, type EvalTask } from '../../eval/harness.ts';
import {
  aggregate,
  aggregateAll,
  comparisonVerdicts,
  loadResults,
  RESULT_COLUMNS,
  resultRows,
  writeResults,
  writeResultsIndex,
} from '../../eval/report.ts';
import { evalRoot, materializeFixture } from '../../eval/workspace.ts';
import type {
  EvalModelRecord,
  EvalResults,
  EvalRunOutcome,
  Fixture,
  FixtureKind,
} from '../../eval/types.ts';
import { listRuns } from '../../storage/runs.ts';
import { packageVersion } from '../../update/installation.ts';
import { isAgentProvider } from '../../agents/index.ts';
import { RelayError } from '../../util/errors.ts';
import { createRunId, shortId } from '../../util/ids.ts';
import { formatDuration, pluralize } from '../../util/text.ts';
import { formatCost } from '../../workflow/usage.ts';
import { Prompter } from '../../ui/prompt.ts';
import { glyphs } from '../../ui/theme.ts';
import { createCliContext } from '../context.ts';
import { EXIT } from '../exit.ts';
import { emitJson } from '../json.ts';
import {
  bold,
  command,
  dim,
  facts,
  failure,
  gridLines,
  heading,
  hint,
  out,
  rows,
  section,
  success,
  theme,
  warning,
} from '../output.ts';

export interface EvalOptions {
  config?: string[];
  compare?: string[];
  fixture?: string[];
  repeat?: string;
  concurrency?: string;
  fixtures?: string;
  out?: string;
  agents?: string;
  keep?: boolean;
  verbose?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  checkFixtures?: boolean;
  report?: boolean;
  json?: boolean;
}

/** Repeatable option collector for commander. */
export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, ...value.split(',').map((part) => part.trim()).filter((part) => part.length > 0)];
}

/**
 * Which arms to run.
 *
 * The default is the comparison the whole project rests on: one agent alone
 * against the shipped pair. Anything else is a refinement of a claim that has
 * to hold first.
 */
export function resolveArms(options: EvalOptions): string[] {
  const names = new Set<string>();
  for (const name of options.compare ?? []) {
    for (const config of evalComparison(name).configs) names.add(config);
  }
  for (const name of options.config ?? []) names.add(evalConfigSpec(name).name);
  if (names.size === 0) for (const config of evalComparison('second-agent').configs) names.add(config);
  return [...names];
}

export function parseAgentPair(value: string | undefined, fallback: AgentPair): AgentPair {
  if (value === undefined) return fallback;
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new RelayError('--agents takes two agent names, e.g. `--agents claude,codex`.', { code: 'BAD_FLAG' });
  }
  for (const part of parts) {
    if (!isAgentProvider(part)) {
      throw new RelayError(`--agents: unknown agent "${part}".`, { code: 'BAD_FLAG' });
    }
  }
  return { planner: parts[0]!, implementer: parts[1]! };
}

function parseCount(value: string | undefined, fallback: number, flag: string, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new RelayError(`${flag} must be an integer between 1 and ${max}.`, { code: 'BAD_FLAG' });
  }
  return parsed;
}

function countKinds(fixtures: readonly Fixture[]): string {
  const counts = new Map<FixtureKind, number>();
  for (const fixture of fixtures) counts.set(fixture.kind, (counts.get(fixture.kind) ?? 0) + 1);
  return [...counts.entries()].map(([kind, count]) => `${kind} ${count}`).join(', ');
}

export async function evalCommand(options: EvalOptions = {}): Promise<number> {
  const cli = await createCliContext();
  const outDir = options.out ?? join(cli.repo.root, '.relay', 'eval');

  if (options.report === true) {
    const sets = await loadResults(outDir);
    const path = await writeResultsIndex(outDir, sets);
    if (options.json === true) {
      emitJson('eval', { report: path, sessions: sets.length, aggregates: aggregateAll(sets) });
      return sets.length === 0 ? EXIT.error : EXIT.success;
    }
    out(`Wrote ${path} from ${pluralize(sets.length, 'recorded session')}.`);
    return sets.length === 0 ? EXIT.error : EXIT.success;
  }

  const fixturesDir = options.fixtures ?? defaultFixturesDir();
  const fixtures = await loadFixtures(fixturesDir, { only: options.fixture ?? [] });

  if (options.checkFixtures === true) return checkFixtures(fixtures);

  const pair = parseAgentPair(options.agents, DEFAULT_AGENT_PAIR);
  const configs = resolveEvalConfigs(resolveArms(options), pair, cli.config.models);
  const repeats = parseCount(options.repeat, 3, '--repeat', 25);
  const concurrency = parseCount(options.concurrency, 1, '--concurrency', 8);

  const models = await modelRecords(cli, configs);
  const missing = models.filter((model) => model.cli === 'unavailable');
  if (missing.length > 0) {
    throw new RelayError(`These agents are not available: ${missing.map((model) => model.provider).join(', ')}.`, {
      code: 'AGENT_UNAVAILABLE',
      hint: 'Run `relay doctor` to see what is missing, or `relay start` to fix it.',
    });
  }

  const calibration = await loadCalibration(cli.repo.root, outDir);
  const estimate = estimateEval(configs, {
    fixtures: fixtures.length,
    repeats,
    concurrency,
    calibration,
  });

  // The plan goes to stderr under `--json`, like every other command's chrome,
  // so a `--dry-run --json` estimate is a document a script can read.
  printPlan({ fixtures, configs, repeats, concurrency, estimate, models, outDir, fixturesDir });

  if (options.dryRun === true) {
    if (options.json === true) {
      emitJson('eval', { dryRun: true, estimate, models, fixtures: fixtures.length, repeats, concurrency });
      return EXIT.success;
    }
    out();
    hint('Dry run: nothing was executed. Drop --dry-run to run it.');
    out();
    return EXIT.success;
  }

  if (!(await confirm(estimate, options.yes === true))) {
    out();
    out(warning('Not run.'));
    hint('Pass --yes to run it without being asked, or --dry-run to see the estimate alone.');
    out();
    // Not a failure of the eval, but the command did not do what it was asked.
    return EXIT.error;
  }

  return execute({ cli, fixtures, configs, repeats, concurrency, models, outDir, options });
}

// ---------------------------------------------------------------------------
// Fixture checking — the one path that costs nothing and catches a rotten set.
// ---------------------------------------------------------------------------

/**
 * Verifies every fixture's own contract before any agent is spawned: the hidden
 * suite must fail at the base commit, and the visible suite must pass. A
 * fixture that breaks either promise silently corrupts every number computed
 * from it, so this is a first-class command rather than a comment in a README.
 */
async function checkFixtures(fixtures: readonly Fixture[]): Promise<number> {
  const parent = join(evalRoot(), `check-${shortId(6)}`);
  await mkdir(parent, { recursive: true });

  heading(`Checking ${pluralize(fixtures.length, 'fixture')}`);
  out();

  let bad = 0;
  try {
    bad = await checkEach(fixtures, parent);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }

  out();
  if (bad === 0) {
    out(success(`All ${fixtures.length} fixtures hold their contract.`));
    return 0;
  }
  out(failure(`${bad} of ${fixtures.length} fixtures do not hold their contract.`));
  hint('A fixture whose hidden suite already passes, or whose visible suite already fails, measures nothing.');
  return 1;
}

async function checkEach(fixtures: readonly Fixture[], parent: string): Promise<number> {
  const marks = glyphs(theme());
  let bad = 0;

  for (const fixture of fixtures) {
    const workspace = await materializeFixture(fixture, { parent, label: 'check' });
    try {
      const verdict = await verifyFixture(workspace);
      if (verdict.ok) {
        out(
          `  ${success(marks.ok)} ${fixture.id.padEnd(24)} ${dim(
            facts([
              fixture.kind,
              'hidden suite fails at base',
              'visible suite passes',
              verdict.referenceSolves === true ? 'reference solution solves it' : undefined,
            ]),
          )}`,
        );
      } else {
        bad += 1;
        out(`  ${failure(marks.failed)} ${fixture.id.padEnd(24)} ${failure(verdict.problems.join('; '))}`);
      }
    } finally {
      await workspace.cleanup();
    }
  }

  return bad;
}

// ---------------------------------------------------------------------------
// The plan, printed before anything is spent.
// ---------------------------------------------------------------------------

interface PlanView {
  fixtures: readonly Fixture[];
  configs: readonly ResolvedEvalConfig[];
  repeats: number;
  concurrency: number;
  estimate: EvalEstimate;
  models: readonly EvalModelRecord[];
  outDir: string;
  fixturesDir: string;
}

function printPlan(view: PlanView): void {
  const { estimate } = view;

  heading('relay eval');
  out(dim('  Measuring whether cross-model review actually produces better changes.'));
  out();

  section('Plan');
  rows([
    { label: 'Fixtures', value: `${view.fixtures.length}  ${dim(countKinds(view.fixtures))}` },
    { label: 'Arms', value: `${view.configs.length}  ${dim(view.configs.map((entry) => entry.spec.name).join(', '))}` },
    { label: 'Repeats', value: `${view.repeats} ${dim('per fixture per arm — model calls are not deterministic')}` },
    { label: 'Runs', value: formatCount(estimate.runs) },
    { label: 'Agent turns', value: formatRange(estimate.turns, formatCount) },
    {
      label: 'Cost',
      value:
        estimate.costUsd === undefined
          ? warning('unknown')
          : formatCostRange(estimate.costUsd),
    },
    {
      label: 'Wall-clock',
      value:
        estimate.wallClockMs === undefined
          ? warning('unknown')
          : `${formatWallClockRange(estimate.wallClockMs)} ${dim(view.concurrency > 1 ? `at concurrency ${view.concurrency}` : 'sequential')}`,
    },
    { label: 'Models', value: view.models.map((model) => `${model.provider} ${model.cli} (${model.model})`).join(', ') },
    { label: 'Fixtures dir', value: view.fixturesDir },
    { label: 'Results', value: view.outDir },
  ]);

  out();
  hint(`Estimate basis: ${estimate.basis}.`);
  if (view.concurrency > 1) {
    out(warning('  Concurrency above 1 contends for CPU: the wall-clock column stops being comparable across arms.'));
  }

  section('Arms');
  const turnsByArm = new Map(estimate.perConfig.map((entry) => [entry.name, entry.turnsPerRun]));
  for (const { spec } of view.configs) {
    const turns = turnsByArm.get(spec.name);
    out(
      `  ${bold(spec.name)}` +
        (turns === undefined ? '' : dim(`  ${formatRange(turns, formatCount)} turns per run`)),
    );
    out(dim(`    ${spec.summary}`));
    out(dim(`    ${spec.question}`));
  }
}

async function confirm(estimate: EvalEstimate, yes: boolean): Promise<boolean> {
  if (yes) return true;

  const prompter = new Prompter();
  if (!prompter.interactive) {
    out();
    out(warning('  This would spend real money and there is nobody here to ask.'));
    return false;
  }

  out();
  try {
    return await prompter.confirm(
      `Run ${formatCount(estimate.runs)} runs${estimate.costUsd === undefined ? '' : ` (${formatCostRange(estimate.costUsd)})`}?`,
      false,
    );
  } finally {
    prompter.close();
  }
}

// ---------------------------------------------------------------------------
// Execution.
// ---------------------------------------------------------------------------

interface ExecuteView {
  cli: Awaited<ReturnType<typeof createCliContext>>;
  fixtures: readonly Fixture[];
  configs: readonly ResolvedEvalConfig[];
  repeats: number;
  concurrency: number;
  models: readonly EvalModelRecord[];
  outDir: string;
  options: EvalOptions;
}

async function execute(view: ExecuteView): Promise<number> {
  const evalId = createRunId(new Date());
  const workRoot = join(evalRoot(), evalId);
  const tasks = planTasks(view.fixtures, view.configs, view.repeats);
  const controller = new AbortController();

  let interrupted = false;
  const onSigint = (): void => {
    if (interrupted) process.exit(130);
    interrupted = true;
    out();
    out(warning('Stopping after the runs in flight… (press Ctrl-C again to force quit)'));
    controller.abort();
    void Promise.all(Object.values(view.cli.harnesses).map((harness) => harness.cancel()));
  };
  process.on('SIGINT', onSigint);

  section('Runs');
  const startedAt = new Date();
  let outcomes: EvalRunOutcome[];
  try {
    outcomes = await runEvalTasks(
      tasks,
      {
        harnesses: view.cli.harnesses,
        observer: progressObserver(),
        signal: controller.signal,
        workRoot,
        ...(view.options.keep === true ? { keep: true } : {}),
        ...(view.options.verbose === true ? { verbose: true } : {}),
      },
      { concurrency: view.concurrency },
    );
  } finally {
    process.off('SIGINT', onSigint);
  }

  const results: EvalResults = {
    version: 1,
    evalId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    relayVersion: await relayVersion(),
    host: { platform: platform(), nodeVersion: process.version },
    models: [...view.models],
    repeats: view.repeats,
    concurrency: view.concurrency,
    fixtures: view.fixtures.map((fixture) => ({
      id: fixture.id,
      kind: fixture.kind,
      title: fixture.title,
      source: fixture.source,
    })),
    configs: view.configs.map(({ spec, config }) => ({
      name: spec.name,
      summary: spec.summary,
      question: spec.question,
      config,
    })),
    outcomes,
  };

  const resultsPath = await writeResults(view.outDir, results);
  const indexPath = await writeResultsIndex(view.outDir, await loadResults(view.outDir));

  // A sweep in which nothing could be graded produced no evidence, and a script
  // that trusted the exit code would publish a table of empty cells.
  const graded = outcomes.filter((outcome) => outcome.grade.ungraded === undefined);
  const code = graded.length === 0 ? EXIT.error : EXIT.success;

  if (view.options.json === true) {
    emitJson('eval', { results, aggregates: aggregate(results), report: indexPath, raw: resultsPath });
    return code;
  }

  printResults(results, resultsPath, indexPath);
  return code;
}

function progressObserver(): EvalProgressObserver {
  const marks = glyphs(theme());

  return {
    taskStarted(task: EvalTask, index: number, total: number): void {
      out(
        dim(
          `  [${String(index).padStart(String(total).length)}/${total}] ` +
            `${task.fixture.id} · ${task.resolved.spec.name} #${task.repeat} …`,
        ),
      );
    },
    taskFinished(outcome: EvalRunOutcome, index: number, total: number): void {
      const mark = outcome.grade.ungraded !== undefined
        ? warning('?')
        : outcome.solved
          ? success(marks.ok)
          : failure(marks.failed);
      const verdict = outcome.grade.ungraded !== undefined
        ? dim('ungraded')
        : outcome.solved
          ? success('solved')
          : failure('unsolved');

      out(
        `  [${String(index).padStart(String(total).length)}/${total}] ${mark} ${verdict.padEnd(8)} ` +
          `${outcome.fixtureId} · ${outcome.configName} #${outcome.repeat}  ` +
          dim(
            facts([
              formatDuration(outcome.wallClockMs),
              `${outcome.turns} turns`,
              outcome.usage?.costUsd === undefined ? undefined : formatCost(outcome.usage.costUsd),
              outcome.regressed ? warning('regression') : undefined,
              outcome.review.rescued ? success('review rescued it') : undefined,
              outcome.review.broke ? warning('review broke it') : undefined,
            ]),
          ),
      );
      if (outcome.grade.ungraded !== undefined) out(dim(`          ${outcome.grade.ungraded}`));
    },
    note(text: string): void {
      out(dim(`      ${text}`));
    },
    warn(text: string): void {
      out(warning(`      ${text}`));
    },
  };
}

function printResults(results: EvalResults, resultsPath: string, indexPath: string): void {
  const aggregates = aggregate(results);

  section('Results');
  for (const line of gridLines(RESULT_COLUMNS.map((header) => ({ header })), resultRows(aggregates))) {
    out(`  ${line}`);
  }

  section('Comparisons');
  const verdicts = comparisonVerdicts(aggregates);
  if (verdicts.length === 0) {
    out(dim('  No comparison had both of its arms in this run.'));
  }
  for (const verdict of verdicts) {
    out(`  ${bold(verdict.name)} ${dim(`— ${verdict.question}`)}`);
    for (const line of verdict.lines) out(`    ${stripMarkdown(line)}`);
  }

  const hidden = results.outcomes.filter((outcome) => outcome.hiddenPathTouched === true);
  if (hidden.length > 0) {
    out();
    out(
      warning(
        `  ${hidden.length} run(s) wrote to a hidden-suite path. The overlay overwrites it before grading, ` +
          'so no result changed — but it is worth reading the diffs.',
      ),
    );
  }

  section('Written');
  rows([
    { label: 'Raw data', value: resultsPath },
    { label: 'Table', value: indexPath },
  ]);
  out();
  hint('To regenerate the table from every recorded session:');
  command('relay eval --report');
  out();
}

/** The terminal is not markdown; the report renderer's emphasis is dropped here. */
function stripMarkdown(line: string): string {
  return line.replace(/\*\*/g, '').replace(/`/g, '').replace(/^- /, '');
}

// ---------------------------------------------------------------------------
// Facts about the environment that a result is only meaningful alongside.
// ---------------------------------------------------------------------------

async function modelRecords(
  cli: Awaited<ReturnType<typeof createCliContext>>,
  configs: readonly ResolvedEvalConfig[],
): Promise<EvalModelRecord[]> {
  const records: EvalModelRecord[] = [];
  for (const provider of providersUsed(configs)) {
    const harness = cli.harnesses[provider];
    if (harness === undefined) {
      records.push({ provider, cli: 'unavailable', model: 'unknown' });
      continue;
    }
    const availability = await harness.checkAvailability();
    records.push({
      provider,
      cli: availability.available ? (availability.version ?? availability.detail) : 'unavailable',
      model: cli.config.models[provider] ?? 'default',
    });
  }
  return records;
}

/**
 * A per-turn rate from runs that actually happened.
 *
 * Previously recorded eval sessions first, because they are like for like. This
 * repository's own run history second, because it is at least real. Nothing
 * third: an estimate with no measurement behind it is a guess with a decimal
 * point, and Relay does not price tokens itself anywhere else either.
 */
async function loadCalibration(repoRoot: string, outDir: string): Promise<Calibration | undefined> {
  const sets = await loadResults(outDir);
  const fromEval = calibrationFrom(samplesFromResults(sets), 'previously recorded eval sessions');
  if (fromEval !== undefined) return fromEval;

  return calibrationFrom(
    samplesFromRuns(await listRuns(repoRoot)),
    'this repository\'s own run history, which is larger work than a fixture',
  );
}

/** A damaged installation must not lose a session's results over its own version. */
async function relayVersion(): Promise<string> {
  try {
    return await packageVersion();
  } catch {
    return 'unknown';
  }
}
