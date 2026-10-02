'use client';

import Link from 'next/link';
import { Check, Cloud, Laptop, Lock, Plug, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAgentsStore } from '@/hooks/use-agent-accounts';
import { useAccount, useCapabilities } from '@/lib/cloud/account';
import { useCompanion, type RunnerTarget } from '@/lib/companion/client';
import { SUPPORT_EMAIL } from '@/lib/links';
import { cn } from '@/lib/utils';

/**
 * The one place that answers "your own computer, or Relay Cloud?".
 *
 * Both runners speak the same protocol and reach the same result — the same
 * Claude and ChatGPT plans, the same repository, the same pull request — so
 * every screen that has to name the choice reads its wording from here. The
 * copy is data rather than markup for that reason: the /runners page, the
 * guide's explanation and Settings all say one thing, because they say this
 * thing.
 */

interface RunnerFacts {
  key: RunnerTarget;
  title: string;
  icon: typeof Laptop;
  /** What the title is in running text: "goes to your computer", not "goes to Your computer". */
  subject: string;
  /** The button that picks this runner. Written out, so no product name gets lowercased. */
  use: string;
  /** The one line that says what it is, in the words somebody would use. */
  tagline: string;
  /** What it needs before it can be used at all. */
  needs: string;
  /** Why somebody would pick this one. */
  good: string;
  points: string[];
  /** One cell per row of the comparison table, in ROW_LABELS order. */
  rows: string[];
}

/** Row labels shared by both columns, in the order the table reads. */
const ROW_LABELS = ['Setting up', 'Who starts it', 'When it is there', 'Where your code is', 'Where the sign-ins sit', 'Who holds your code', 'Needs an account', 'What it costs you', 'Limits', 'Local-only work', 'Who can reach it', 'Runs nobody is watching'];

const MACHINE: RunnerFacts = {
  key: 'machine',
  title: 'Your computer',
  subject: 'your computer',
  use: 'Use your computer',
  icon: Laptop,
  tagline: 'relay connect, run in the repository you work on. It answers on 127.0.0.1 and nowhere else.',
  needs: 'Node 22.6 or later and the Relay CLI — nothing else.',
  good: 'Good for macOS and Xcode work, private networks, and anything that needs your own toolchain.',
  points: [
    'The machine you already have: nothing to switch on, no waiting for a machine to start.',
    'Your repository, beside your checkout. Xcode, simulators, local databases and private networks all work.',
    'Free. It is your own hardware and your own electricity.',
    'Relay never registers it: the pairing lives in your browser and your terminal, and nowhere else.',
  ],
  rows: [
    'Install the CLI, then run relay connect inside a repository. It prints a link that pairs this browser.',
    'You, at your keyboard.',
    'While relay connect is running. Close the terminal, or the lid, and there is no runner.',
    'In a worktree beside your own checkout. Your working copy is only read.',
    "In the CLIs' own files on this computer — the Claude and Codex you already signed in to.",
    'Only on your computer. Nothing of yours is copied onto Relay infrastructure.',
    'The studio does. The computer itself needs none: Relay never registers it, or knows it exists.',
    'Nothing but your own hardware. Model usage counts against your Claude and ChatGPT plans.',
    'Whatever your computer can take: each run has its own worktree.',
    'Xcode builds, simulators, local services, private networks, localhost dependencies.',
    '127.0.0.1 only, and only a studio holding the token from your terminal.',
    'Not yet: nothing can reach a computer that is switched off. Exported workflows on GitHub Actions run unattended.',
  ],
};

