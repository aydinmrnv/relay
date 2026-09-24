/**
 * What a workflow will cost before it runs.
 *
 * A Monte Carlo forecast over the same simulator test runs use: a few hundred
 * seeded runs of the workflow, summarised as a cost distribution, outcome
 * rates and where the money goes, then resampled into weeks and months at a
 * ticket volume, with the budget gate's daily ceiling applied the way
 * `relay serve` applies it. Everything is seeded, so the same workflow and
 * options give the same forecast. It is a model, not a quote: real runs report
 * what the CLIs actually charged.
 */
import { defaultConfig, getNodeType } from '../connectors';
import type { Brand } from '../brand';
import { formatUsd } from '../format';
import type { Run, Workflow, WorkflowNode } from './schema';
import { simulateRun } from './simulate';

export const DEFAULT_FORECAST_SAMPLES = 300;
export const DEFAULT_TICKETS_PER_WEEK = 10;
/** Tickets are filed on working days, so a week's volume is spread over five of them. */
export const WORKING_DAYS_PER_WEEK = 5;
const WEEKS_PER_MONTH = 52 / 12;
/** Weeks, and separately months, redrawn from the sampled runs for each volume. */
export const FORECAST_TRIALS = 500;
const BATCH = 25;
const HISTOGRAM_BINS = 12;
/** "No daily ceiling" in the copy the forecast simulates; see `forecastCopy`. */
const UNCAPPED = 1e9;

const PIPELINE_TYPES = new Set(['pipeline.action.run', 'pipeline.action.fast']);
const BUDGET_GATE = 'gates.action.budget';
const MANUAL_TRIGGER = 'logic.trigger.manual';
const PHASE_ORDER = ['FETCHING_ISSUE', 'CREATING_WORKSPACE', 'PLANNING', 'REVIEWING_PLAN', 'REVISING_PLAN', 'IMPLEMENTING', 'REVIEWING_CODE', 'REVISING_CODE', 'TESTING'];
const GATE_KINDS: Record<string, GateKind> = {
  'gates.action.budget': 'budget',
  'gates.action.allowlist': 'allowlist',
  'gates.action.approval': 'approval',
  'gates.action.kill-switch': 'kill-switch',
};

/* ------------------------------------------------------------------ */
/* Shape                                                               */
/* ------------------------------------------------------------------ */

