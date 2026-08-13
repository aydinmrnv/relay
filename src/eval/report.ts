/**
 * Turning outcomes into a result, and a result into something a person can
 * disagree with.
 *
 * The published table is the point of the whole exercise. If the numbers do not
 * support the design, the honest outcome is a changed default and a corrected
 * README — so the report is written to make that legible rather than to be
 * skimmed past: every rate carries its interval, every comparison states
 * "inconclusive" when the intervals overlap, and the model versions sit at the
 * top because a result attached to no model version expires silently.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWriteFile, atomicWriteJson } from '../storage/atomic.ts';
import { formatDuration } from '../util/text.ts';
import { formatCost, unpricedTurns } from '../workflow/usage.ts';
import { EVAL_COMPARISONS } from './configs.ts';
import {
  compareProportions,
  formatProportion,
  formatSummary,
  proportion,
  summarize,
  type Proportion,
  type Summary,
} from './stats.ts';
import type { EvalResults, EvalRunOutcome } from './types.ts';

export interface ConfigAggregate {
  name: string;
  summary: string;
  question: string;
  runs: number;
  /** Runs whose hidden suite could not be run at all — no commit, or a crash. */
  ungraded: number;
  solveRate: Proportion;
  regressionRate: Proportion;
  /** Over the runs whose CLI reported a price. Null when none did. */
  costUsd: Summary | null;
  /** Runs that reported any price at all — the denominator `costUsd` is over. */
  pricedRuns: number;
  /**
   * Turns across the arm that published no price, so `costUsd` is a floor.
   *
   * Counted per turn rather than per run because a run can report a cost *and*
   * be missing most of its bill: Codex publishes no price, so a cross-model run
   * reports Claude's half and stays silent about the other.
   */
  unpricedTurns: number;
  wallClockMs: Summary;
  turns: Summary;
  blockingFindings: Summary;
  /** Runs where review turned a failing change into a passing one. */
  rescued: number;
  /** Runs where review turned a passing change into a failing one. */
  broke: number;
}

function aggregateOne(
  name: string,
  summaryText: string,
  question: string,
  outcomes: readonly EvalRunOutcome[],
): ConfigAggregate {
  // A run that could not be graded is excluded from the rate rather than
  // counted as a loss: a git failure is not evidence about a pipeline. It is
  // reported separately so an arm that mostly fails to produce a commit cannot
  // hide behind a high rate over three runs.
  const graded = outcomes.filter((outcome) => outcome.grade.ungraded === undefined);
  const priced = outcomes.filter((outcome) => outcome.usage?.costUsd !== undefined);

  return {
    name,
    summary: summaryText,
    question,
    runs: outcomes.length,
    ungraded: outcomes.length - graded.length,
    solveRate: proportion(graded.filter((outcome) => outcome.solved).length, graded.length),
    regressionRate: proportion(graded.filter((outcome) => outcome.regressed).length, graded.length),
    costUsd: priced.length === 0 ? null : summarize(priced.map((outcome) => outcome.usage?.costUsd ?? 0)),
    pricedRuns: priced.length,
    unpricedTurns: outcomes.reduce(
      (total, outcome) => total + (outcome.usage === null ? outcome.turns : unpricedTurns(outcome.usage)),
      0,
    ),
    wallClockMs: summarize(outcomes.map((outcome) => outcome.wallClockMs)),
    turns: summarize(outcomes.map((outcome) => outcome.turns)),
    blockingFindings: summarize(outcomes.map((outcome) => outcome.review.blocking)),
    rescued: outcomes.filter((outcome) => outcome.review.rescued).length,
    broke: outcomes.filter((outcome) => outcome.review.broke).length,
  };
}

export function aggregate(results: EvalResults): ConfigAggregate[] {
  return results.configs.map((config) =>
    aggregateOne(
      config.name,
      config.summary,
      config.question,
      results.outcomes.filter((outcome) => outcome.configName === config.name),
    ),
  );
}

/** Merges several result files into one set of aggregates, arm by arm. */
export function aggregateAll(sets: readonly EvalResults[]): ConfigAggregate[] {
  const specs = new Map<string, { summary: string; question: string }>();
  for (const set of sets) {
    for (const config of set.configs) specs.set(config.name, { summary: config.summary, question: config.question });
  }

  return [...specs.entries()].map(([name, spec]) =>
    aggregateOne(
      name,
      spec.summary,
      spec.question,
      sets.flatMap((set) => set.outcomes.filter((outcome) => outcome.configName === name)),
    ),
  );
}

/**
 * Cost per run, with the caveat that makes it honest.
 *
 * A missing price means "not reported" and never "free", so a number computed
 * from a partial bill says how partial it is: how many runs contributed a price
 * at all, and how many turns across the arm published none.
 */
