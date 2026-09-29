'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { ArrowRight, CircleAlert, Cloud, FileCode2, KeyRound, Play, RotateCcw, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { readPairingFragment, useCompanion, type PairingFailure } from '@/lib/companion/client';
import { DEFAULT_COMPANION_PORT } from '@/lib/companion/types';
import { useAccount, useCapabilities } from '@/lib/cloud/account';
import { useAgentsStore } from '@/hooks/use-agent-accounts';
import { useBrand } from '@/hooks/use-brand';
import { CopyButton } from '@/components/runs/copy-button';
import { AllowAccessNotice, BlockedAccessHelp } from './browser-access';
import { RunnerStatus } from './runner-compare';
import { CONNECT_COMMAND, MachineCard } from './machine-card';

/**
 * Where `relay connect`'s link lands. The port and the token ride in the
 * fragment, which the browser never sends anywhere; they are read once, taken
 * out of the address bar and the history, checked against the companion, and
 * only then kept.
 */
export function ConnectView() {
  const brand = useBrand();
  const hydrated = useCompanion((state) => state.hydrated);
  const status = useCompanion((state) => state.status);
  const pair = useCompanion((state) => state.pair);
  const refreshAgents = useAgentsStore((state) => state.refresh);
  const pairing = useCompanion((state) => state.attempt);
  const asking = useCompanion((state) => state.access === 'prompt');
  const handled = useRef(false);

  useEffect(() => {
    if (!hydrated || handled.current) return;
    handled.current = true;
    const found = readPairingFragment(window.location.hash);
    if (window.location.hash.length > 0) window.history.replaceState(null, '', window.location.pathname);
    if (found === null) return;
    // The store records how it went; this page only renders it.
    pair(found.port, found.token).then(
      () => void refreshAgents(),
      () => undefined,
    );
  }, [hydrated, pair, refreshAgents]);

  // `status` follows the target, so a connected cloud machine would otherwise
  // make this page claim the computer is paired.
  const paired = useCompanion((state) => state.pairing);
  const connected = status === 'connected' && paired !== null && pairing.state !== 'pairing';

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 pb-16 md:p-6">
      <div className="mx-auto grid w-full max-w-3xl gap-6">
        <PageHeader
          title={connected ? 'Your machine is connected' : 'Connect your machine'}
          description={`${brand.name} draws, checks and compiles workflows here in the browser. The coding agents, their sign-ins and your repository are on your computer, and relay connect is the door between the two. Relay Cloud does the same job on a machine Relay runs for you; the card at the bottom compares them.`}
        />

        {pairing.state === 'pairing' ? (
          <Card>
            <CardContent className="grid gap-3">
              <p className="flex items-center gap-2 text-sm">
                <Spinner /> Pairing with relay connect on 127.0.0.1:{pairing.port}…
              </p>
              {asking ? <AllowAccessNotice /> : null}
            </CardContent>
          </Card>
        ) : null}

        {pairing.state === 'failed' ? (
          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-destructive">
                <CircleAlert className="size-4" /> {FAILURE_TITLE[pairing.reason]}
              </CardTitle>
              <CardDescription className="text-pretty">{pairing.error}</CardDescription>
            </CardHeader>
            <CardContent className="grid justify-items-start gap-3 text-sm text-muted-foreground">
              <FailureHelp reason={pairing.reason} port={pairing.port} />
              <Button variant="outline" size="sm" onClick={() => void pair(pairing.port, pairing.token).then(() => refreshAgents(), () => undefined)}>
                <RotateCcw data-icon="inline-start" /> Try again
              </Button>
            </CardContent>
          </Card>
        ) : null}

        {pairing.state !== 'pairing' ? <MachineCard /> : null}

        {pairing.state !== 'pairing' ? <NotThisComputer /> : null}

        {connected ? (
          <Card>
            <CardHeader>
              <CardTitle>What you can do now</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-3">
              <Next icon={KeyRound} title="Sign in your agents" body="Claude Code and Codex sign in with your own plans, from the browser." href="/settings#agents" />
              <Next icon={Play} title="Run a workflow for real" body="In the builder, open the menu next to Test run and pick Run on this machine." href="/workflows" />
              <Next icon={FileCode2} title="Install an export" body="Export writes the config and the Action straight into your repository." href="/workflows" />
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

const FAILURE_TITLE: Record<PairingFailure, string> = {
  blocked: 'Your browser blocked the connection',
  dismissed: 'Allow the connection to pair',
  unreachable: 'relay connect did not answer',
  rejected: 'This pairing link is out of date',
};

/**
 * The other answer, next to the one this page is about: the same run, on a
 * machine Relay runs for you. Without it, pairing looks like the only way.
 */
function NotThisComputer() {
  const hub = useCompanion((state) => state.cloudHub);
  const signedIn = useAccount((state) => state.status === 'signed-in');
  const accounts = useCapabilities().enabled;
  const target = useCompanion((state) => state.target);
  const status = useCompanion((state) => state.status);
  const cloud = useCompanion((state) => state.cloud);
  // `status` belongs to the current target and `cloud` keeps its last value, so
  // "runs go to the cloud" needs both to agree — opening a pairing link switches
  // the target to the computer and leaves the cloud's awake state behind.
  const inUse = target === 'cloud' && status === 'connected' && cloud?.state === 'ready';
  const offered = hub !== null && accounts;

  return (
    <Card className="border-dashed">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Cloud className="size-4 text-muted-foreground" aria-hidden />
          Not on this computer?
          {offered ? (
            <span className="ml-auto">
              <RunnerStatus target="cloud" />
            </span>
          ) : null}
        </CardTitle>
        <CardDescription className="text-pretty">
          {!offered
            ? 'Relay Cloud is the same thing on a machine Relay runs for you, with nothing to install. This deployment has no hub behind it, so your own computer is the runner here.'
            : inUse
              ? 'Your cloud machine is awake, and it is where sign-ins and runs currently go. Pairing your computer as well does no harm: you can switch between the two at any time.'
              : 'Relay Cloud is a Linux machine of your own that Relay makes for you, wakes when you run something and sleeps when it is idle. Nothing to install and no terminal: you name the repository on each run instead.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <Button size="sm" nativeButton={false} render={<Link href="/runners" />}>
          Compare the two
          <ArrowRight data-icon="inline-end" />
        </Button>
        {offered && !signedIn ? (
          <Button size="sm" variant="ghost" nativeButton={false} render={<Link href="/sign-up?next=/runners" />}>
            <UserPlus data-icon="inline-start" /> Create an account for it
          </Button>
        ) : null}
        {offered && signedIn ? (
          <Button size="sm" variant="ghost" nativeButton={false} render={<Link href="/settings#machine" />}>
            <Cloud data-icon="inline-start" /> Use Relay Cloud
          </Button>
        ) : null}
        <p className="text-xs text-pretty text-muted-foreground">Your plans and your sign-ins are used the same way either way.</p>
      </CardContent>
    </Card>
  );
}

function FailureHelp({ reason, port }: { reason: PairingFailure; port: number }) {
  if (reason === 'blocked') return <BlockedAccessHelp className="text-foreground" />;
  if (reason === 'dismissed') {
    return <p className="text-pretty">Press Try again, and choose Allow when your browser asks whether this site may reach apps on your device. That is relay connect, on this computer only.</p>;
  }
  if (reason === 'rejected') {
    return <p className="text-pretty">It was started with a new token since this link was made. Open the newest link in its terminal, or stop it and run relay connect again.</p>;
  }
  const command = port === DEFAULT_COMPANION_PORT ? CONNECT_COMMAND : `${CONNECT_COMMAND} --port ${port}`;
  const here = typeof window === 'undefined' ? null : window.location.origin;
  return (
    <ul className="grid list-disc gap-1.5 pl-4 text-pretty">
      <li>
        Is it still running? Start it again in your repository:{' '}
        <span className="inline-flex items-center gap-1 rounded border bg-muted/40 pl-1.5 font-mono text-xs text-foreground">
          {command}
          <CopyButton value={command} label={`Copy: ${command}`} />
        </span>
      </li>
      <li>If its terminal printed a newer link, open that one: the port may have changed.</li>
      <li>If your browser asks whether this site may reach apps on your device, choose Allow.</li>
      {here === null ? null : (
        <li>
          If its terminal says <span className="font-mono text-foreground">Refused {here}</span>, it was started for another studio: run it with <span className="font-mono text-foreground">--studio {here}</span>.
        </li>
      )}
    </ul>
  );
}

function Next({ icon: Icon, title, body, href }: { icon: typeof Play; title: string; body: string; href: string }) {
  return (
    <Link href={href} className="group grid gap-1 rounded-lg border p-3 transition-colors hover:bg-muted/50">
      <span className="flex items-center gap-1.5 text-sm font-medium">
        <Icon className="size-3.5 text-muted-foreground" aria-hidden /> {title}
      </span>
      <span className="text-xs text-pretty text-muted-foreground">{body}</span>
      <span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-signal">
        Go <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
      </span>
    </Link>
  );
}
