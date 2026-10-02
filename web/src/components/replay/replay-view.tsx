'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, CircleDollarSign, Clock3, GitPullRequest, Pause, Play, RotateCcw, Ticket, Video } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PhaseList } from '@/components/runs/phase-list';
import { RunTimeline } from '@/components/runs/run-timeline';
import { openPhase } from '@/components/runs/run-utils';
import { GraphView } from '@/components/templates/graph-view';
import { usePageTitle } from '@/hooks/use-page-title';
import { formatUsd } from '@/lib/format';
import { foldRecording, patchTimes, phaseEndTimes, replaySteps, taskTitle, workflowForRecording } from '@/lib/replay/fold';
import type { Recording } from '@/lib/replay/types';
import { cn } from '@/lib/utils';
import { formatMs } from '@/lib/workflow/simulate';
import { PatchView } from './patch-view';
import { ReceiptsPanel } from './receipts-panel';
import { ReviewsPanel } from './reviews-panel';

/** How long the replay rests on each stop while it plays. A run of twenty minutes plays in about as many seconds. */
const STEP_MS = 1400;

interface Outcome {
  label: string;
  detail: string;
  tone: string;
}

/** What the run's exit code means, in the engine's own terms (docs/cli.md, "Exit codes"). */
function outcomeOf(recording: Recording): Outcome {
  switch (recording.exitCode) {
    case 0:
      return { label: 'Passed', detail: 'The run finished, its checks passed, and its work was delivered.', tone: 'border-success/40 text-success' };
    case 5:
      return { label: 'Checks failed', detail: 'The run finished, and its own verdict is no: the tests failed, or blocking findings were never resolved.', tone: 'border-destructive/40 text-destructive' };
    case 4:
      return { label: 'Not committed', detail: 'The run finished, and its work is committed nowhere.', tone: 'border-warning/50 text-amber-600 dark:text-warning' };
    case 130:
      return { label: 'Stopped', detail: recording.run.stopped ?? 'The run was stopped before it finished.', tone: 'border-border text-muted-foreground' };
    default:
      return { label: 'Failed', detail: recording.run.error ?? 'The run broke before it could reach a verdict.', tone: 'border-destructive/40 text-destructive' };
  }
}