const CLOUD: RunnerFacts = {
  key: 'cloud',
  title: 'Relay Cloud',
  subject: 'Relay Cloud',
  use: 'Use Relay Cloud',
  icon: Cloud,
  tagline: 'Invite-only beta. A Linux machine of your own that Relay makes for you, wakes when you run something and puts to sleep when it is idle.',
  needs: 'An account and, for now, an invitation. Relay Cloud knows your machine by your sign-in, so there is nothing to copy out.',
  good: 'Good for running from anywhere: another browser, another machine, a laptop that is shut.',
  points: [
    'There when your computer is not. About a minute to wake, and it sleeps by itself after ten idle minutes.',
    'You name the repository on each run. It is checked out once and fetched after that, and the pull request opens as you.',
    'Nothing to install and no terminal: no Azure account, no SSH key, no cloud console.',
    'Nothing in API fees, and nothing billed for the machine during the beta: the agents still use your own plans.',
  ],
  rows: [
    'None. Press Make my machine and it is made for you, in about five minutes the first time.',
    'Relay, when you press Run.',
    'Always. It wakes for a run, sleeps when idle, and keeps every sign-in between runs.',
    'In a worktree on that machine’s disk, from the repository you name on the run. It stays there between runs, and goes with the machine when you remove it.',
    "In the CLIs' own files on that machine, signed in once through the browser and kept. Relay's code has no route that reads them.",
    'On your cloud machine, and nowhere else: one VM per person, holding your checkout and your sign-ins. Relay operates the machine; your code and credentials sit on it until you remove it.',
    'Yes. Relay Cloud verifies your session, so the machine is yours and nobody else’s.',
    'Nothing is billed to you during the beta. No API fees either, as on your own computer: model usage counts against your own plans.',
    'One run at a time, on a small Linux machine. Places are limited during the beta: when every machine in a region is awake, yours waits for room.',
    'The Linux command line and the repository. No Xcode, no local services, no private network.',
    'No public address. It dials out to Relay, and only your own signed-in studio reaches it.',
    'Not yet: waking a machine from an event comes later. Exported workflows on GitHub Actions run unattended.',
  ],
};

const RUNNERS: Record<RunnerTarget, RunnerFacts> = { machine: MACHINE, cloud: CLOUD };

/**
 * What is true of both, so nobody reads the table as the whole picture.
 *
 * Everything here holds on either runner. What is *not* the same — where the
 * sign-ins and the checkout sit — is a row of the table above, not a line here.
 */
const SAME = [
  'Your Claude and ChatGPT subscriptions do the work. No API keys to paste.',
  'The studio never asks you for a model credential, and has no route that reads one.',
  'Runs land in your own repository: a branch, a secret scan, and a pull request for you to merge.',
  'Test runs are free and stay in this browser, whichever runner you pick.',
  'The same guardrails, budgets and refusals — the runner only changes where the agents work.',
];

const PICK = [
  { title: 'Pick your computer if…', body: 'you work on macOS, need Xcode or a private network, or want your code and sign-ins to stay on hardware you own.', icon: Laptop, href: '/connect', cta: 'Connect your computer' },
  { title: 'Pick Relay Cloud if…', body: 'you want to start a run from any browser, keep working while it runs, or never install anything at all.', icon: Cloud, href: '/settings#machine', cta: 'Set up Relay Cloud' },
  { title: 'Pick either if…', body: 'the work is just “open a reviewed pull request”. You can set both up and switch between them; each run remembers where it started.', icon: Plug, href: '/settings#machine', cta: 'Switch in Settings' },
];

/** Cloud states, in the words used on the badges. */
const CLOUD_LABEL: Record<string, string> = {
  ready: 'Awake',
  queued: 'Waiting for room',
  creating: 'Being made',
  starting: 'Starting',
  stopping: 'Going to sleep',
  deleting: 'Being removed',
  asleep: 'Asleep',
  none: 'Not made yet',
  offline: 'Offline',
  failed: 'Could not start',
};

const CLOUD_BUSY = new Set(['queued', 'creating', 'starting', 'stopping', 'deleting']);

/** Why Relay Cloud is not on offer, and what — if anything — a person can do about it. */
const BLOCKED = {
  'no-accounts': 'Not offered here: this studio has no accounts, so there is no way for Relay to know whose machine it would be. Your own computer is the runner here.',
  'no-hub': 'Not offered on this studio. Your own computer is the runner here.',
  'sign-in': 'Sign in first: Relay Cloud knows your machine by your sign-in, which is how it knows it is yours.',
} as const;

