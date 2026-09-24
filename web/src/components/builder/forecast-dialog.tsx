'use client';

import { useDeferredValue, useEffect, useId, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { BarChart3, CircleCheck, CircleX, Clock, CornerDownRight, Gauge, ShieldAlert, ShieldCheck, Table2, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, type ChartConfig } from '@/components/ui/chart';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Slider } from '@/components/ui/slider';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { HelpTip } from '@/components/app/help-tip';
import { useCalmMotion } from '@/components/motion/use-calm-motion';
import { useBrand } from '@/hooks/use-brand';
import { cn } from '@/lib/utils';
import {
  DEFAULT_FORECAST_SAMPLES,
  DEFAULT_TICKETS_PER_WEEK,
  FORECAST_TRIALS,
  WORKING_DAYS_PER_WEEK,
  describeHitDays,
  forecastKey,
  forecastWorkflow,
  formatCeilingUsd as limit,
  formatForecastUsd as usd,
  formatRunMinutes as minutes,
  reprojectForecast,
  type Forecast,
  type DailyCapForecast,
  type ForecastBudget,
  type ForecastOutcomes,
  type HistogramBin,
  type PhaseShare,
  type RunCapForecast,
} from '@/lib/workflow/forecast';
import type { Workflow } from '@/lib/workflow/schema';

const MIN_TICKETS = 1;
const MAX_TICKETS = 200;

/* ------------------------------------------------------------------ */
/* Computing                                                            */
/* ------------------------------------------------------------------ */

/**
 * Finished forecasts by `forecastKey`, newest last. A key always yields the
 * same forecast, so the side panel and the dialog share one simulation, and
 * reading this during render cannot show anything a fresh run would not.
 */
const finished = new Map<string, Forecast>();
const KEEP = 12;

function remember(key: string, forecast: Forecast) {
  finished.delete(key);
  finished.set(key, forecast);
  for (const oldest of finished.keys()) {
    if (finished.size <= KEEP) break;
    finished.delete(oldest);
  }
}

interface ForecastState {
  /** The forecast for this workflow, or while it recomputes, the last one shown (see `stale`). */
  forecast: Forecast | null;
  stale: boolean;
  computing: boolean;
  progress: { done: number; total: number } | null;
  error: string | null;
}

/**
 * Simulates the workflow in the background whenever what decides its cost
 * changes (not when a node is dragged or the workflow renamed), and keeps
 * the previous forecast on screen meanwhile.
 */