function formatCostSummary(aggregate: ConfigAggregate): string {
  if (aggregate.costUsd === null) return 'not reported';

  const caveats: string[] = [];
  if (aggregate.pricedRuns < aggregate.runs) caveats.push(`${aggregate.pricedRuns}/${aggregate.runs} runs priced`);
  if (aggregate.unpricedTurns > 0) caveats.push(`${aggregate.unpricedTurns} turns unpriced`);

  const floor = caveats.length === 0 ? '' : ` (≥, ${caveats.join(', ')})`;
  return `${formatCost(aggregate.costUsd.mean)}${floor}`;
}

function formatWallClock(aggregate: ConfigAggregate): string {
  if (aggregate.wallClockMs.n === 0) return '—';
  return formatDuration(aggregate.wallClockMs.mean);
}

export interface TableRow {
  cells: string[];
}

export const RESULT_COLUMNS = [
  'configuration',
  'solve rate',
  'regression rate',
  'cost / run',
  'wall-clock / run',
  'turns / run',
  'blocking findings / run',
  'review rescued',
] as const;

export function resultRows(aggregates: readonly ConfigAggregate[]): string[][] {
  return aggregates.map((entry) => [
    entry.name,
    formatProportion(entry.solveRate),
    formatProportion(entry.regressionRate),
    formatCostSummary(entry),
    formatWallClock(entry),
    formatSummary(entry.turns),
    formatSummary(entry.blockingFindings),
    `${entry.rescued} rescued / ${entry.broke} broken`,
  ]);
}

function markdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ];
}

/**
 * The verdict for one comparison.
 *
 * Deliberately blunt about uncertainty: with a handful of repetitions per
 * fixture, most differences will not clear the interval, and reporting those as
 * "no difference" would be as wrong as reporting them as a win.
 */
export interface ComparisonVerdict {
  name: string;
  question: string;
  baseline: string;
  lines: string[];
}

export function comparisonVerdicts(aggregates: readonly ConfigAggregate[]): ComparisonVerdict[] {
  const byName = new Map(aggregates.map((entry) => [entry.name, entry]));
  const verdicts: ComparisonVerdict[] = [];

  for (const comparison of EVAL_COMPARISONS) {
    const present = comparison.configs.filter((name) => byName.has(name));
    if (present.length < 2) continue;

    const baselineName = present[present.length - 1]!;
    const baseline = byName.get(baselineName)!;
    const lines: string[] = [];

    for (const name of present) {
      if (name === baselineName) continue;
      const arm = byName.get(name)!;
      const verdict = compareProportions(arm.solveRate, baseline.solveRate);
      const winner =
        verdict === 'inconclusive'
          ? `**inconclusive** — the intervals overlap at n=${arm.solveRate.n} and n=${baseline.solveRate.n}`
          : verdict === 'a'
            ? `**${name}** solves more`
            : `**${baselineName}** solves more`;
      lines.push(
        `- \`${name}\` ${formatProportion(arm.solveRate)} vs \`${baselineName}\` ` +
          `${formatProportion(baseline.solveRate)} → ${winner}.`,
      );
    }

    verdicts.push({ name: comparison.name, question: comparison.question, baseline: baselineName, lines });
  }

  return verdicts;
}

function modelLine(results: EvalResults): string {
  if (results.models.length === 0) return '_no model versions were recorded_';
  return results.models
    .map((model) => `${model.provider} ${model.cli} (model: ${model.model})`)
    .join(', ');
}

/**
 * The published table.
 *
 * `sets` is every result file in the output directory, so re-running the eval
 * accumulates evidence instead of replacing it, and the intervals narrow over
 * time rather than being re-rolled from three runs each Monday.
 */
