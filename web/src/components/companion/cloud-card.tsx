'use client';

import { useState } from 'react';
import { Cloud, Laptop, Moon, Play, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { ChoiceCards, type Choice } from '@/components/settings/settings-section';
import { useAgentsStore } from '@/hooks/use-agent-accounts';
import { useNow } from '@/hooks/use-now';
import { useAccount } from '@/lib/cloud/account';
import { useCompanion, type CompanionStatus, type RunnerTarget } from '@/lib/companion/client';
import type { CloudRunnerStatus } from '@/lib/companion/types';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Relay Cloud: a machine of the person's own, made and put to sleep by the
 * hub. The studio reaches it through the hub with the person's session; it
 * never has an address of its own, and nobody else's runs touch it.
 */

const REGION_NAMES: Record<string, string> = {
  northcentralus: 'North Central US',
  mexicocentral: 'Mexico Central',
  spaincentral: 'Spain Central',
  belgiumcentral: 'Belgium Central',
  switzerlandnorth: 'Switzerland North',
};

export function regionName(region: string | null): string {
  return region === null ? 'a region with room' : (REGION_NAMES[region] ?? region);
}

/** One line on the cloud machine, for badges, the sidebar and the accounts card. */
export function cloudStatusText(status: CompanionStatus, cloud: CloudRunnerStatus | null): string {
  if (status === 'unpaired') return 'Sign in to use Relay Cloud';
  if (status === 'rejected') return 'Relay Cloud did not accept this session';
  if (cloud === null) return status === 'connecting' ? 'Looking for your cloud machine…' : 'Relay Cloud is not answering';
  switch (cloud.state) {
    case 'ready':
      return 'Your cloud machine is awake';
    case 'none':
      return 'You have no cloud machine yet';
    case 'queued':
      return 'Your cloud machine is waiting for room to start';
    case 'creating':
      return 'Your cloud machine is being made';
    case 'starting':
      return 'Your cloud machine is starting';
    case 'stopping':
      return 'Your cloud machine is going to sleep';
    case 'asleep':
      return 'Your cloud machine is asleep';
    case 'deleting':
      return 'Your cloud machine is being removed';
    case 'offline':
      return 'Your runner is offline';
    default:
      return 'Your cloud machine could not start';
  }
}

function describe(cloud: CloudRunnerStatus | null): string {
  if (cloud === null) return 'Asking Relay Cloud…';
  switch (cloud.state) {
    case 'none':
      return 'Start makes you a Linux machine of your own, with Claude Code, Codex and GitHub’s CLI installed. The first start takes about five minutes; after that, about a minute.';
    case 'queued':
      return `Every machine that is awake in ${regionName(cloud.region)} is in use${cloud.position === null ? '' : `; you are number ${cloud.position} in line`}. It starts as soon as one goes to sleep.`;
    case 'creating':
      return 'Making your machine and installing the coding CLIs. This happens once and takes about five minutes.';
    case 'starting':
      return 'Booting and dialing in. About a minute.';
    case 'ready': {
      const activity = cloud.activity;
      const busy = activity === null ? 0 : activity.runs + activity.queued + activity.logins;
      return busy === 0
        ? 'Awake and idle. It goes to sleep by itself after a few idle minutes, keeping every sign-in.'
        : `Working: ${[activity!.runs > 0 ? `${activity!.runs} run${activity!.runs === 1 ? '' : 's'}` : null, activity!.queued > 0 ? `${activity!.queued} waiting` : null, activity!.logins > 0 ? 'a sign-in' : null].filter(Boolean).join(', ')}.`;
    }
    case 'stopping':
      return 'Going to sleep. A sleeping machine costs nothing but its disk, and keeps every sign-in.';
    case 'asleep':
      return 'Asleep, with every sign-in kept. It wakes when you run something, or when you press Start.';
    case 'deleting':
      return 'Being removed, with its disk and every sign-in on it.';
    case 'offline':
      return 'A runner of your own, started with relay connect --hub, that is not connected right now.';
    default:
      return cloud.error ?? 'Something went wrong starting your machine.';
  }
}

const TONE: Record<string, 'ok' | 'busy' | 'idle' | 'bad'> = {
  ready: 'ok',
  queued: 'busy',
  creating: 'busy',
  starting: 'busy',
  stopping: 'busy',
  deleting: 'busy',
  asleep: 'idle',
  none: 'idle',
  offline: 'idle',
  failed: 'bad',
};

const LABEL: Record<string, string> = {
  ready: 'Awake',
  queued: 'Waiting for room',
  creating: 'Being made',
  starting: 'Starting',
  stopping: 'Going to sleep',
  deleting: 'Removing',
  asleep: 'Asleep',
  none: 'Not made yet',
  offline: 'Offline',
  failed: 'Could not start',
};

/** Where sign-ins and real runs go: this machine through relay connect, or Relay Cloud. */
export function RunnerPicker() {
  const target = useCompanion((state) => state.target);
  const setTarget = useCompanion((state) => state.setTarget);
  const hub = useCompanion((state) => state.cloudHub);
  const signedIn = useAccount((state) => state.status === 'signed-in');
  const refreshAgents = useAgentsStore((state) => state.refresh);

  const options: Array<Choice<RunnerTarget>> = [
    {
      value: 'machine',
      title: 'This machine',
      icon: Laptop,
      description: 'relay connect, in the repository you work on. Your own computer, your own sign-ins.',
    },
    {
      value: 'cloud',
      title: 'Relay Cloud',
      icon: Cloud,
      disabled: hub === null || !signedIn,
      badge: hub === null ? { label: 'Not here', tone: 'muted' } : !signedIn ? { label: 'Sign in', tone: 'muted' } : undefined,
      description:
        hub === null
          ? 'A machine of your own that Relay runs for you. This studio has no hub configured.'
          : 'A machine of your own that Relay runs and puts to sleep when idle. Nothing to install; your plans, your sign-ins.',
    },
  ];

  return (
    <ChoiceCards
      name="runner"
      label="Where agents run"
      value={target}
      onValueChange={(value) => {
        setTarget(value);
        void refreshAgents();
      }}
      options={options}
      className="sm:grid-cols-2"
    />
  );
}

export function CloudCard() {
  const status = useCompanion((state) => state.status);
  const cloud = useCompanion((state) => state.cloud);
  const hello = useCompanion((state) => state.hello);
  const checkedAt = useCompanion((state) => state.checkedAt);
  const cloudAction = useCompanion((state) => state.cloudAction);
  const refreshAgents = useAgentsStore((state) => state.refresh);
  const now = useNow();
  const [busy, setBusy] = useState<'wake' | 'sleep' | 'remove' | 'refresh' | null>(null);
  const [confirming, setConfirming] = useState(false);

  const state = cloud?.state ?? null;
  const tone = state === null ? 'idle' : (TONE[state] ?? 'idle');
  const canWake = state === 'none' || state === 'asleep' || state === 'failed';
  const canSleep = state === 'ready' || state === 'starting' || state === 'creating' || state === 'queued';
  const exists = state !== null && state !== 'none' && state !== 'deleting' && cloud?.managed !== false;

  const act = async (action: 'wake' | 'sleep' | 'remove') => {
    setBusy(action);
    try {
      const next = await cloudAction(action);
      if (next.error !== null && next.state !== 'ready') toast.error(next.error);
      else if (action === 'wake') toast.success(next.state === 'creating' ? 'Making your machine. About five minutes, once.' : next.state === 'queued' ? 'Waiting for room; it starts as soon as there is some.' : 'Starting your machine.');
      else if (action === 'sleep') toast('Putting your machine to sleep.');
      else toast('Removing your machine and its disk.');
      void refreshAgents();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Cloud className="size-4 text-muted-foreground" aria-hidden />
          Your cloud machine
          {state === null ? null : (
            <Badge
              variant="outline"
              className={cn(
                'gap-1 text-[10px]',
                tone === 'ok' && 'border-success/40 bg-success/10 text-success',
                tone === 'busy' && 'border-primary/30 bg-primary/5 text-primary',
                tone === 'bad' && 'border-destructive/40 bg-destructive/10 text-destructive',
                tone === 'idle' && 'text-muted-foreground',
              )}
            >
              {tone === 'busy' ? <Spinner className="size-2.5" /> : null}
              {LABEL[state] ?? state}
            </Badge>
          )}
        </CardTitle>
        <CardDescription className="text-pretty">{status === 'unpaired' || status === 'rejected' ? cloudStatusText(status, cloud) + '.' : describe(cloud)}</CardDescription>
        <CardAction>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Check again"
                  disabled={busy !== null}
                  onClick={async () => {
                    setBusy('refresh');
                    await refreshAgents();
                    setBusy(null);
                  }}
                />
              }
            >
              <RefreshCw className={busy === 'refresh' ? 'animate-spin' : ''} />
            </TooltipTrigger>
            <TooltipContent>Check again</TooltipContent>
          </Tooltip>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3">
        {cloud?.state === 'failed' && cloud.error !== null ? (
          <p className="flex items-start gap-1.5 rounded-lg border border-destructive/40 bg-destructive/8 p-2.5 text-xs text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span className="text-pretty">{cloud.error}</span>
          </p>
        ) : null}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">Where</dt>
          <dd>{cloud?.managed === false ? 'Your own server' : `Azure, ${regionName(cloud?.region ?? null)}`}</dd>
          <dt className="text-muted-foreground">Repositories</dt>
          <dd className="text-pretty">Each run names its GitHub repository; the machine checks it out and opens the pull request as you.</dd>
          {hello?.version !== undefined && state === 'ready' ? (
            <>
              <dt className="text-muted-foreground">Relay</dt>
              <dd className="font-mono text-xs">v{hello.version}</dd>
            </>
          ) : null}
          {checkedAt !== null ? (
            <>
              <dt className="text-muted-foreground">Checked</dt>
              <dd className="text-muted-foreground">{timeAgo(checkedAt, now)}</dd>
            </>
          ) : null}
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!canWake || busy !== null || status === 'unpaired'} onClick={() => void act('wake')}>
            {busy === 'wake' ? <Spinner data-icon="inline-start" /> : <Play data-icon="inline-start" />} {state === 'none' ? 'Make my machine' : 'Start'}
          </Button>
          <Button size="sm" variant="outline" disabled={!canSleep || busy !== null} onClick={() => void act('sleep')}>
            {busy === 'sleep' ? <Spinner data-icon="inline-start" /> : <Moon data-icon="inline-start" />} Put to sleep
          </Button>
          {exists ? (
            <AlertDialog open={confirming} onOpenChange={setConfirming}>
              <AlertDialogTrigger render={<Button size="sm" variant="ghost" className="ml-auto text-destructive hover:text-destructive" disabled={busy !== null} />}>
                <Trash2 data-icon="inline-start" /> Remove…
              </AlertDialogTrigger>
              <AlertDialogContent className="data-[size=default]:sm:max-w-md">
                <AlertDialogHeader>
                  <AlertDialogMedia className="bg-destructive/10 text-destructive">
                    <TriangleAlert />
                  </AlertDialogMedia>
                  <AlertDialogTitle>Remove your cloud machine?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Its disk goes with it: every sign-in on it (Claude, ChatGPT, GitHub) and every checkout. Runs already delivered stay on GitHub. Starting again later makes a fresh machine.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep it</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={() => void act('remove')}>
                    Remove it
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </div>
      </CardContent>
      <CardFooter className="text-xs text-pretty text-muted-foreground">
        It has no public address: it dials out to Relay, and only your signed-in studio reaches it. The CLIs keep their own sign-ins on its disk; Relay never reads them.
      </CardFooter>
    </Card>
  );
}
