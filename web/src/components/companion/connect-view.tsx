'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { ArrowRight, CircleAlert, FileCode2, KeyRound, Play, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { readPairingFragment, useCompanion } from '@/lib/companion/client';
import { useAgentsStore } from '@/hooks/use-agent-accounts';
import { useBrand } from '@/hooks/use-brand';
import { MachineCard } from './machine-card';

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

  const connected = status === 'connected' && pairing.state !== 'pairing';

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 pb-16 md:p-6">
      <div className="mx-auto grid w-full max-w-3xl gap-6">
        <PageHeader
          title={connected ? 'Your machine is connected' : 'Connect your machine'}
          description={`${brand.name} draws, checks and compiles workflows here in the browser. The coding agents, their sign-ins and your repository are on your computer, and relay connect is the door between the two.`}
        />

        {pairing.state === 'pairing' ? (
          <Card>
            <CardContent className="flex items-center gap-2 text-sm">
              <Spinner /> Pairing with the companion on this machine…
            </CardContent>
          </Card>
        ) : null}

        {pairing.state === 'failed' ? (
          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-destructive">
                <CircleAlert className="size-4" /> Could not pair
              </CardTitle>
              <CardDescription className="text-pretty">{pairing.error}</CardDescription>
            </CardHeader>
            <CardContent className="grid justify-items-start gap-3 text-sm text-muted-foreground">
              <p className="text-pretty">
                Check that <span className="font-mono text-foreground">relay connect</span> is still running. If your browser asked whether this site may look for apps on your device, allow it — that is the companion — and try again.
              </p>
              <Button variant="outline" size="sm" onClick={() => void pair(pairing.port, pairing.token).then(() => refreshAgents(), () => undefined)}>
                <RotateCcw data-icon="inline-start" /> Try again
              </Button>
            </CardContent>
          </Card>
        ) : null}

        {pairing.state !== 'pairing' ? <MachineCard /> : null}

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

function Next({ icon: Icon, title, body, href }: { icon: typeof Play; title: string; body: string; href: string }) {
  return (
    <Link href={href} className="group grid gap-1 rounded-lg border p-3 transition-colors hover:bg-muted/50">
      <span className="flex items-center gap-1.5 text-sm font-medium">
        <Icon className="size-3.5 text-muted-foreground" aria-hidden /> {title}
      </span>
      <span className="text-xs text-pretty text-muted-foreground">{body}</span>
      <span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary">
        Go <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
      </span>
    </Link>
  );
}