export function renderResultsMarkdown(sets: readonly EvalResults[]): string {
  if (sets.length === 0) {
    // Deliberately not a table of zeroes. An empty result set is the absence of
    // evidence, and the one thing this file must never do is look like evidence.
    return [
      '# Relay eval results',
      '',
      '<!-- Generated by `relay eval`. Edits here are overwritten; change the harness or add fixtures instead. -->',
      '',
      'Relay claims that specialized agents reviewing each other\'s engineering work produce better',
      'changes than one agent working alone. This file is where that claim gets measured.',
      '',
      '**No session has been recorded yet, so there are no numbers here.**',
      '',
      'Producing them costs real model calls and real wall-clock. The estimate is printed first:',
      '',
      '```bash',
      'relay eval --check-fixtures                          # verify the fixture set — free',
      'relay eval --compare second-agent --dry-run          # the plan and the cost — free',
      'relay eval --compare second-agent --out eval/results # the headline claim',
      '```',
      '',
      'Each session writes one JSON file under `runs/` and regenerates this table from every session',
      'in the directory, so evidence accumulates and the intervals narrow rather than being re-rolled.',
      'Every session records the CLI version and pinned model of each agent, because a result attached',
      'to no model version expires silently — this table will name them once there is one.',
      '',
    ].join('\n');
  }

  const ordered = [...sets].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const latest = ordered[ordered.length - 1]!;
  const aggregates = aggregateAll(ordered);
  const totalRuns = ordered.reduce((sum, set) => sum + set.outcomes.length, 0);
  const fixtures = new Set(ordered.flatMap((set) => set.fixtures.map((fixture) => fixture.id)));

  const lines: string[] = [
    '# Relay eval results',
    '',
    '<!-- Generated by `relay eval`. Edits here are overwritten; change the harness or add fixtures instead. -->',
    '',
    'Relay claims that specialized agents reviewing each other\'s engineering work produce better',
    'changes than one agent working alone. This file is that claim, measured.',
    '',
    '| | |',
    '|---|---|',
    `| runs | ${totalRuns} across ${ordered.length} eval session(s) |`,
    `| fixtures | ${fixtures.size} |`,
    `| models | ${modelLine(latest)} |`,
    `| relay | ${latest.relayVersion} |`,
    `| host | ${latest.host.platform}, node ${latest.host.nodeVersion} |`,
    `| latest session | ${latest.startedAt} |`,
    '',
    'Rates carry 95% Wilson intervals. Means carry one sample standard deviation. A result with',
    'no error bar on a stochastic pipeline is not a result.',
    '',
    '## Configurations',
    '',
    ...markdownTable(RESULT_COLUMNS, resultRows(aggregates)),
    '',
    '## What each configuration is',
    '',
  ];

  for (const entry of aggregates) {
    lines.push(`- **\`${entry.name}\`** — ${entry.summary}`);
    lines.push(`  _${entry.question}_`);
  }

  lines.push('', '## The comparisons', '');
  const verdicts = comparisonVerdicts(aggregates);
  if (verdicts.length === 0) {
    lines.push('_No comparison has both of its arms in these results yet._');
  }
  for (const verdict of verdicts) {
    lines.push(`### ${verdict.name}`, '', `_${verdict.question}_`, '', ...verdict.lines, '');
  }

  const ungraded = aggregates.reduce((sum, entry) => sum + entry.ungraded, 0);
  if (ungraded > 0) {
    lines.push(
      '## Ungraded runs',
      '',
      `${ungraded} run(s) produced no commit to grade — a crashed pipeline, a cancelled run, or an`,
      'implementer that changed nothing. They are excluded from the rates above and reported here',
      'because an arm that often fails to produce anything is not the same as one that produces',
      'wrong answers.',
      '',
      ...markdownTable(
        ['configuration', 'ungraded', 'of'],
        aggregates
          .filter((entry) => entry.ungraded > 0)
          .map((entry) => [entry.name, String(entry.ungraded), String(entry.runs)]),
      ),
      '',
    );
  }

  lines.push(
    '## Raw data',
    '',
    'Every session in this directory is a JSON file under `runs/`, holding one record per run:',
    'the configuration, the fixture, the phase it ended in, the hidden-suite exit code, the token',
    'counts and the wall-clock. Regenerate this file with `relay eval --report`.',
    '',
  );

  return `${lines.join('\n')}\n`;
}

export const RESULTS_INDEX = 'RESULTS.md';
export const RESULTS_RUNS_DIR = 'runs';

export async function writeResults(outDir: string, results: EvalResults): Promise<string> {
  const path = join(outDir, RESULTS_RUNS_DIR, `${results.evalId}.json`);
  await atomicWriteJson(path, results);
  return path;
}

/** Every recorded session in an output directory, oldest first. Unreadable files are skipped. */
export async function loadResults(outDir: string): Promise<EvalResults[]> {
  const dir = join(outDir, RESULTS_RUNS_DIR);
  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }

  const sets: EvalResults[] = [];
  for (const entry of entries) {
    try {
      const parsed = JSON.parse(await readFile(join(dir, entry), 'utf8')) as EvalResults;
      if (parsed.version === 1 && Array.isArray(parsed.outcomes)) sets.push(parsed);
    } catch {
      continue;
    }
  }
  return sets;
}

export async function writeResultsIndex(outDir: string, sets: readonly EvalResults[]): Promise<string> {
  const path = join(outDir, RESULTS_INDEX);
  await atomicWriteFile(path, renderResultsMarkdown(sets));
  return path;
}