/**
 * What each runner is doing right now, in a badge.
 *
 * The store's `status` describes whichever runner is the *target*, and `cloud`
 * keeps its last value after a switch, so neither can be trusted for the other
 * one: read from the target's own fields, and say "Not in use" rather than
 * reporting the other runner's state on a card about this one.
 */
export function RunnerStatus({ target }: { target: RunnerTarget }) {
  const inUse = useCompanion((state) => state.target === target);
  const status = useCompanion((state) => state.status);
  const cloud = useCompanion((state) => state.cloud);
  const hub = useCompanion((state) => state.cloudHub);
  const pairing = useCompanion((state) => state.pairing);
  const signedIn = useAccount((state) => state.status === 'signed-in');

  if (target === 'cloud') {
    if (hub === null) return <Badge variant="outline" className="h-5 text-[10px] text-muted-foreground">Not on this studio</Badge>;
    if (!signedIn) return <Badge variant="outline" className="h-5 text-[10px] text-muted-foreground">Sign in to use</Badge>;
    // Nothing has asked the hub about this machine, so there is nothing true to say yet.
    if (!inUse && cloud === null) return <Badge variant="outline" className="h-5 text-[10px] text-muted-foreground">Not selected</Badge>;
    // Selected, and Relay Cloud has not said anything about the machine: say that, not "Asleep", which is a guess.
    if (cloud === null) {
      return status === 'connecting' ? (
        <Badge variant="outline" className="h-5 gap-1 text-[10px] text-muted-foreground">
          <Spinner className="size-2.5" /> Checking
        </Badge>
      ) : (
        <Badge variant="outline" className="h-5 border-warning/40 bg-warning/10 text-[10px] text-amber-700 dark:text-warning">Not answering</Badge>
      );
    }
    const state = cloud.state;
    if (CLOUD_BUSY.has(state))
      return (
        <Badge variant="outline" className="h-5 gap-1 border-signal/30 bg-signal/5 text-[10px] text-signal">
          <Spinner className="size-2.5" /> {CLOUD_LABEL[state] ?? state}
        </Badge>
      );
    if (state === 'ready') return <Badge variant="outline" className="h-5 border-success/40 bg-success/10 text-[10px] text-success">Awake</Badge>;
    if (state === 'failed') return <Badge variant="outline" className="h-5 border-destructive/40 bg-destructive/10 text-[10px] text-destructive">{CLOUD_LABEL[state]}</Badge>;
    return <Badge variant="outline" className="h-5 text-[10px] text-muted-foreground">{CLOUD_LABEL[state] ?? state}</Badge>;
  }

  // The pairing outlives a switch to the cloud, so it says something about the computer even then.
  if (!inUse && pairing === null) return <Badge variant="outline" className="h-5 text-[10px] text-muted-foreground">Not selected</Badge>;
  if (!inUse) return <Badge variant="outline" className="h-5 text-[10px] text-muted-foreground">Paired, not selected</Badge>;
  if (status === 'connected') return <Badge variant="outline" className="h-5 border-success/40 bg-success/10 text-[10px] text-success">Connected</Badge>;
  if (status === 'connecting')
    return (
      <Badge variant="outline" className="h-5 gap-1 text-[10px] text-muted-foreground">
        <Spinner className="size-2.5" /> Checking
      </Badge>
    );
  if (status === 'blocked') return <Badge variant="outline" className="h-5 border-warning/40 bg-warning/10 text-[10px] text-amber-700 dark:text-warning">Blocked by the browser</Badge>;
  if (status === 'unreachable') return <Badge variant="outline" className="h-5 border-warning/40 bg-warning/10 text-[10px] text-amber-700 dark:text-warning">Not running</Badge>;
  if (status === 'rejected') return <Badge variant="outline" className="h-5 border-destructive/40 bg-destructive/10 text-[10px] text-destructive">Pair again</Badge>;
  return <Badge variant="outline" className="h-5 text-[10px] text-muted-foreground">Not paired</Badge>;
}