export interface ForecastOptions {
  brand: Brand;
  /** Simulated runs. Default 300. */
  samples?: number;
  ticketsPerWeek: number;
  seed?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/**
 * - `ok`: runs reached the agent pipeline and the numbers below describe them.
 * - `no-trigger` / `no-pipeline`: there is nothing to forecast; `notes` says why.
 * - `unreached`: a pipeline exists but no simulated run got to it (a gate refused them all, or it is not connected).
 */
export type ForecastStatus = 'ok' | 'no-trigger' | 'no-pipeline' | 'unreached';

export type GateKind = 'budget' | 'allowlist' | 'approval' | 'kill-switch' | 'other';
export type FailureKind = 'tests' | 'run-cap' | 'other';

export interface CostStats {
  /** Runs these statistics are over. */
  count: number;
  min: number;
  p10: number;
  p50: number;
  p90: number;
  max: number;
  mean: number;
}

export interface HistogramBin {
  fromUsd: number;
  toUsd: number;
  count: number;
  /** Of the runs that reached the pipeline. */
  share: number;
}

export interface RefusalShare {
  nodeId: string;
  gate: GateKind;
  label: string;
  /** Of all simulated runs. */
  rate: number;
}

export interface FailureShare {
  reason: FailureKind;
  label: string;
  /** Of all simulated runs. */
  rate: number;
}

/** What becomes of a ticket. Every rate is a share of all simulated runs; the five top-level ones add up to 1. */
export interface ForecastOutcomes {
  /** The pipeline finished and its change went on to delivery. */
  delivered: number;
  /** Delivered with a pull request opened. Part of `delivered`, not in addition to it. */
  pullRequests: number;
  /** Finished without starting the agents: a condition sent the ticket down another path. */
  otherPath: number;
  /** Stopped by a guardrail before the pipeline. */
  refused: number;
  /** The pipeline ran and did not finish: tests failed, or it was stopped at the per-run budget. */
  failed: number;
  waiting: number;
  refusedBy: RefusalShare[];
  failedBy: FailureShare[];
}

export interface PhaseShare {
  /** The engine's phase name, e.g. `IMPLEMENTING`, or `OTHER` for spend outside the pipeline (AI steps). */
  phase: string;
  label: string;
  /** Who spends it, as display names. */
  agents: string[];
  /** Average per run that reached the pipeline, every round included. */
  meanUsd: number;
  /** Of all spend on runs that reached the pipeline. */
  share: number;
  /** Share of those runs in which the phase ran at least once: extra review rounds are the ones below 1. */
  frequency: number;
}

export interface AgentShare {
  agent: string;
  meanUsd: number;
  share: number;
}

export interface Percentiles {
  p50: number;
  p90: number;
  mean: number;
}

export interface ForecastProjection {
  ticketsPerWeek: number;
  ticketsPerMonth: number;
  /** Simulated weeks, and separately months, each drawn from the sampled runs. */
  trials: number;
  weekly: Percentiles;
  monthly: Percentiles;
  /** Spend on one working day: what a daily ceiling is measured against. */
  daily: { p50: number; p90: number; max: number };
  pullRequestsPerMonth: number;
  /** Tickets a month the daily ceiling refuses; 0 without one. */
  refusedByDailyCapPerMonth: number;
}

export interface RunCapForecast {
  usd: number;
  /** Where the ceiling comes from: the pipeline's "Stop this run above", or the budget gate's per-run maximum. */
  source: 'pipeline' | 'budget-gate';
  /**
   * True when the engine checks it at every phase boundary and stops the run.
   * False for a run started by hand behind a budget gate: the gate only checks
   * the estimate before starting, so an expensive run is not stopped.
   */
  enforcedInRun: boolean;
  /** Of the runs that reached the pipeline: stopped by the cap, or (not enforced) costing more than it. */
  hitRate: number;
}

export interface DailyCapForecast {
  usd: number;
  /** What the gate holds back for a run about to start: its per-run ceiling. */
  reserveUsd: number;
  /** Runs a day fits at a typical (p50) and an expensive (p90) run cost. Null when no run reached the pipeline. */
  runsPerDayAtP50: number | null;
  runsPerDayAtP90: number | null;
  ticketsPerDay: number;
  /** Share of working days on which the ceiling refuses at least one run. */
  hitDayRate: number;
  /** Share of tickets the ceiling refuses. */
  refusedRate: number;
}

export interface ConfirmForecast {
  usd: number;
  /** Only runs started by hand ask: an unattended run has nobody to ask, and the per-run cap is its ceiling. */
  applies: boolean;
  /** A typical run costs more than the threshold. */
  wouldAsk: boolean;
}

export interface ForecastBudget {
  gateNodeId: string | null;
  runCap: RunCapForecast | null;
  dailyCap: DailyCapForecast | null;
  confirm: ConfirmForecast | null;
}

/** One simulated run, reduced to what projecting a volume needs. */
export interface ForecastSample {
  costUsd: number;
  /** Spent outside the pipeline, e.g. by an AI step: what a run the daily ceiling refuses still costs. */
  otherUsd: number;
  reachedPipeline: boolean;
  outcome: 'delivered' | 'other-path' | 'refused' | 'failed' | 'waiting';
  pullRequest: boolean;
  /** Passed the budget gate in the simulation, so in a real day the daily ceiling decides whether it starts. */
  gated: boolean;
  durationMs: number;
}

/** Enough to project another volume without simulating again. */
export interface ForecastBasis {
  runs: ForecastSample[];
  dailyCapUsd: number | null;
  reserveUsd: number;
  seed: number;
}

export interface Forecast {
  status: ForecastStatus;
  /** Simulated runs. */
  samples: number;
  seed: number;
  /** Started by something other than a person pressing Run; the unattended rules apply. */
  unattended: boolean;
  /** Average cost of a ticket, whatever became of it: what a volume multiplies. */
  meanCostPerTicketUsd: number;
  /** Cost of the runs that reached the agent pipeline. Null when none did. */
  cost: CostStats | null;
  histogram: HistogramBin[];
  outcomes: ForecastOutcomes;
  /** Trigger to finish, for runs that reached the pipeline; approvals and holds included. */
  duration: { p50Ms: number; p90Ms: number } | null;
  phases: PhaseShare[];
  agents: AgentShare[];
  projection: ForecastProjection;
  budget: ForecastBudget | null;
  /** Plain-English takeaways, most important first. */
  notes: string[];
  basis: ForecastBasis;
}

/* ------------------------------------------------------------------ */
/* Forecast                                                            */
/* ------------------------------------------------------------------ */

export async function forecastWorkflow(workflow: Workflow, options: ForecastOptions): Promise<Forecast> {
  const samples = Math.max(1, Math.round(options.samples ?? DEFAULT_FORECAST_SAMPLES));
  const seed = (options.seed ?? defaultSeed(workflow)) >>> 0;
  const trigger = workflow.nodes.find((node) => getNodeType(node.data.typeId)?.kind === 'trigger');
  const unattended = trigger !== undefined && trigger.data.typeId !== MANUAL_TRIGGER;
  if (trigger === undefined) return emptyForecast('no-trigger', seed, unattended, options.ticketsPerWeek);
  if (!workflow.nodes.some((node) => PIPELINE_TYPES.has(node.data.typeId))) return emptyForecast('no-pipeline', seed, unattended, options.ticketsPerWeek);

  const copy = forecastCopy(workflow, unattended);
  const gateIds = workflow.nodes.filter((node) => node.data.typeId === BUDGET_GATE).map((node) => node.id);
  const runs: ForecastSample[] = [];
  const refusals = new Map<string, number>();
  const failures = new Map<FailureKind, number>();
  const phaseTotals = new Map<string, { label: string; usd: number; runs: number; agents: Set<string> }>();
  const agentTotals = new Map<string, number>();

  for (let index = 0; index < samples; index += 1) {
    options.signal?.throwIfAborted();
    const run = await simulateRun(copy, { speed: 'instant', seed: sampleSeed(seed, index), brand: options.brand });
    const sample = toSample(run, gateIds);
    runs.push(sample);

    if (sample.outcome === 'refused') {
      const at = Object.keys(run.nodeStatus).find((nodeId) => run.nodeStatus[nodeId] === 'refused') ?? '';
      refusals.set(at, (refusals.get(at) ?? 0) + 1);
    }
    if (sample.outcome === 'failed') {
      const reason = failureOf(run);
      failures.set(reason, (failures.get(reason) ?? 0) + 1);
    }
    if (sample.reachedPipeline) {
      const seen = new Set<string>();
      for (const phase of run.phases) {
        const cost = phase.costUsd ?? 0;
        const entry = phaseTotals.get(phase.phase) ?? { label: phase.label, usd: 0, runs: 0, agents: new Set<string>() };
        entry.usd += cost;
        if (phase.agent !== undefined) entry.agents.add(phase.agent);
        if (!seen.has(phase.phase)) entry.runs += 1;
        seen.add(phase.phase);
        phaseTotals.set(phase.phase, entry);
        if (phase.agent !== undefined && cost > 0) agentTotals.set(phase.agent, (agentTotals.get(phase.agent) ?? 0) + cost);
      }
    }

    const done = index + 1;
    if (done % BATCH === 0 || done === samples) {
      options.onProgress?.(done, samples);
      // A macrotask between batches, so a forecast started from the UI never holds the main thread for long.
      if (done < samples) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  options.signal?.throwIfAborted();

  const piped = runs.filter((run) => run.reachedPipeline);
  const pipedCosts = sorted(piped.map((run) => run.costUsd));
  const cost = pipedCosts.length === 0 ? null : stats(pipedCosts);
  const pipedTotal = sum(piped.map((run) => run.costUsd));
  const otherTotal = sum(piped.map((run) => run.otherUsd));
  const durations = sorted(piped.map((run) => run.durationMs));

  const phases: PhaseShare[] = [...phaseTotals.entries()]
    .filter(([, entry]) => entry.usd > 0)
    .sort(([a], [b]) => phaseRank(a) - phaseRank(b))
    .map(([phase, entry]) => ({
      phase,
      label: entry.label,
      agents: [...entry.agents],
      meanUsd: entry.usd / piped.length,
      share: pipedTotal === 0 ? 0 : entry.usd / pipedTotal,
      frequency: entry.runs / piped.length,
    }));
  if (otherTotal > 0.005 * piped.length) {
    phases.push({ phase: 'OTHER', label: 'Steps outside the pipeline', agents: [], meanUsd: otherTotal / piped.length, share: otherTotal / pipedTotal, frequency: piped.filter((run) => run.otherUsd > 0).length / piped.length });
  }
  const agentSpend = sum([...agentTotals.values()]);
  const agents: AgentShare[] = [...agentTotals.entries()]
    .map(([agent, usd]) => ({ agent, meanUsd: usd / Math.max(1, piped.length), share: agentSpend === 0 ? 0 : usd / agentSpend }))
    .sort((a, b) => b.share - a.share);

  const count = (outcome: ForecastSample['outcome']) => runs.filter((run) => run.outcome === outcome).length / samples;
  const outcomes: ForecastOutcomes = {
    delivered: count('delivered'),
    pullRequests: runs.filter((run) => run.outcome === 'delivered' && run.pullRequest).length / samples,
    otherPath: count('other-path'),
    refused: count('refused'),
    failed: count('failed'),
    waiting: count('waiting'),
    refusedBy: [...refusals.entries()]
      .map(([nodeId, n]) => {
        const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
        return { nodeId, gate: GATE_KINDS[node?.data.typeId ?? ''] ?? 'other', label: node === undefined ? 'A guardrail' : nodeTitle(node), rate: n / samples };
      })
      .sort((a, b) => b.rate - a.rate),
    failedBy: [...failures.entries()].map(([reason, n]) => ({ reason, label: FAILURE_LABELS[reason], rate: n / samples })).sort((a, b) => b.rate - a.rate),
  };

  const dailyCapUsd = gateNumber(workflow, 'maxDailyCostUsd');
  const basis: ForecastBasis = { runs, dailyCapUsd, reserveUsd: gateNumber(workflow, 'maxRunCostUsd') ?? 0, seed };
  const core: ForecastCore = {
    status: piped.length === 0 ? 'unreached' : 'ok',
    samples,
    seed,
    unattended,
    meanCostPerTicketUsd: sum(runs.map((run) => run.costUsd)) / samples,
    cost,
    histogram: histogram(pipedCosts),
    outcomes,
    duration: durations.length === 0 ? null : { p50Ms: quantile(durations, 0.5), p90Ms: quantile(durations, 0.9) },
    phases,
    agents,
    budget: budgetOf(workflow, unattended, copy, piped, failures.get('run-cap') ?? 0, cost),
    basis,
  };
  return finalize(core, options.ticketsPerWeek);
}

/**
 * The same forecast at another volume, from the runs already simulated. Cheap
 * enough to call on every change of a slider.
 */
export function reprojectForecast(forecast: Forecast, ticketsPerWeek: number): Forecast {
  if (clampTickets(ticketsPerWeek) === forecast.projection.ticketsPerWeek) return forecast;
  return finalize(forecast, ticketsPerWeek);
}

/**
 * What decides a forecast: the graph and every setting, but not where nodes
 * sit, the name or the repository. Two workflows with the same key forecast
 * the same numbers, so a UI can cache by it.
 */
export function forecastKey(workflow: Workflow): string {
  return JSON.stringify([workflow.id, workflow.nodes.map((node) => [node.id, node.data.typeId, node.data.config]), workflow.edges.map((edge) => [edge.source, edge.sourceHandle ?? null, edge.target, edge.targetHandle ?? null])]);
}

/** Dollars as a forecast shows them: cents below $100, whole dollars above. */
export function formatForecastUsd(value: number): string {
  if (Math.abs(value) < 100) return formatUsd(value);
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

/* ------------------------------------------------------------------ */
/* The simulated copy                                                  */
/* ------------------------------------------------------------------ */

/**
 * The workflow as the forecast simulates it. Two budget settings are modelled
 * differently from a single test run, because a forecast has to be right
 * about many runs rather than plausible about one:
 *
 * - The daily ceiling. A test run stands in for "spent today" with a random
 *   draw that knows nothing about volume. The forecast models the day itself
 *   (see `project`), so the copy never refuses on the day.
 * - The per-run ceiling. An unattended run carries the gate's per-run maximum
 *   into the engine, which stops the run at the first phase boundary past it
 *   (`applyUnattendedPolicy` in the CLI), whereas a test run only checks the
 *   gate's estimate before starting. The copy gives the pipeline that stop.
 */
function forecastCopy(workflow: Workflow, unattended: boolean): Workflow {
  const gateRunCap = gateNumber(workflow, 'maxRunCostUsd');
  const nodes = workflow.nodes.map((node) => {
    if (node.data.typeId === BUDGET_GATE && finite(configOf(node)['maxDailyCostUsd']) !== null) {
      return withConfig(node, { maxDailyCostUsd: UNCAPPED });
    }
    if (unattended && gateRunCap !== null && PIPELINE_TYPES.has(node.data.typeId)) {
      const own = finite(configOf(node)['maxCostUsd']);
      return withConfig(node, { maxCostUsd: own === null ? gateRunCap : Math.min(own, gateRunCap) });
    }
    return node;
  });
  return { ...workflow, nodes };
}

function toSample(run: Run, gateIds: string[]): ForecastSample {
  const pipelineUsd = sum(run.phases.map((phase) => phase.costUsd ?? 0));
  const reachedPipeline = run.phases.length > 0;
  const outcome: ForecastSample['outcome'] =
    run.status === 'refused' ? 'refused' : run.status === 'failed' || run.status === 'cancelled' ? 'failed' : run.status === 'waiting' ? 'waiting' : reachedPipeline ? 'delivered' : 'other-path';
  return {
    costUsd: run.costUsd,
    otherUsd: Math.max(0, round2(run.costUsd - pipelineUsd)),
    reachedPipeline,
    outcome,
    pullRequest: outcome === 'delivered' && run.prUrl !== undefined,
    gated: gateIds.some((id) => run.nodeStatus[id] === 'done'),
    durationMs: run.finishedAt === undefined ? 0 : Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt)),
  };
}

/** Why a run that reached the pipeline did not finish. The budget stop is the only failed `cost` event the simulator emits. */
function failureOf(run: Run): FailureKind {
  if (run.events.some((event) => event.kind === 'cost' && event.status === 'failed')) return 'run-cap';
  if (run.tests?.passed === false) return 'tests';
  return 'other';
}

const FAILURE_LABELS: Record<FailureKind, string> = {
  tests: 'Tests failed',
  'run-cap': 'Stopped at the per-run cap',
  other: 'Failed',
};

/* ------------------------------------------------------------------ */
/* Budget                                                              */
/* ------------------------------------------------------------------ */

type DailyCapBase = Omit<DailyCapForecast, 'ticketsPerDay' | 'hitDayRate' | 'refusedRate'>;
/** The budget before a volume is chosen: everything but the daily ceiling's volume-dependent half. */
type BudgetBase = Omit<ForecastBudget, 'dailyCap'> & { dailyCap: DailyCapBase | null };

function budgetOf(workflow: Workflow, unattended: boolean, copy: Workflow, piped: ForecastSample[], stoppedAtCap: number, cost: CostStats | null): BudgetBase | null {
  const gate = workflow.nodes.find((node) => node.data.typeId === BUDGET_GATE);
  const gateRunCap = gateNumber(workflow, 'maxRunCostUsd');
  const gateDaily = gateNumber(workflow, 'maxDailyCostUsd');
  const confirmAbove = gateNumber(workflow, 'confirmAboveUsd');
  const pipeline = workflow.nodes.find((node) => PIPELINE_TYPES.has(node.data.typeId));
  const ownCap = pipeline === undefined ? null : finite(configOf(pipeline)['maxCostUsd']);
  // The ceiling the simulated runs were actually held to, after `forecastCopy` folded in the gate's.
  const simulated = copy.nodes.find((node) => PIPELINE_TYPES.has(node.data.typeId));
  const enforcedCap = simulated === undefined ? null : finite(configOf(simulated)['maxCostUsd']);

  let runCap: RunCapForecast | null = null;
  if (enforcedCap !== null) {
    runCap = { usd: enforcedCap, source: ownCap !== null && ownCap <= enforcedCap ? 'pipeline' : 'budget-gate', enforcedInRun: true, hitRate: piped.length === 0 ? 0 : stoppedAtCap / piped.length };
  } else if (gateRunCap !== null) {
    runCap = { usd: gateRunCap, source: 'budget-gate', enforcedInRun: false, hitRate: piped.length === 0 ? 0 : piped.filter((run) => run.costUsd > gateRunCap).length / piped.length };
  }

  const reserve = gateRunCap ?? 0;
  const fit = (usd: number | undefined) => (usd === undefined || gateDaily === null ? null : gateDaily < reserve ? 0 : Math.floor((gateDaily - reserve) / Math.max(0.01, usd) + 1e-9) + 1);
  const dailyCap = gateDaily === null ? null : { usd: gateDaily, reserveUsd: reserve, runsPerDayAtP50: fit(cost?.p50), runsPerDayAtP90: fit(cost?.p90) };
  const confirm = confirmAbove === null ? null : { usd: confirmAbove, applies: !unattended, wouldAsk: cost !== null && cost.p50 > confirmAbove };

  if (gate === undefined && runCap === null) return null;
  return { gateNodeId: gate?.id ?? null, runCap, dailyCap, confirm };
}

/* ------------------------------------------------------------------ */
/* Volume                                                              */
/* ------------------------------------------------------------------ */

type ForecastCore = Omit<Forecast, 'projection' | 'notes' | 'budget'> & { budget: BudgetBase | null };

function finalize(core: ForecastCore, ticketsPerWeek: number): Forecast {
  const { projection, hitDayRate, refusedRate } = project(core.basis, ticketsPerWeek);
  const budget: ForecastBudget | null =
    core.budget === null
      ? null
      : {
          ...core.budget,
          dailyCap: core.budget.dailyCap === null ? null : { ...core.budget.dailyCap, ticketsPerDay: projection.ticketsPerWeek / WORKING_DAYS_PER_WEEK, hitDayRate, refusedRate },
        };
  const forecast: Forecast = { ...core, budget, projection, notes: [] };
  forecast.notes = notesFor(forecast);
  return forecast;
}

/**
 * Weeks and months resampled from the simulated runs. Each ticket is a run
 * drawn at random and lands on a random working day; within a day, runs start
 * one after another, and with a daily ceiling a run starts only if what the
 * day has spent plus the per-run ceiling fits under it — the rule
 * `relay serve` applies (`budgetAllows`), which holds back the full per-run
 * ceiling because a run cannot be un-started. A refused run is refused, never
 * queued for tomorrow.
 */
function project(basis: ForecastBasis, ticketsPerWeek: number): { projection: ForecastProjection; hitDayRate: number; refusedRate: number } {
  const perWeek = clampTickets(ticketsPerWeek);
  const perMonth = Math.round(perWeek * WEEKS_PER_MONTH);
  const zero = { p50: 0, p90: 0, mean: 0 };
  const empty: ForecastProjection = { ticketsPerWeek: perWeek, ticketsPerMonth: perMonth, trials: 0, weekly: zero, monthly: zero, daily: { p50: 0, p90: 0, max: 0 }, pullRequestsPerMonth: 0, refusedByDailyCapPerMonth: 0 };
  if (basis.runs.length === 0 || perWeek === 0) return { projection: empty, hitDayRate: 0, refusedRate: 0 };

  // Streams of their own, the same for every volume, so a new volume redraws as little as it can.
  const weekRng = mulberry32(mix32(basis.seed ^ 0x9e3779b9));
  const monthRng = mulberry32(mix32(basis.seed ^ 0x7f4a7c15));
  const weekDays = WORKING_DAYS_PER_WEEK;
  const monthDays = Math.round(WORKING_DAYS_PER_WEEK * WEEKS_PER_MONTH);
  const weekly = new Float64Array(FORECAST_TRIALS);
  const days = new Float64Array(FORECAST_TRIALS * weekDays);
  let daysHit = 0;
  let refusedInWeeks = 0;
  for (let trial = 0; trial < FORECAST_TRIALS; trial += 1) {
    const period = simulatePeriod(basis, weekRng, perWeek, weekDays);
    weekly[trial] = period.spend;
    days.set(period.daySpend, trial * weekDays);
    daysHit += period.daysHit;
    refusedInWeeks += period.refused;
  }
  const monthly = new Float64Array(FORECAST_TRIALS);
  let prs = 0;
  let refusedInMonths = 0;
  for (let trial = 0; trial < FORECAST_TRIALS; trial += 1) {
    const period = simulatePeriod(basis, monthRng, perMonth, monthDays);
    monthly[trial] = period.spend;
    prs += period.pullRequests;
    refusedInMonths += period.refused;
  }
  weekly.sort();
  monthly.sort();
  days.sort();

  return {
    projection: {
      ticketsPerWeek: perWeek,
      ticketsPerMonth: perMonth,
      trials: FORECAST_TRIALS,
      weekly: { p50: quantile(weekly, 0.5), p90: quantile(weekly, 0.9), mean: mean(weekly) },
      monthly: { p50: quantile(monthly, 0.5), p90: quantile(monthly, 0.9), mean: mean(monthly) },
      daily: { p50: quantile(days, 0.5), p90: quantile(days, 0.9), max: days[days.length - 1] ?? 0 },
      pullRequestsPerMonth: prs / FORECAST_TRIALS,
      refusedByDailyCapPerMonth: refusedInMonths / FORECAST_TRIALS,
    },
    hitDayRate: daysHit / (FORECAST_TRIALS * weekDays),
    refusedRate: refusedInWeeks / (FORECAST_TRIALS * perWeek),
  };
}

function simulatePeriod(basis: ForecastBasis, rng: () => number, tickets: number, dayCount: number) {
  const daySpend = new Float64Array(dayCount);
  const hit = new Uint8Array(dayCount);
  const cap = basis.dailyCapUsd;
  let refused = 0;
  let pullRequests = 0;
  for (let ticket = 0; ticket < tickets; ticket += 1) {
    const run = basis.runs[Math.floor(rng() * basis.runs.length)]!;
    const day = Math.floor(rng() * dayCount);
    if (cap !== null && run.gated && daySpend[day]! + basis.reserveUsd > cap + 1e-9) {
      daySpend[day]! += run.otherUsd;
      hit[day] = 1;
      refused += 1;
      continue;
    }
    daySpend[day]! += run.costUsd;
    if (run.pullRequest) pullRequests += 1;
  }
  let spend = 0;
  let daysHit = 0;
  for (let day = 0; day < dayCount; day += 1) {
    spend += daySpend[day]!;
    daysHit += hit[day]!;
  }
  return { spend, daySpend, daysHit, refused, pullRequests };
}

/* ------------------------------------------------------------------ */
/* Notes                                                               */
/* ------------------------------------------------------------------ */

const REFUSED_BY: Record<GateKind, string> = {
  budget: 'refused by the budget gate',
  allowlist: 'refused by the allowlist',
  approval: 'rejected at the approval step',
  'kill-switch': 'refused by the kill switch',
  other: 'refused by a guardrail',
};

function notesFor(forecast: Forecast): string[] {
  const { status, cost, outcomes, projection, budget } = forecast;
  if (status === 'no-trigger') return ['This workflow has no trigger, so nothing ever starts it. Add one and the forecast fills in.'];
  if (status === 'no-pipeline') return ['This workflow never runs the agent pipeline, so no coding agent spends anything and there is nothing to forecast.'];
  if (status === 'unreached' || cost === null) {
    const top = outcomes.refusedBy[0];
    if (top !== undefined) return [`None of ${forecast.samples} simulated runs reached the agents: ${percent(top.rate)} were ${REFUSED_BY[top.gate]}${top.gate === 'kill-switch' ? ', which is switched off' : ''}.`];
    return [`None of ${forecast.samples} simulated runs reached the agents. Check that the pipeline is connected to the trigger.`];
  }

  const notes: string[] = [];
  const perWeek = projection.ticketsPerWeek;
  notes.push(`A typical run costs ${usd(cost.p50)}, and 9 in 10 cost under ${usd(cost.p90)}; the most expensive of ${forecast.samples} simulated came to ${usd(cost.max)}.`);
  // Nothing to project when the budget gate refuses every run; the budget note below says why.
  if (perWeek > 0 && projection.monthly.p90 > 0) {
    const prs = Math.round(projection.pullRequestsPerMonth);
    notes.push(
      `At ${perWeek} ${perWeek === 1 ? 'ticket' : 'tickets'} a week, expect about ${usd(projection.monthly.p50)} a month, and more than ${usd(projection.monthly.p90)} only 1 month in 10` +
        (prs > 0 ? `, for about ${prs} pull ${prs === 1 ? 'request' : 'requests'}.` : '.'),
    );
  }

  const daily = budget?.dailyCap ?? null;
  if (daily !== null && daily.reserveUsd > daily.usd) {
    notes.push(`Your ${formatCeilingUsd(daily.reserveUsd)} per-run cap is above the ${formatCeilingUsd(daily.usd)}/day cap, so the budget gate refuses every run: the first run of a day could pass the day's budget. The CLI refuses this config too.`);
  } else if (daily !== null && perWeek > 0) {
    if (daily.hitDayRate >= 0.005) {
      notes.push(`At ${perWeek} ${perWeek === 1 ? 'ticket' : 'tickets'} a week your ${formatCeilingUsd(daily.usd)}/day cap is hit ${describeHitDays(daily.hitDayRate)}: runs after that are refused, never queued (${percent(daily.refusedRate)} of tickets).`);
    } else if (daily.runsPerDayAtP50 !== null && daily.runsPerDayAtP90 !== null) {
      notes.push(
        `Your ${formatCeilingUsd(daily.usd)}/day cap fits about ${daily.runsPerDayAtP50} typical runs a day, or ${daily.runsPerDayAtP90} expensive ones` +
          (daily.reserveUsd > 0 ? `, because the gate holds back the full ${formatCeilingUsd(daily.reserveUsd)} per-run cap before each start` : '') +
          `. At ${round1(daily.ticketsPerDay)} ${daily.ticketsPerDay === 1 ? 'ticket' : 'tickets'} a working day it is ${daily.hitDayRate === 0 ? 'never' : 'almost never'} hit.`,
      );
    }
  } else if (forecast.unattended && daily === null && perWeek > 0) {
    notes.push(`Nothing caps a day's spend: no budget gate sets a daily maximum. At this volume 9 in 10 working days cost under ${usd(projection.daily.p90)}, and the busiest simulated day ${usd(projection.daily.max)}.`);
  }

  const runCap = budget?.runCap ?? null;
  if (runCap !== null) {
    if (runCap.enforcedInRun) {
      notes.push(
        runCap.hitRate > 0
          ? `${percentCap(runCap.hitRate)} of runs pass your ${formatCeilingUsd(runCap.usd)} per-run cap and are stopped at the next phase boundary: work so far stays on the branch, no pull request.`
          : `No simulated run reached your ${formatCeilingUsd(runCap.usd)} per-run cap.`,
      );
    } else if (runCap.hitRate > 0) {
      notes.push(`${percentCap(runCap.hitRate)} of runs cost more than the budget gate's ${formatCeilingUsd(runCap.usd)} per run. Started by hand, the gate only checks the estimate before starting; set "Stop this run above" on the pipeline to stop them mid-run.`);
    }
  }

  const outcomeParts: string[] = [];
  if (outcomes.pullRequests > 0) outcomeParts.push(`${percent(outcomes.pullRequests)} of tickets end in a pull request`);
  else if (outcomes.delivered > 0) outcomeParts.push(`${percent(outcomes.delivered)} of tickets end in a finished change`);
  const tests = outcomes.failedBy.find((failure) => failure.reason === 'tests');
  if (tests !== undefined) outcomeParts.push(`${percent(tests.rate)} fail their tests and leave the diff on its branch`);
  for (const refusal of outcomes.refusedBy) if (refusal.rate >= 0.01) outcomeParts.push(`${percent(refusal.rate)} are ${REFUSED_BY[refusal.gate]} before any agent starts`);
  if (outcomes.otherPath >= 0.01) outcomeParts.push(`${percent(outcomes.otherPath)} take another path and never start the agents`);
  if (outcomeParts.length > 0) notes.push(`${sentence(outcomeParts)}.`);

  const top = forecast.phases.filter((phase) => phase.phase !== 'OTHER').sort((a, b) => b.share - a.share)[0];
  const reviews = sum(forecast.phases.filter((phase) => phase.phase.startsWith('REVIEWING_')).map((phase) => phase.share));
  if (top !== undefined) {
    notes.push(`${top.label}${top.agents.length === 0 ? '' : ` (${top.agents.join(', ')})`} is ${percent(top.share)} of the spend` + (reviews > 0 ? `; plan and code review together are ${percent(reviews)}.` : '.'));
  }
  if (forecast.agents.length > 1) {
    notes.push(`By agent: ${forecast.agents.map((agent) => `${agent.agent} ${percent(agent.share)}`).join(', ')}. On a subscription that is usage against each plan, not an extra bill.`);
  }

  const confirm = budget?.confirm ?? null;
  if (confirm !== null && confirm.applies && confirm.wouldAsk) {
    notes.push(`A typical run is above your ${formatCeilingUsd(confirm.usd)} "ask before starting" threshold, so every run of this shape will ask first.`);
  } else if (confirm !== null && !confirm.applies && cost.p90 > confirm.usd) {
    notes.push(`"Ask before starting above ${formatCeilingUsd(confirm.usd)}" does not apply to unattended runs: there is nobody to ask, so the per-run cap is the ceiling.`);
  }

  if (forecast.duration !== null) {
    notes.push(`A run takes about ${formatRunMinutes(forecast.duration.p50Ms)} from trigger to finish, and 9 in 10 are done within ${formatRunMinutes(forecast.duration.p90Ms)}.`);
  }
  return notes;
}

/** How often a daily cap is hit, from the share of working days it refuses a run on: "on about 2 of 5 working days". */
export function describeHitDays(rate: number): string {
  const perWeek = rate * WORKING_DAYS_PER_WEEK;
  if (perWeek >= 4.5) return 'on nearly every working day';
  if (perWeek >= 0.75) return `on about ${Math.round(perWeek)} of ${WORKING_DAYS_PER_WEEK} working days`;
  return `on about 1 working day in ${Math.round(1 / rate)}`;
}

function sentence(parts: string[]): string {
  const [first, ...rest] = parts;
  const head = first === undefined ? '' : first.charAt(0).toUpperCase() + first.slice(1);
  if (rest.length === 0) return head;
  return `${head}; ${rest.join('; ')}`;
}

function percent(rate: number): string {
  if (rate > 0 && rate < 0.005) return 'under 1%';
  if (rate < 1 && rate > 0.995) return 'over 99%';
  return `${Math.round(rate * 100)}%`;
}

/** Like `percent`, but capitalised for the start of a sentence. */
function percentCap(rate: number): string {
  const text = percent(rate);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "20 min", "1 h 5 min". */
export function formatRunMinutes(ms: number): string {
  const total = Math.max(1, Math.round(ms / 60_000));
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

const usd = formatForecastUsd;

/** A ceiling somebody typed: "$40", or "$2.50" when it has cents. */
export function formatCeilingUsd(value: number): string {
  return Number.isInteger(value) ? `$${value.toLocaleString('en-US')}` : formatUsd(value);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function emptyForecast(status: 'no-trigger' | 'no-pipeline', seed: number, unattended: boolean, ticketsPerWeek: number): Forecast {
  const outcomes: ForecastOutcomes = { delivered: 0, pullRequests: 0, otherPath: 0, refused: 0, failed: 0, waiting: 0, refusedBy: [], failedBy: [] };
  const core: ForecastCore = {
    status,
    samples: 0,
    seed,
    unattended,
    meanCostPerTicketUsd: 0,
    cost: null,
    histogram: [],
    outcomes,
    duration: null,
    phases: [],
    agents: [],
    budget: null,
    basis: { runs: [], dailyCapUsd: null, reserveUsd: 0, seed },
  };
  return finalize(core, ticketsPerWeek);
}

/** Bins on round edges ($0.25, $0.50, $1…) covering every value, about `HISTOGRAM_BINS` of them. */
function histogram(values: Float64Array): HistogramBin[] {
  if (values.length === 0) return [];
  const min = values[0]!;
  const max = values[values.length - 1]!;
  const { step, start, count } = binning(min, Math.max(max, min + 0.5));
  const bins: HistogramBin[] = Array.from({ length: count }, (_, index) => ({ fromUsd: edge(start + index * step), toUsd: edge(start + (index + 1) * step), count: 0, share: 0 }));
  for (const value of values) {
    const index = Math.min(count - 1, Math.max(0, Math.floor((value - start) / step + 1e-9)));
    bins[index]!.count += 1;
  }
  for (const bin of bins) bin.share = bin.count / values.length;
  return bins;
}

/** Of the round steps near the ideal width, the one whose bin count lands closest to `HISTOGRAM_BINS`. */
function binning(min: number, max: number): { step: number; start: number; count: number } {
  const magnitude = 10 ** Math.floor(Math.log10((max - min) / HISTOGRAM_BINS));
  let best: { step: number; start: number; count: number } | null = null;
  for (const factor of [0.5, 1, 2, 2.5, 5, 10, 20]) {
    const step = factor * magnitude;
    const start = Math.floor(min / step + 1e-9) * step;
    const count = Math.max(1, Math.floor((max - start) / step + 1e-9) + 1);
    if (best === null || Math.abs(count - HISTOGRAM_BINS) < Math.abs(best.count - HISTOGRAM_BINS)) best = { step, start, count };
  }
  return best!;
}

function edge(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function stats(values: Float64Array): CostStats {
  return {
    count: values.length,
    min: values[0] ?? 0,
    p10: quantile(values, 0.1),
    p50: quantile(values, 0.5),
    p90: quantile(values, 0.9),
    max: values[values.length - 1] ?? 0,
    mean: mean(values),
  };
}

/** Linear interpolation between order statistics, on values sorted ascending. */
function quantile(values: Float64Array, q: number): number {
  if (values.length === 0) return 0;
  const position = (values.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return values[low]! + (values[high]! - values[low]!) * (position - low);
}

function sorted(values: number[]): Float64Array {
  return Float64Array.from(values).sort();
}

function mean(values: Float64Array): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampTickets(value: number): number {
  return Number.isFinite(value) ? Math.min(10_000, Math.max(0, Math.round(value))) : 0;
}

function phaseRank(phase: string): number {
  const index = PHASE_ORDER.indexOf(phase);
  return index === -1 ? PHASE_ORDER.length : index;
}

/** A node's settings as the simulator sees them: the catalog defaults under what was set. */
function configOf(node: WorkflowNode): Record<string, unknown> {
  const def = getNodeType(node.data.typeId);
  return { ...(def === undefined ? {} : defaultConfig(def)), ...node.data.config };
}

function withConfig(node: WorkflowNode, patch: Record<string, unknown>): WorkflowNode {
  return { ...node, data: { ...node.data, config: { ...node.data.config, ...patch } } };
}

/** A number setting on the first budget gate, the one the compiler exports; null when unset. */
function gateNumber(workflow: Workflow, key: 'maxRunCostUsd' | 'maxDailyCostUsd' | 'confirmAboveUsd'): number | null {
  const gate = workflow.nodes.find((node) => node.data.typeId === BUDGET_GATE);
  return gate === undefined ? null : finite(configOf(gate)[key]);
}

function finite(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nodeTitle(node: WorkflowNode): string {
  return node.data.label ?? getNodeType(node.data.typeId)?.name ?? 'A guardrail';
}

/**
 * The default seed comes from the workflow's id alone, not its contents or
 * `updatedAt` as a test run's does: dragging a node or renaming the workflow
 * must not reshuffle the forecast, and changing a setting should move the
 * numbers by what the setting does rather than by a fresh draw.
 */
function defaultSeed(workflow: Workflow): number {
  let h = 2166136261;
  for (let i = 0; i < workflow.id.length; i += 1) {
    h ^= workflow.id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return mix32(h >>> 0);
}

/** Each sample gets its own well-mixed seed, so neighbouring samples are unrelated runs. */
function sampleSeed(seed: number, index: number): number {
  return mix32((seed + Math.imul(index + 1, 0x9e3779b9)) >>> 0);
}

/** murmur3's finaliser: every input bit reaches every output bit. */
function mix32(value: number): number {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The same generator the simulator uses, for the resampling. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