function useWorkflowForecast(workflow: Workflow, enabled: boolean): ForecastState {
  const brand = useBrand();
  const key = useMemo(() => forecastKey(workflow), [workflow]);
  const [latest, setLatest] = useState<{ key: string; forecast: Forecast } | null>(null);
  const [progress, setProgress] = useState<{ key: string; done: number; total: number } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const fresh = latest?.key === key ? latest.forecast : (finished.get(key) ?? null);

  useEffect(() => {
    if (!enabled || fresh !== null) return;
    const controller = new AbortController();
    forecastWorkflow(workflow, {
      brand,
      ticketsPerWeek: DEFAULT_TICKETS_PER_WEEK,
      signal: controller.signal,
      onProgress: (done, total) => setProgress({ key, done, total }),
    }).then(
      (forecast) => {
        remember(key, forecast);
        setLatest({ key, forecast });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setFailure({ key, message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => controller.abort();
  }, [enabled, fresh, key, workflow, brand]);

  const error = failure?.key === key ? failure.message : null;
  return {
    forecast: fresh ?? latest?.forecast ?? null,
    stale: fresh === null && latest !== null,
    computing: enabled && fresh === null && error === null,
    progress: progress?.key === key ? { done: progress.done, total: progress.total } : null,
    error,
  };
}

/* ------------------------------------------------------------------ */
/* The dialog                                                           */
/* ------------------------------------------------------------------ */

interface DialogProps {
  workflow: Workflow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** "What will this cost?" for one workflow: a few hundred simulated runs, projected over the tickets you expect. */
export function ForecastDialog({ workflow, open, onOpenChange }: DialogProps) {
  const [tickets, setTickets] = useState(DEFAULT_TICKETS_PER_WEEK);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-4 sm:max-w-3xl">
        <ForecastPanel workflow={workflow} tickets={tickets} onTicketsChange={setTickets} />
      </DialogContent>
    </Dialog>
  );
}

/** Rendered only while the dialog is open, so nothing is simulated for a closed one. */
function ForecastPanel({ workflow, tickets, onTicketsChange }: { workflow: Workflow; tickets: number; onTicketsChange: (tickets: number) => void }) {
  const { forecast, stale, computing, progress, error } = useWorkflowForecast(workflow, true);
  // The slider stays responsive while the weeks and months are redrawn behind it.
  const volume = useDeferredValue(tickets);
  const view = useMemo(() => (forecast === null ? null : reprojectForecast(forecast, volume)), [forecast, volume]);
  const samples = view?.samples || DEFAULT_FORECAST_SAMPLES;
  const nothingToSimulate = view !== null && view.samples === 0;

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Gauge className="size-4" /> Spend forecast · “{workflow.name}”
          <HelpTip term="cost" />
        </DialogTitle>
        <DialogDescription>
          What this workflow will cost before it runs
          {nothingToSimulate ? '.' : `: ${samples} simulated runs through the same guardrails, review rounds and budgets as a test run, projected over the tickets you expect.`}
        </DialogDescription>
      </DialogHeader>

      <div className="-mx-4 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-1">
        {view === null ? (
          error !== null ? (
            <p className="rounded-lg border border-destructive/40 bg-destructive/8 p-3 text-xs text-destructive">The forecast could not be computed: {error}</p>
          ) : (
            <Simulating progress={progress} className="py-12" />
          )
        ) : view.status === 'no-trigger' || view.status === 'no-pipeline' ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">{view.notes[0]}</div>
        ) : (
          <>
            {/* With no run reaching the agents there is nothing for a volume to multiply. */}
            {view.cost === null ? null : <VolumeControl tickets={tickets} onChange={onTicketsChange} />}
            <div className={cn('flex flex-col gap-5 transition-opacity', (stale || volume !== tickets) && 'opacity-60')} aria-busy={stale || computing}>
              {stale && computing ? <Simulating progress={progress} compact /> : null}
              {view.cost === null ? null : <StatTiles forecast={view} />}
              {view.cost === null ? null : (
                <div className="grid gap-5 md:grid-cols-2">
                  <CostHistogram forecast={view} />
                  <PhaseList phases={view.phases} agents={view.agents} />
                </div>
              )}
              <OutcomeBreakdown outcomes={view.outcomes} dailyCap={view.budget?.dailyCap ?? null} ticketsPerWeek={view.projection.ticketsPerWeek} />
              {view.cost === null ? null : <BudgetCallout forecast={view} />}
              <section aria-labelledby="forecast-notes" className="grid gap-2">
                <h3 id="forecast-notes" className="text-sm font-medium">
                  In plain English
                </h3>
                <ul className="grid gap-1.5 text-sm text-pretty">
                  {view.notes.map((note) => (
                    <li key={note} className="flex gap-2">
                      <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground" />
                      {note}
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          </>
        )}
      </div>

      <DialogFooter showCloseButton className="sm:items-center sm:justify-between">
        <p className="text-xs text-pretty text-muted-foreground">
          {nothingToSimulate
            ? 'A forecast is a simulation built from the same model as test runs. Real runs report what the CLIs actually charged.'
            : `A simulation, built from the same model as test runs: ${samples} seeded runs, resampled into ${FORECAST_TRIALS} weeks and months at your volume, with budgets applied the way the CLI applies them. Real runs report what the CLIs actually charged.`}
        </p>
      </DialogFooter>
    </>
  );
}

function Simulating({ progress, compact = false, className }: { progress: ForecastState['progress']; compact?: boolean; className?: string }) {
  const total = progress?.total ?? DEFAULT_FORECAST_SAMPLES;
  const done = progress?.done ?? 0;
  return (
    <div className={cn('grid gap-2', className)}>
      <p className="text-xs text-muted-foreground tabular-nums">
        {compact ? 'Updating the forecast' : 'Simulating runs'} · {done} of {total}
      </p>
      <Progress value={Math.round((done / Math.max(1, total)) * 100)} aria-label="Simulating runs" />
    </div>
  );
}

function VolumeControl({ tickets, onChange }: { tickets: number; onChange: (tickets: number) => void }) {
  const id = useId();
  const perDay = tickets / WORKING_DAYS_PER_WEEK;
  const perMonth = Math.round((tickets * 52) / 12);
  const set = (value: number) => {
    if (Number.isFinite(value)) onChange(Math.min(MAX_TICKETS, Math.max(MIN_TICKETS, Math.round(value))));
  };
  return (
    <section className="grid gap-2.5 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id} className="text-sm">
          Tickets per week
        </Label>
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={MIN_TICKETS}
          max={MAX_TICKETS}
          value={tickets}
          onChange={(event) => {
            if (event.target.value !== '') set(Number(event.target.value));
          }}
          className="h-7 w-20 text-right tabular-nums"
        />
      </div>
      <Slider
        value={[tickets]}
        min={MIN_TICKETS}
        max={MAX_TICKETS}
        step={1}
        aria-label="Tickets per week"
        onValueChange={(value) => set(typeof value === 'number' ? value : (value[0] ?? tickets))}
      />
      <p className="text-xs text-muted-foreground">
        About {perDay < 10 ? perDay.toFixed(1).replace(/\.0$/, '') : Math.round(perDay)} a working day, {perMonth} a month. Each one starts a run; the budget gate decides whether it goes ahead.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Headline numbers                                                     */
/* ------------------------------------------------------------------ */

function StatTiles({ forecast }: { forecast: Forecast }) {
  const cost = forecast.cost!;
  const { monthly, ticketsPerWeek, pullRequestsPerMonth } = forecast.projection;
  const prShare = forecast.outcomes.pullRequests;
  const tiles = [
    { label: 'Typical run', value: usd(cost.p50), hint: `The median of ${cost.count} runs that reached the agents` },
    { label: '9 in 10 runs cost under', value: usd(cost.p90), hint: `From ${usd(cost.min)} to ${usd(cost.max)} across them all` },
    { label: 'A month', value: `${usd(monthly.p50)}–${usd(monthly.p90)}`, hint: `At ${ticketsPerWeek} a week: a typical month, and 1 month in 10` },
    {
      label: 'Pull requests a month',
      value: `≈ ${Math.round(pullRequestsPerMonth)}`,
      hint: prShare > 0 ? `${percent(prShare)} of tickets end in one` : 'This workflow opens none',
    },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {tiles.map((tile) => (
        <div key={tile.label} className="flex flex-col gap-1.5 rounded-xl bg-card p-3 ring-1 ring-foreground/10">
          <p className="text-xs text-muted-foreground">{tile.label}</p>
          <p className="text-xl font-semibold tracking-tight">{tile.value}</p>
          <p className="text-[11px] leading-snug text-muted-foreground">{tile.hint}</p>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Cost per run                                                         */
/* ------------------------------------------------------------------ */

/**
 * One series, so one hue; bins past an enforced per-run cap wear the warning
 * token instead, because those runs were stopped there. The legend, the
 * tooltip and the table view carry the same distinction for anyone the
 * colour fails.
 */
const HISTOGRAM_CONFIG = {
  within: { label: 'Under the cap', color: 'var(--chart-1)' },
  stopped: { label: 'Stopped at the per-run cap', color: 'var(--warning)' },
} satisfies ChartConfig;

interface BinDatum {
  key: string;
  range: string;
  within: number;
  stopped: number;
  count: number;
  share: number;
}

function binData(bins: HistogramBin[], cap: RunCapForecast | null): BinDatum[] {
  const stopAt = cap !== null && cap.enforcedInRun ? cap.usd : null;
  return bins.map((bin) => {
    const past = stopAt !== null && bin.fromUsd >= stopAt;
    return { key: shortUsd(bin.fromUsd), range: `${usd(bin.fromUsd)}–${usd(bin.toUsd)}`, within: past ? 0 : bin.count, stopped: past ? bin.count : 0, count: bin.count, share: bin.share };
  });
}

function CostHistogram({ forecast }: { forecast: Forecast }) {
  const reduce = useCalmMotion();
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const data = useMemo(() => binData(forecast.histogram, forecast.budget?.runCap ?? null), [forecast.histogram, forecast.budget]);
  const anyStopped = data.some((bin) => bin.stopped > 0);
  const duration = forecast.duration;

  return (
    <section aria-labelledby="forecast-histogram" className="flex min-w-0 flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 id="forecast-histogram" className="text-sm font-medium">
            Cost per run
          </h3>
          <p className="text-xs text-muted-foreground">
            {forecast.cost?.count} runs that reached the agents
            {duration === null ? '' : ` · about ${minutes(duration.p50Ms)} each, 9 in 10 within ${minutes(duration.p90Ms)}`}
          </p>
        </div>
        <ToggleGroup
          value={[view]}
          onValueChange={(next: string[]) => {
            if (next[0] === 'chart' || next[0] === 'table') setView(next[0]);
          }}
          variant="outline"
          size="sm"
          spacing={0}
          aria-label="Show as"
        >
          <ToggleGroupItem value="chart" aria-label="Show as chart">
            <BarChart3 />
          </ToggleGroupItem>
          <ToggleGroupItem value="table" aria-label="Show as table">
            <Table2 />
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {view === 'chart' ? (
        <ChartContainer config={HISTOGRAM_CONFIG} className="aspect-auto h-52 w-full" initialDimension={{ width: 340, height: 208 }}>
          <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -8 }} barCategoryGap={2} accessibilityLayer>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="key" tickLine={false} axisLine={false} tickMargin={6} minTickGap={6} />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={28} />
            <ChartTooltip cursor={{ radius: 4 }} content={<BinTooltip />} />
            {/* A legend only when there are two kinds of bar; one series is named by the heading. Stack order, not alphabetical. */}
            {anyStopped ? <ChartLegend content={<ChartLegendContent />} itemSorter={null} /> : null}
            <Bar dataKey="within" stackId="runs" fill="var(--color-within)" radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={!reduce} />
            <Bar dataKey="stopped" stackId="runs" fill="var(--color-stopped)" radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={!reduce} />
          </BarChart>
        </ChartContainer>
      ) : (
        <div className="max-h-52 overflow-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-3">Cost</TableHead>
                <TableHead className="text-right">Runs</TableHead>
                <TableHead className="pr-3 text-right">Share</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((bin) => (
                <TableRow key={bin.key} className={cn(bin.count === 0 && 'text-muted-foreground')}>
                  <TableCell className="pl-3 tabular-nums">
                    {bin.range}
                    {bin.stopped > 0 ? <span className="text-muted-foreground"> · stopped at the cap</span> : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{bin.count}</TableCell>
                  <TableCell className="pr-3 text-right tabular-nums">{percent(bin.share)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function BinTooltip({ active, payload }: { active?: boolean; payload?: ReadonlyArray<{ payload?: unknown }> }) {
  const datum = payload?.[0]?.payload as BinDatum | undefined;
  if (active !== true || datum === undefined) return null;
  return (
    <div className="grid gap-1 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <p className="font-medium tabular-nums">{datum.range}</p>
      <p className="text-muted-foreground tabular-nums">
        {datum.count} {datum.count === 1 ? 'run' : 'runs'} · {percent(datum.share)}
      </p>
      {datum.stopped > 0 ? <p className="text-muted-foreground">Stopped at the per-run cap</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Where the money goes                                                 */
/* ------------------------------------------------------------------ */

function PhaseList({ phases, agents }: { phases: PhaseShare[]; agents: Forecast['agents'] }) {
  const reduce = useCalmMotion();
  return (
    <section aria-labelledby="forecast-phases" className="flex min-w-0 flex-col gap-3">
      <div>
        <h3 id="forecast-phases" className="flex items-center gap-1.5 text-sm font-medium">
          Where the money goes <HelpTip term="phase" />
        </h3>
        <p className="text-xs text-muted-foreground">Average per run, every review round included</p>
      </div>
      <ul className="flex flex-col gap-2.5">
        {phases.map((phase) => (
          <li key={phase.phase}>
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="min-w-0 truncate">
                <span className="font-medium">{phase.label}</span>
                {phase.agents.length === 0 ? null : <span className="text-muted-foreground"> · {phase.agents.join(', ')}</span>}
              </span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {usd(phase.meanUsd)} · <span className="text-foreground">{percent(phase.share)}</span>
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-primary/10">
              <motion.div
                className="h-full rounded-full bg-primary"
                initial={reduce ? false : { width: 0 }}
                animate={{ width: `${Math.max(2, phase.share * 100)}%` }}
                transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              />
            </div>
            {phase.frequency < 0.95 ? <p className="mt-0.5 text-[11px] text-muted-foreground">Runs in {percent(phase.frequency)} of runs</p> : null}
          </li>
        ))}
      </ul>
      {agents.length > 1 ? (
        <p className="text-xs text-muted-foreground">
          By agent: {agents.map((agent) => `${agent.agent} ${percent(agent.share)}`).join(' · ')}. On a subscription that is usage against each plan.
        </p>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* What becomes of a ticket                                             */
/* ------------------------------------------------------------------ */

/** Outcomes are states, so they wear the status tokens, in the dashboard's stack order (success, warning, destructive, neutral). */
function OutcomeBreakdown({ outcomes, dailyCap, ticketsPerWeek }: { outcomes: ForecastOutcomes; dailyCap: DailyCapForecast | null; ticketsPerWeek: number }) {
  const reduce = useCalmMotion();
  const allPrs = outcomes.delivered > 0 && outcomes.pullRequests >= outcomes.delivered - 1e-9;
  const segments = [
    {
      key: 'delivered',
      label: allPrs ? 'Pull request opened' : 'Change finished',
      rate: outcomes.delivered,
      fill: 'bg-success',
      icon: <CircleCheck className="text-success" />,
      detail: allPrs || outcomes.pullRequests === 0 ? [] : [`${percent(outcomes.pullRequests)} with a pull request`],
    },
    { key: 'refused', label: 'Refused by a guardrail', rate: outcomes.refused, fill: 'bg-warning', icon: <ShieldAlert className="text-amber-600 dark:text-warning" />, detail: outcomes.refusedBy.map((refusal) => `${refusal.label} ${percent(refusal.rate)}`) },
    { key: 'failed', label: 'Did not finish', rate: outcomes.failed, fill: 'bg-destructive', icon: <CircleX className="text-destructive" />, detail: outcomes.failedBy.map((failure) => `${failure.label} ${percent(failure.rate)}`) },
    { key: 'other', label: 'Another path, no agents', rate: outcomes.otherPath, fill: 'bg-muted-foreground/45', icon: <CornerDownRight className="text-muted-foreground" />, detail: [] },
    { key: 'waiting', label: 'Waiting', rate: outcomes.waiting, fill: 'bg-muted-foreground/25', icon: <Clock className="text-muted-foreground" />, detail: [] },
  ].filter((segment) => segment.rate > 0);

  return (
    <section aria-labelledby="forecast-outcomes" className="grid gap-2.5">
      <h3 id="forecast-outcomes" className="flex items-center gap-1.5 text-sm font-medium">
        What becomes of a ticket <HelpTip term="gate" />
      </h3>
      <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full" role="img" aria-label={segments.map((segment) => `${segment.label} ${percent(segment.rate)}`).join(', ')}>
        {segments.map((segment) => (
          <motion.div
            key={segment.key}
            className={cn('h-full min-w-0.5', segment.fill)}
            initial={reduce ? false : { width: 0 }}
            animate={{ width: `${segment.rate * 100}%` }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          />
        ))}
      </div>
      <ul className="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
        {segments.map((segment) => (
          <li key={segment.key} className="flex gap-2 [&>svg]:mt-px [&>svg]:size-3.5 [&>svg]:shrink-0">
            {segment.icon}
            <div className="min-w-0 flex-1">
              <p className="flex justify-between gap-2">
                <span className="font-medium">{segment.label}</span>
                <span className="tabular-nums">{percent(segment.rate)}</span>
              </p>
              {segment.detail.map((line) => (
                <p key={line} className="text-muted-foreground">
                  {line}
                </p>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {/* The bar is one run's odds; the daily cap depends on volume, so it is said separately rather than folded in. */}
      {dailyCap !== null && dailyCap.refusedRate >= 0.005 ? (
        <p className="text-xs text-pretty text-muted-foreground">
          Per run, before the daily cap. At {ticketsPerWeek} a week the {limit(dailyCap.usd)}/day cap also refuses {percent(dailyCap.refusedRate)} of tickets before they start.
        </p>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Budget                                                               */
/* ------------------------------------------------------------------ */

function BudgetCallout({ forecast }: { forecast: Forecast }) {
  const reduce = useCalmMotion();
  const budget: ForecastBudget | null = forecast.budget;
  const daily = budget?.dailyCap ?? null;
  const runCap = budget?.runCap ?? null;
  const { projection } = forecast;
  if (budget === null && !forecast.unattended) return null;

  const dailyImpossible = daily !== null && daily.reserveUsd > daily.usd;
  const dailyHit = daily !== null && (dailyImpossible || daily.hitDayRate >= 0.01);
  const capBites = runCap !== null && runCap.hitRate >= 0.1;
  const unguarded = forecast.unattended && daily === null;
  const warn = dailyHit || capBites || unguarded;
  const ratio = daily === null || daily.usd <= 0 ? 0 : Math.min(1, projection.daily.p90 / daily.usd);

  return (
    <section
      aria-labelledby="forecast-budget"
      className={cn('grid gap-3 rounded-lg border p-3', warn ? 'border-warning/50 bg-warning/10' : 'bg-muted/30')}
    >
      <h3 id="forecast-budget" className="flex items-center gap-1.5 text-sm font-medium [&>svg]:size-4">
        {warn ? <TriangleAlert className="text-amber-600 dark:text-warning" /> : <ShieldCheck className="text-success" />}
        Budget at {projection.ticketsPerWeek} {projection.ticketsPerWeek === 1 ? 'ticket' : 'tickets'} a week
        <HelpTip term="budget" />
      </h3>

      {daily !== null ? (
        <div className="grid gap-1.5">
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="font-medium">Daily cap {limit(daily.usd)}</span>
            <span className="text-muted-foreground tabular-nums">
              9 in 10 working days spend under <span className="text-foreground">{usd(projection.daily.p90)}</span>
            </span>
          </div>
          <div
            className={cn('h-1.5 w-full overflow-hidden rounded-full', dailyHit ? 'bg-destructive/15' : ratio >= 0.75 ? 'bg-warning/20' : 'bg-primary/12')}
            role="meter"
            aria-label="Busy-day spend against the daily cap"
            aria-valuenow={Math.round(projection.daily.p90 * 100) / 100}
            aria-valuemin={0}
            aria-valuemax={daily.usd}
          >
            <motion.div
              className={cn('h-full rounded-full', dailyHit ? 'bg-destructive' : ratio >= 0.75 ? 'bg-warning' : 'bg-primary')}
              initial={reduce ? false : { width: 0 }}
              animate={{ width: `${Math.max(2, ratio * 100)}%` }}
              transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
          <p className="text-xs text-pretty text-muted-foreground">
            {dailyImpossible ? (
              <>The {limit(daily.reserveUsd)} per-run cap is above the daily cap, so the gate refuses every run. Raise the daily cap or lower the per-run one.</>
            ) : (
              <>
                {daily.runsPerDayAtP50 === null ? null : (
                  <>
                    Fits about {daily.runsPerDayAtP50} typical runs a day, or {daily.runsPerDayAtP90} expensive ones
                    {daily.reserveUsd > 0 ? <>: before each start the gate holds back the full {limit(daily.reserveUsd)} per-run cap</> : null}.{' '}
                  </>
                )}
                {daily.hitDayRate >= 0.005 ? (
                  <span className={cn(dailyHit && 'font-medium text-foreground')}>
                    Hit {describeHitDays(daily.hitDayRate)}; runs after that are refused, never queued ({percent(daily.refusedRate)} of tickets).
                  </span>
                ) : (
                  <>Never hit at this volume.</>
                )}
              </>
            )}
          </p>
        </div>
      ) : unguarded ? (
        <p className="text-xs text-pretty">
          No budget gate sets a daily maximum, so nothing stops a busy day. At this volume 9 in 10 working days spend under {usd(projection.daily.p90)}; the busiest simulated day spent{' '}
          {usd(projection.daily.max)}. Add a Budget gate in front of the pipeline.
        </p>
      ) : null}

      {runCap !== null ? (
        <p className="text-xs text-pretty">
          <span className="font-medium">Per-run cap {limit(runCap.usd)}</span>
          <span className="text-muted-foreground">
            {runCap.source === 'budget-gate' ? ' (from the budget gate)' : ' (on the pipeline)'}:{' '}
            {runCap.enforcedInRun
              ? runCap.hitRate > 0
                ? `stops ${percent(runCap.hitRate)} of runs at the next phase boundary. Their work stays on the branch; no pull request opens.`
                : 'no simulated run reached it.'
              : runCap.hitRate > 0
                ? `${percent(runCap.hitRate)} of runs cost more. Started by hand, the gate only checks the estimate before starting; set "Stop this run above" on the pipeline to stop them mid-run.`
                : 'no simulated run cost more.'}
          </span>
        </p>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* The side-panel card                                                  */
/* ------------------------------------------------------------------ */

/** The forecast in two numbers, for the builder's side panel, with the full dialog one click away. */
export function ForecastSummary({ workflow, className }: { workflow: Workflow; className?: string }) {
  const [open, setOpen] = useState(false);
  const { forecast, stale, computing, progress, error } = useWorkflowForecast(workflow, true);
  const cost = forecast?.cost ?? null;
  const runCap = forecast?.budget?.runCap ?? null;
  const warning =
    forecast === null || cost === null
      ? null
      : runCap !== null && runCap.enforcedInRun && runCap.hitRate >= 0.1
        ? `${percent(runCap.hitRate)} of runs stop at the ${limit(runCap.usd)} per-run cap`
        : forecast.unattended && (forecast.budget?.dailyCap ?? null) === null
          ? 'Nothing caps a day’s spend'
          : null;

  return (
    <section className={cn('grid gap-2.5 rounded-lg border p-3', className)} aria-busy={computing}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-semibold">
            <Gauge className="size-3.5" /> Spend forecast <HelpTip term="cost" />
          </p>
          <p className="text-[11px] text-muted-foreground">Simulated before a cent is spent.</p>
        </div>
        <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
          Details
        </Button>
      </div>

      {forecast === null ? (
        error !== null ? (
          <p className="text-xs text-destructive">Could not forecast: {error}</p>
        ) : (
          <Simulating progress={progress} />
        )
      ) : cost === null ? (
        <p className="text-xs text-muted-foreground">{forecast.notes[0]}</p>
      ) : (
        <div className={cn('grid gap-2 transition-opacity', stale && 'opacity-60')}>
          <dl className="grid grid-cols-2 gap-3">
            <div className="grid gap-0.5">
              <dt className="text-[11px] text-muted-foreground">Per run</dt>
              <dd className="text-base font-semibold tracking-tight">{usd(cost.p50)}</dd>
              <dd className="text-[11px] text-muted-foreground">9 in 10 under {usd(cost.p90)}</dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-[11px] text-muted-foreground">A month at {DEFAULT_TICKETS_PER_WEEK}/week</dt>
              <dd className="text-base font-semibold tracking-tight">
                {usd(forecast.projection.monthly.p50)}–{usd(forecast.projection.monthly.p90)}
              </dd>
              <dd className="text-[11px] text-muted-foreground">≈ {Math.round(forecast.projection.pullRequestsPerMonth)} pull requests</dd>
            </div>
          </dl>
          {warning === null ? null : (
            <p className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-warning">
              <TriangleAlert className="mt-px size-3 shrink-0" /> {warning}
            </p>
          )}
        </div>
      )}

      <ForecastDialog workflow={workflow} open={open} onOpenChange={setOpen} />
    </section>
  );
}

/* ------------------------------------------------------------------ */

function percent(rate: number): string {
  if (rate > 0 && rate < 0.005) return '<1%';
  if (rate < 1 && rate > 0.995) return '>99%';
  return `${Math.round(rate * 100)}%`;
}

/** Axis labels: "$2", "$2.5". */
function shortUsd(value: number): string {
  return `$${Number(value.toFixed(2)).toString()}`;
}
