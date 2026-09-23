import { listRuns } from '../../storage/runs.ts';
import { formatDuration } from '../../util/text.ts';
import { phaseLabel, type Phase } from '../../workflow/phases.ts';
import { repositoryStats, type RepositoryStats, type UnattendedRunSummary } from '../../workflow/stats.ts';
import { formatCost } from '../../workflow/usage.ts';
import { createCliContext } from '../context.ts';
import { EXIT } from '../exit.ts';
import { emitJson } from '../json.ts';
import { box, dim, emptyState, facts, gridLines, hint, out, rows, section, warning } from '../output.ts';

export interface StatsOptions {
  json?: boolean;
}

/**
 * What Relay has cost and caught in this repository.
 *
 * The last two lines are the point of the command: Relay's whole claim is that
 * a second model reading the plan and the diff is worth what it spends, and
 * this is that claim measured on the user's own work rather than asserted in a
 * README. A repository where plan review never changes the plan is a
 * repository that should turn plan review off, and it should be able to find
 * that out from the tool that is charging it.
 */
export async function statsCommand(options: StatsOptions = {}): Promise<number> {
  const cli = await createCliContext();
  const runs = await listRuns(cli.repo.root);
  const stats = repositoryStats(runs);

  if (options.json === true) {
    emitJson('stats', statsToJson(cli.repo.root, stats));
    return EXIT.success;
  }

  if (stats.runs === 0) {
    emptyState('No runs yet in this repository, so there is nothing to report.', [
      'relay run <issue-number>',
      'relay status              # once a run has finished',
    ]);
    return 0;
  }

  box({
    title: `Relay stats for ${cli.repo.root}`,
    badge: `${stats.runs} run${stats.runs === 1 ? '' : 's'}`,
    body: gridLines(
      [{ header: '' }, { header: '' }],
      [
        [
          'Outcome',
          facts([
            `${stats.complete} complete`,
            stats.failed > 0 && `${stats.failed} failed`,
            stats.cancelled > 0 && `${stats.cancelled} stopped`,
            stats.running > 0 && `${stats.running} unfinished`,
          ]),
        ],
        [
          'Success rate',
          stats.successRate === undefined
            ? 'no run has finished yet'
            : `${Math.round(stats.successRate * 100)}% of finished runs`,
        ],
        [
          'Duration',
          stats.duration === undefined
            ? 'no completed run to measure'
            : facts([
                `median ${formatDuration(stats.duration.median)}`,
                `p90 ${formatDuration(stats.duration.p90)}`,
                `${stats.duration.runs} run(s)`,
              ]),
        ],
        [
          'Cost',
          stats.cost === undefined
            ? 'no run reported one'
            : facts([
                `median ${formatCost(stats.cost.median)}`,
                `p90 ${formatCost(stats.cost.p90)}`,
                `${formatCost(stats.cost.total)} in total`,
                `${stats.cost.runs} run(s)`,
              ]),
        ],
      ],
    ),
  });

  const unpriced = stats.cost?.unpriced ?? 0;
  if (unpriced > 0) hint(`${unpriced} turn(s) reported no price, so every cost here is a floor.`);

  if (stats.costByPhase.length > 0) {
    section('Cost by phase');
    rows(
      stats.costByPhase.map((entry) => ({
        label: phaseLabel(entry.phase),
        value: facts([
          `median ${formatCost(entry.median)}`,
          `${formatCost(entry.total)} in total`,
          dim(`${entry.runs} run(s)`),
        ]),
      })),
    );
  }

  const { planReview, codeReview } = stats.rounds;
  if (planReview !== undefined || codeReview !== undefined) {
    section('Rounds');
    rows([
      planReview !== undefined && {
        label: 'Plan review',
        value: facts([`median ${planReview.median}`, `max ${planReview.max}`, dim(`${planReview.runs} run(s)`)]),
      },
      codeReview !== undefined && {
        label: 'Code review',
        value: facts([`median ${codeReview.median}`, `max ${codeReview.max}`, dim(`${codeReview.runs} run(s)`)]),
      },
    ]);
  }

  printUnattended(stats);

  section('What the reviews caught');
  rows([
    {
      label: 'Plan review changed the plan',
      value: stats.planChanged === undefined ? dim('no run has reviewed a plan yet') : share(stats.planChanged),
    },
    {
      label: 'Code review blocked the diff',
      value: stats.codeBlocked === undefined ? dim('no run has reviewed a diff yet') : share(stats.codeBlocked),
    },
  ]);
  out();

  return 0;
}

/**
 * The audit trail for everything that ran without a person.
 *
 * Printed only when there is something to print: a repository that has never
 * turned unattended runs on should not be shown an empty section implying it
 * should have. When there is, every row answers the same five questions —
 * which issue, who labelled it, what it cost, what it delivered, why it
 * stopped — because "an agent ran on its own and spent money" is exactly the
 * event somebody eventually has to account for to somebody else.
 */