/** One runner, as a card: what it is, what it needs, and the button that makes it yours. */
function RunnerCard({ runner }: { runner: RunnerFacts }) {
  const target = useCompanion((state) => state.target);
  const status = useCompanion((state) => state.status);
  const cloud = useCompanion((state) => state.cloud);
  const hub = useCompanion((state) => state.cloudHub);
  const pairing = useCompanion((state) => state.pairing);
  const setTarget = useCompanion((state) => state.setTarget);
  const refreshAgents = useAgentsStore((state) => state.refresh);
  const signedIn = useAccount((state) => state.status === 'signed-in');
  const accounts = useCapabilities().enabled;

  // Only the target's own status is live, so a computer is "working" when it is both paired and answering.
  const machineLive = pairing !== null && status === 'connected';
  const chosen = target === runner.key;
  // Relay Cloud is only offered where this deployment has a hub, and only to somebody the hub can recognise.
  const blocked = runner.key !== 'cloud' ? null : !accounts ? 'no-accounts' : hub === null ? 'no-hub' : !signedIn ? 'sign-in' : null;

  return (
    <Card className={cn('gap-4 overflow-hidden', chosen && 'border-primary/60 ring-1 ring-primary/30')}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <runner.icon className="size-4 text-muted-foreground" aria-hidden />
          {runner.title}
          {chosen ? (
            <Badge className="h-5 gap-1 px-1.5 text-[10px]">
              {/* "Selected", not "In use": it can be the chosen runner and still not be paired or awake, which the badge beside it says. */}
              <Check className="size-3" aria-hidden /> Selected
            </Badge>
          ) : null}
          <span className="ml-auto">
            <RunnerStatus target={runner.key} />
          </span>
        </CardTitle>
        <CardDescription className="text-pretty">{runner.tagline}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <ul className="grid gap-1.5">
          {runner.points.map((point) => (
            <li key={point} className="flex gap-2 text-sm text-pretty">
              <Check className="mt-1 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span>{point}</span>
            </li>
          ))}
        </ul>
        <p className="text-sm text-pretty text-muted-foreground">
          <span className="font-medium text-foreground">{runner.good}</span>
        </p>
        <p className="flex items-start gap-1.5 rounded-lg border border-dashed bg-muted/30 px-2.5 py-2 text-xs text-pretty text-muted-foreground">
          <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {runner.needs}
        </p>
      </CardContent>
      <CardFooter className="flex flex-wrap items-center gap-2">
        {blocked === null ? (
          <Button size="sm" variant={chosen ? 'secondary' : 'default'} disabled={chosen} onClick={() => {
            if (chosen) return;
            setTarget(runner.key);
            void refreshAgents();
          }}>
            {chosen ? 'Sign-ins and runs go here' : runner.use}
          </Button>
        ) : null}
        {runner.key === 'cloud' && blocked === null ? (
          <a href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Relay Cloud access')}`} className="text-xs font-medium text-foreground underline-offset-4 hover:underline">
            Request access
          </a>
        ) : null}
        {runner.key === 'cloud' && blocked === 'sign-in' ? (
          <Button size="sm" nativeButton={false} render={<Link href="/sign-up?next=/runners" />}>
            Create an account
          </Button>
        ) : null}
        {/* `status` is the target's, so this asks the computer's own fields: a machine paired but asleep still needs no instructions. */}
        {runner.key === 'machine' && !machineLive ? (
          <Button size="sm" variant="ghost" nativeButton={false} render={<Link href="/connect" />}>
            How to connect
            <Plug data-icon="inline-start" />
          </Button>
        ) : null}
        {runner.key === 'cloud' && blocked === null && cloud !== null && CLOUD_BUSY.has(cloud.state) ? (
          <p className="flex w-full items-center gap-1.5 text-xs text-muted-foreground">
            <Spinner className="size-3" /> {CLOUD_LABEL[cloud.state] ?? cloud.state}
            {cloud.state === 'creating' ? ', about five minutes the first time.' : cloud.state === 'starting' ? ', about a minute.' : '.'}
          </p>
        ) : null}
        {/* No button when this deployment could not offer the runner at all: a link to a sign-up form that cannot help would be worse than the sentence. */}
        {blocked !== null ? <p className="text-xs text-pretty text-muted-foreground">{BLOCKED[blocked]}</p> : null}
      </CardFooter>
    </Card>
  );
}