function dayOf(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function clockOf(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * A recording, played back: the run on the canvas at any moment of it, with
 * what it had produced by then — the receipts, both debates, the diff, the
 * plan and the test log. Everything shown was recorded by the run; nothing is
 * simulated, and nothing here can start, stop or change a run.
 */
export function ReplayView({ recording }: { recording: Recording }) {
  const workflow = useMemo(() => workflowForRecording(recording), [recording]);
  const steps = useMemo(() => replaySteps(recording), [recording]);
  const last = steps.length - 1;
  // Opens on the finished run, so the page is never empty; Play starts it over.
  const [index, setIndex] = useState(last);
  const [wanted, setPlaying] = useState(false);
  const step = steps[Math.min(index, last)]!;
  const atEnd = index >= last;
  // Playing stops by itself at the end: there is nothing further to play.
  const playing = wanted && !atEnd;
  usePageTitle(`Recording: ${taskTitle(recording)}`);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setIndex((current) => Math.min(last, current + 1)), STEP_MS);
    return () => window.clearInterval(timer);
  }, [playing, last]);

  const run = useMemo(() => foldRecording(recording, step.count, workflow), [recording, step.count, workflow]);
  const current = openPhase(run);
  const graphRun = useMemo(() => ({ nodeStatus: run.nodeStatus, running: run.status === 'running', ...(current === null ? {} : { phase: current }) }), [run, current]);

  // What the run had produced by this moment. At the end, everything: a delivery redone later is still part of the record.
  const reached = (at: string | null | undefined): boolean => atEnd || (at != null && at <= step.at);
  const receiptsShown = atEnd ? recording.receipts.length : recording.receipts.filter((receipt) => reached(receipt.at)).length;
  const reviews = recording.artifacts.reviews.filter((review) => reached(review.at));
  const times = useMemo(() => patchTimes(recording), [recording]);
  const patches = recording.artifacts.patches.filter((patch) => reached(times[patch.label]));
  const ends = useMemo(() => phaseEndTimes(recording), [recording]);

  const { run: recorded } = recording;
  const outcome = outcomeOf(recording);
  const repository = recorded.repository.owner !== null && recorded.repository.name !== null ? `${recorded.repository.owner}/${recorded.repository.name}` : null;
  const disagreements = recording.receipts.filter((receipt) => receipt.verdict === 'mismatch').length;

  const play = () => {
    if (atEnd) setIndex(0);
    setPlaying(true);
  };

  return (
    <div className="container flex flex-1 flex-col gap-6 py-8">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="secondary" className="gap-1">
            <Video className="size-3" aria-hidden /> Recording of a real run
          </Badge>
          {repository === null ? null : <span className="font-mono text-xs">{repository}</span>}
          <span aria-hidden>·</span>
          <span>{dayOf(recorded.createdAt)}</span>
        </div>
        <h1 className="max-w-4xl text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{taskTitle(recording)}</h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <span className={cn('rounded-full border px-2.5 py-0.5 text-xs font-medium', outcome.tone)} title={outcome.detail}>
            {outcome.label} · exit {recording.exitCode}
          </span>
          {recorded.issue !== null && recorded.issue.url.length > 0 ? (
            <a href={recorded.issue.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
              <Ticket className="size-3.5 text-muted-foreground" aria-hidden /> Issue #{recorded.issue.number} <ArrowUpRight className="size-3" aria-hidden />
            </a>
          ) : null}
          {recorded.pullRequest === null ? null : (
            <a href={recorded.pullRequest.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline">
              <GitPullRequest className="size-3.5 text-muted-foreground" aria-hidden /> Pull request #{recorded.pullRequest.number ?? ''} <ArrowUpRight className="size-3" aria-hidden />
            </a>
          )}
          {recorded.durationMs === null ? null : (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Clock3 className="size-3.5" aria-hidden /> {formatMs(recorded.durationMs)}
            </span>
          )}
          <span className="inline-flex items-center gap-1 text-muted-foreground" title={recorded.turns !== null && recorded.pricedTurns !== null && recorded.pricedTurns < recorded.turns ? `${recorded.turns - recorded.pricedTurns} of ${recorded.turns} turns reported no price, so this is a floor.` : undefined}>
            <CircleDollarSign className="size-3.5" aria-hidden /> {recorded.costUsd === null ? 'no price reported' : `${formatUsd(recorded.costUsd)} reported`}
          </span>
        </div>
        <p className="max-w-3xl text-sm text-pretty text-muted-foreground">{outcome.detail}</p>
      </header>

      <section aria-label="Playback" className="flex flex-col gap-3 rounded-2xl border bg-card p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-3">
          {playing ? (
            <Button size="sm" variant="outline" onClick={() => setPlaying(false)}>
              <Pause data-icon="inline-start" className="fill-current" /> Pause
            </Button>
          ) : (
            <Button size="sm" onClick={play}>
              {atEnd ? <RotateCcw data-icon="inline-start" /> : <Play data-icon="inline-start" className="fill-current" />} {atEnd ? 'Play from the start' : 'Play'}
            </Button>
          )}
          <p className="min-w-0 text-sm" aria-live="polite">
            <span className="font-medium">{step.label}</span>
            <span className="text-muted-foreground tabular-nums">
              {' '}
              · {formatMs(step.offsetMs)} in · {clockOf(step.at)}
            </span>
          </p>
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            stop {Math.min(index, last) + 1} of {steps.length}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={Math.min(index, last)}
          onChange={(event) => {
            setPlaying(false);
            setIndex(Number(event.target.value));
          }}
          aria-label="Position in the run"
          aria-valuetext={`${step.label}, ${formatMs(step.offsetMs)} in`}
          className="w-full cursor-pointer accent-foreground"
        />
        <ol className="flex flex-wrap gap-1.5" aria-label="The run, phase by phase">
          {steps.map((stop, position) => (
            <li key={stop.count}>
              <button
                type="button"
                onClick={() => {
                  setPlaying(false);
                  setIndex(position);
                }}
                aria-current={position === index ? 'step' : undefined}
                className={cn(
                  'rounded-full border px-2.5 py-0.5 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                  position === index ? 'border-foreground bg-foreground text-background' : position < index ? 'bg-muted text-foreground hover:bg-muted/70' : 'text-muted-foreground hover:bg-muted',
                )}
              >
                {stop.label}
              </button>
            </li>
          ))}
        </ol>
        <GraphView workflow={workflow} run={graphRun} className="h-56 rounded-xl sm:h-64" />
      </section>

      <div className="grid items-start gap-6 lg:grid-cols-5">
        <Tabs defaultValue="receipts" className="min-w-0 lg:col-span-3">
          <TabsList className="h-9 w-full justify-start overflow-x-auto">
            <TabsTrigger value="receipts">
              Receipts
              {disagreements > 0 && atEnd ? <span className="rounded-full bg-destructive px-1.5 text-[10px] font-semibold text-white">{disagreements}</span> : null}
            </TabsTrigger>
            <TabsTrigger value="reviews">Reviews</TabsTrigger>
            <TabsTrigger value="diff">Diff</TabsTrigger>
            <TabsTrigger value="plan">Plan</TabsTrigger>
            <TabsTrigger value="tests">Tests</TabsTrigger>
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
          </TabsList>
          <TabsContent value="receipts" className="pt-2">
            <ReceiptsPanel receipts={recording.receipts} shown={receiptsShown} />
          </TabsContent>
          <TabsContent value="reviews" className="pt-2">
            <ReviewsPanel reviews={reviews} agents={recorded.agents} />
          </TabsContent>
          <TabsContent value="diff" className="pt-2">
            <PatchView patches={patches} omitted={recording.cleaned.patchesOmitted} />
          </TabsContent>
          <TabsContent value="plan" className="pt-2">
            <Prose text={reached(ends.plan) ? recording.artifacts.plan : null} empty="No plan has been written yet at this point in the run." note="The plan as the run left it. Each revision overwrites the one before, so an earlier point in the run shows the final plan too." />
          </TabsContent>
          <TabsContent value="tests" className="pt-2">
            <Prose text={reached(ends.tests) ? recording.artifacts.testLog : null} empty={ends.tests === null ? 'This run never reached its tests.' : 'The tests have not run yet at this point in the run.'} note="The end of what the project’s own test command printed. Relay judges it by exit code." mono />
          </TabsContent>
          <TabsContent value="timeline" className="pt-2">
            <Card>
              <CardContent>
                <RunTimeline run={run} workflow={workflow} />
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <aside className="flex min-w-0 flex-col gap-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Pipeline phases</CardTitle>
              <CardDescription>Where the time and money went, agent by agent, as the run recorded it. Costs are known once the run has finished.</CardDescription>
            </CardHeader>
            {run.phases.length > 0 || current !== null ? (
              <CardContent>
                <PhaseList phases={run.phases} current={current} />
              </CardContent>
            ) : null}
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>About this recording</CardTitle>
              <CardDescription className="text-pretty">
                Written by <span className="font-mono text-xs">relay recording</span> {recording.relayVersion} on {dayOf(recording.exportedAt)}, from the files run <span className="font-mono text-xs">{recorded.shortId}</span> left on disk. The phases and their times are the run’s own; the engine’s spoken commentary is not kept, so what plays back is each phase, its closing note, the test result and the delivery steps.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
              <p>
                Cleaned on the way out: {recording.cleaned.paths} {recording.cleaned.paths === 1 ? 'path' : 'paths'} on the machine replaced with placeholders, {recording.cleaned.secrets} credential-shaped {recording.cleaned.secrets === 1 ? 'string' : 'strings'} redacted
                {recording.cleaned.patchesOmitted ? ', and the patches left out' : ''}.
              </p>
              <p>
                Make one of your own run with <span className="font-mono text-xs">relay recording</span>, then{' '}
                <Link href="/r" className="font-medium text-foreground underline underline-offset-4">
                  open it here
                </Link>
                .
              </p>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function Prose({ text, empty, note, mono = false }: { text: string | null; empty: string; note: string; mono?: boolean }) {
  if (text === null || text.trim().length === 0) return <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">{note}</p>
      <pre className={cn('max-h-[40rem] overflow-auto rounded-xl border bg-card p-4 text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]', mono ? 'font-mono text-[11px]' : 'font-sans')}>{text}</pre>
    </div>
  );
}