function printUnattended(stats: RepositoryStats): void {
  const unattended = stats.unattended;
  if (unattended === undefined) return;

  section('Unattended');
  rows([
    {
      label: 'Started by a label',
      value: facts([
        `${unattended.runs} run(s)`,
        `${formatCost(unattended.costUsd)} in total`,
        unattended.unpriced > 0 && dim(`${unattended.unpriced} unpriced turn(s), so that is a floor`),
      ]),
    },
    {
      label: `Today (${unattended.today.day})`,
      value: facts([`${unattended.today.runs} run(s)`, formatCost(unattended.today.costUsd)]),
    },
    {
      label: 'Who asked',
      value:
        unattended.actors.length === 0
          ? dim('nobody the tracker could name')
          : facts(unattended.actors.slice(0, 5).map((entry) => `${entry.actor} ${dim(`${entry.runs}`)}`)),
    },
  ]);

  out();
  for (const run of unattended.recent) out(`  ${unattendedLine(run)}`);
  out();
}

/** One unattended run on one line: issue, who, cost, delivery, outcome. */
function unattendedLine(run: UnattendedRunSummary): string {
  const who = run.actor === null ? 'unknown' : run.actor + (run.team === null ? '' : ` via ${run.team}`);
  const cost = run.costUsd === null ? 'no price reported' : formatCost(run.costUsd);
  const delivered = run.pullRequest ?? (run.delivered === 'none' ? 'nothing delivered' : run.delivered);
  const why =
    run.outcome === 'COMPLETE'
      ? undefined
      : run.stopped === null
        ? run.outcome.toLowerCase()
        : `${run.outcome.toLowerCase()}: ${run.stopped}`;
  return facts([
    /^\d+$/.test(run.issueRef) ? `#${run.issueRef}` : run.issueRef,
    dim(`${run.label} by ${who}`),
    cost,
    delivered,
    why === undefined ? false : warning(why),
  ]);
}

function share(frequency: { runs: number; of: number }): string {
  return `${frequency.runs} of ${frequency.of} run(s)` + dim(`  ${Math.round((frequency.runs / frequency.of) * 100)}%`);
}

/**
 * The machine-readable shape. Absent facts are `null` rather than omitted
 * keys, matching `relay status --json`: a consumer indexes every field without
 * guarding, and a repository with no cost data has the same schema as one with
 * a year of it.
 */
export interface StatsJson {
  repository: string;
  runs: number;
  outcomes: { complete: number; failed: number; cancelled: number; running: number };
  successRate: number | null;
  duration: { medianMs: number; p90Ms: number; runs: number } | null;
  cost: { medianUsd: number; p90Usd: number; totalUsd: number; runs: number; unpricedTurns: number } | null;
  costByPhase: Array<{ phase: Phase; label: string; medianUsd: number; totalUsd: number; runs: number }>;
  rounds: {
    planReview: { median: number; max: number; runs: number } | null;
    codeReview: { median: number; max: number; runs: number } | null;
  };
  planReviewChangedPlan: { runs: number; of: number } | null;
  codeReviewBlocked: { runs: number; of: number } | null;
  /** Null until something has started a run in this repository without a person. */
  unattended: {
    runs: number;
    costUsd: number;
    unpricedTurns: number;
    today: { day: string; runs: number; costUsd: number };
    actors: Array<{ actor: string; runs: number; costUsd: number }>;
    recent: UnattendedRunSummary[];
  } | null;
}

export function statsToJson(repository: string, stats: RepositoryStats): StatsJson {
  return {
    repository,
    runs: stats.runs,
    outcomes: {
      complete: stats.complete,
      failed: stats.failed,
      cancelled: stats.cancelled,
      running: stats.running,
    },
    successRate: stats.successRate ?? null,
    duration:
      stats.duration === undefined
        ? null
        : { medianMs: stats.duration.median, p90Ms: stats.duration.p90, runs: stats.duration.runs },
    cost:
      stats.cost === undefined
        ? null
        : {
            medianUsd: stats.cost.median,
            p90Usd: stats.cost.p90,
            totalUsd: stats.cost.total,
            runs: stats.cost.runs,
            unpricedTurns: stats.cost.unpriced,
          },
    costByPhase: stats.costByPhase.map((entry) => ({
      phase: entry.phase,
      label: phaseLabel(entry.phase),
      medianUsd: entry.median,
      totalUsd: entry.total,
      runs: entry.runs,
    })),
    rounds: {
      planReview: stats.rounds.planReview ?? null,
      codeReview: stats.rounds.codeReview ?? null,
    },
    planReviewChangedPlan: stats.planChanged ?? null,
    codeReviewBlocked: stats.codeBlocked ?? null,
    unattended:
      stats.unattended === undefined
        ? null
        : {
            runs: stats.unattended.runs,
            costUsd: stats.unattended.costUsd,
            unpricedTurns: stats.unattended.unpriced,
            today: stats.unattended.today,
            actors: stats.unattended.actors,
            recent: stats.unattended.recent,
          },
  };
}