/** The two runners, side by side, each with the button that makes it yours. */
export function RunnerCards({ className }: { className?: string }) {
  return (
    <div className={cn('grid items-start gap-4 lg:grid-cols-2', className)}>
      <RunnerCard runner={MACHINE} />
      <RunnerCard runner={CLOUD} />
    </div>
  );
}

/** Line by line: what is the same, what is not, and which one to take. */
export function RunnerComparison({ className }: { className?: string }) {
  return (
    <div className={cn('grid gap-6', className)}>
      <div className="overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead className="w-[28%] pl-4">What differs</TableHead>
              <TableHead className="w-[36%] pl-4">
                <span className="flex items-center gap-1.5">
                  <Laptop className="size-3.5 text-muted-foreground" aria-hidden /> Your computer
                </span>
              </TableHead>
              <TableHead className="pl-4">
                <span className="flex items-center gap-1.5">
                  <Cloud className="size-3.5 text-muted-foreground" aria-hidden /> Relay Cloud
                </span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ROW_LABELS.map((label, index) => (
              <TableRow key={label}>
                <TableCell className="pl-4 align-top text-pretty font-medium whitespace-normal">{label}</TableCell>
                <TableCell className="pl-4 align-top text-pretty whitespace-normal text-muted-foreground">{MACHINE.rows[index]}</TableCell>
                <TableCell className="pl-4 align-top text-pretty whitespace-normal text-muted-foreground">{CLOUD.rows[index]}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="grid content-start gap-2">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <Sparkles className="size-3.5 text-muted-foreground" aria-hidden /> The same either way
          </p>
          <ul className="grid gap-1.5">
            {SAME.map((item) => (
              <li key={item} className="flex gap-2 text-sm text-pretty text-muted-foreground">
                <Check className="mt-1 size-3.5 shrink-0 text-success" aria-hidden />
                <span>{item}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-pretty text-muted-foreground">
            There is a third place, for work that starts by itself: an exported workflow runs on your repository’s own GitHub Actions minutes, on your plan, with no Relay server involved. That is what a label on a GitHub issue starts today.
          </p>
        </div>
        <div className="grid content-start gap-3">
          <p className="text-sm font-medium">So which one?</p>
          {PICK.map((item) => (
            <div key={item.title} className="grid gap-1 border-t pt-3">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <item.icon className="size-3.5 text-muted-foreground" aria-hidden /> {item.title}
              </p>
              <p className="text-sm text-pretty text-muted-foreground">{item.body}</p>
              <Link href={item.href} className="mt-0.5 inline-flex w-fit items-center gap-1 text-xs font-medium text-signal underline-offset-4 hover:underline">
                {item.cta} →
              </Link>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Everything, for the guide and anywhere the choice needs explaining in full. */
export function RunnerCompare({ className }: { className?: string }) {
  return (
    <div className={cn('grid gap-6', className)}>
      <RunnerCards />
      <RunnerComparison />
    </div>
  );
}

/** The quiet version, for a card that is about something else. */
export function RunnerNote({ className }: { className?: string }) {
  const target = useCompanion((state) => state.target);
  const status = useCompanion((state) => state.status);
  const cloud = useCompanion((state) => state.cloud);
  const hub = useCompanion((state) => state.cloudHub);
  const awake = target === 'cloud' ? cloud?.state === 'ready' : status === 'connected';

  return (
    <p className={cn('text-xs text-pretty text-muted-foreground', className)}>
      Sign-ins and runs currently go to <span className="font-medium text-foreground">{RUNNERS[target].title}</span>
      {awake ? ', which is awake' : ''}.{' '}
      <Link href="/runners" className="font-medium text-foreground underline-offset-4 hover:underline">
        Compare the two
      </Link>
      {hub === null ? '. Relay Cloud is not offered on this studio' : '.'}
    </p>
  );
}
