'use client';

import { useState } from 'react';
import { FolderGit2, Laptop, RefreshCw, Unplug } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CopyButton } from '@/components/runs/copy-button';
import { REPO_URL } from '@/components/marketing/primitives';
import { restartCommand, useCompanion, type CompanionStatus } from '@/lib/companion/client';
import { repositoryLabel } from '@/lib/companion/types';
import { CLI_INSTALL_COMMAND } from '@/lib/links';
import { useAgentsStore } from '@/hooks/use-agent-accounts';
import { useNow } from '@/hooks/use-now';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { BlockedAccessHelp } from './browser-access';

/** The prebuilt CLI that CI publishes (`.github/workflows/cli-release.yml`); `github:` installs come out empty on current npm. */
export const INSTALL_COMMAND = CLI_INSTALL_COMMAND;
export const CONNECT_COMMAND = 'relay connect';

/** One line on where the studio's machine stands, for badges and the sidebar. */
export function machineStatusText(status: CompanionStatus, host: string | undefined): string {
  switch (status) {
    case 'connected':
      return `Connected to ${host ?? 'your computer'}`;
    case 'connecting':
      return 'Looking for your computer…';
    case 'unreachable':
      return 'Paired, but relay connect is not running';
    case 'rejected':
      return 'relay connect was started again and needs pairing';
    case 'blocked':
      return 'Your browser is blocking the connection to relay connect';
    default:
      return 'No computer connected';
  }
}

/** The two commands that connect a machine, each with a copy button, and the one question the browser asks. */
export function ConnectSteps({ className }: { className?: string }) {
  return (
    <ol className={cn('grid gap-2 text-sm', className)}>
      <Step n={1} text="Install the Relay CLI, once (Node 22.6 or later):" command={INSTALL_COMMAND} />
      <Step n={2} text="In the repository your workflows run on, start it. It opens this studio and pairs it:" command={CONNECT_COMMAND} />
      <Step n={3} text="If your browser asks whether this site may reach apps on your device, choose Allow. That is relay connect. Safari cannot reach it at all: use Chrome, Edge or Firefox." />
    </ol>
  );
}

function Step({ n, text, command }: { n: number; text: string; command?: string }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold">{n}</span>
      <div className="grid min-w-0 flex-1 gap-1">
        <span className="text-pretty">{text}</span>
        {command === undefined ? null : <CommandLine command={command} />}
      </div>
    </li>
  );
}

function CommandLine({ command }: { command: string }) {
  return (
    <span className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 py-1 pr-1 pl-2.5 font-mono text-xs">
      <span className="truncate" title={command}>
        {command}
      </span>
      <CopyButton value={command} label={`Copy: ${command}`} />
    </span>
  );
}

/**
 * The paired machine: `relay connect` on the user's computer, which is how the
 * studio reaches the coding CLIs and the repository. Settings → This machine.
 */
export function MachineCard() {
  const status = useCompanion((state) => state.status);
  const hello = useCompanion((state) => state.hello);
  const pairing = useCompanion((state) => state.pairing);
  const checkedAt = useCompanion((state) => state.checkedAt);
  const notice = useCompanion((state) => state.notice);
  const forget = useCompanion((state) => state.forget);
  const refreshAgents = useAgentsStore((state) => state.refresh);
  const now = useNow();
  const [busy, setBusy] = useState(false);

  // This card is about the computer, and `status` follows the target: a
  // connected cloud machine is not a paired computer. Settings renders this
  // card even when the cloud is the target, so the pairing is the test.
  const pairingState = useCompanion((state) => state.pairing);
  const connected = status === 'connected' && pairingState !== null;
  const repo = repositoryLabel(hello?.repository);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Laptop className="size-4 text-muted-foreground" aria-hidden />
          {connected ? (hello?.machine ?? 'Your computer') : 'Connect your computer'}
          <Badge
            variant="outline"
            className={cn(
              'text-[10px]',
              connected ? 'border-success/40 bg-success/10 text-success' : status === 'unpaired' ? 'text-muted-foreground' : 'border-warning/40 bg-warning/10 text-amber-700 dark:text-warning',
            )}
          >
            {connected
              ? 'Connected'
              : status === 'unpaired'
                ? 'Not paired'
                : status === 'connecting'
                  ? 'Checking'
                  : status === 'rejected'
                    ? 'Pair again'
                    : status === 'blocked'
                      ? 'Blocked by the browser'
                      : 'Not running'}
          </Badge>
        </CardTitle>
        <CardDescription className="text-pretty">
          {connected
            ? `Signs in your coding agents, runs workflows for real and installs exports, through relay connect${checkedAt === null ? '' : ` · checked ${timeAgo(checkedAt, now)}`}.`
            : status === 'unreachable'
              ? (notice ?? `This browser is paired with ${pairing?.machine ?? 'relay connect'} on port ${pairing?.port ?? '?'}, but nothing answers there. Start relay connect again and open the link it prints: each start pairs afresh.`)
              : status === 'blocked'
                ? `This browser is paired with relay connect on port ${pairing?.port ?? '?'}, but it is not letting this site reach apps on your device.`
                : status === 'rejected'
                  ? (notice ?? 'relay connect is running, but it has been started again since this browser was paired, and every start has its own link. Open the link it printed in its terminal.')
                : 'The Relay CLI is the studio’s hands on your computer. Connect it and the studio can sign in Claude Code and Codex, run a workflow for real in your repository, and install an export there. Test runs stay free and in this browser either way.'}
        </CardDescription>
        {pairing !== null ? (
          <CardAction className="flex gap-1">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Check again"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      await refreshAgents();
                      setBusy(false);
                    }}
                  />
                }
              >
                <RefreshCw className={busy ? 'animate-spin' : ''} />
              </TooltipTrigger>
              <TooltipContent>Check again</TooltipContent>
            </Tooltip>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-3">
        {connected ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Repository</dt>
            <dd className="min-w-0">
              {hello?.repository === null || hello?.repository === undefined ? (
                <span className="text-amber-700 dark:text-warning">None — started outside a repository, so only sign-ins work. Start relay connect inside one to run workflows.</span>
              ) : (
                <span className="flex min-w-0 items-center gap-1.5">
                  <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="font-medium">{repo}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground" title={hello.repository.root}>
                    {hello.repository.root}
                  </span>
                </span>
              )}
            </dd>
            <dt className="text-muted-foreground">Relay</dt>
            <dd>
              <span className="font-mono text-xs">v{hello?.version ?? '?'}</span>
              <span className="text-muted-foreground"> · 127.0.0.1:{pairing?.port}</span>
            </dd>
          </dl>
        ) : status === 'blocked' ? (
          <BlockedAccessHelp />
        ) : pairing !== null && (status === 'unreachable' || status === 'connecting') ? (
          <div className="grid gap-1 text-sm">
            <span className="text-pretty">{pairing.repository === null || pairing.repository === undefined ? 'In the repository your workflows run on, start it again:' : `Start it again in ${repositoryLabel(pairing.repository)}:`}</span>
            <CommandLine command={restartCommand(pairing)} />
          </div>
        ) : (
          <ConnectSteps />
        )}
      </CardContent>
      <CardFooter className="flex-wrap justify-between gap-2 text-xs text-muted-foreground">
        <span className="text-pretty">It listens on 127.0.0.1 only, answers only this studio, and never sends it a token: sign-ins stay on your computer.</span>
        {pairing !== null ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              forget();
              void refreshAgents();
              toast('Forgot this computer', { description: 'Run relay connect and open its link to pair again.' });
            }}
          >
            <Unplug data-icon="inline-start" /> Forget this computer
          </Button>
        ) : (
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="font-medium text-foreground underline-offset-4 hover:underline">
            The CLI on GitHub
          </a>
        )}
      </CardFooter>
    </Card>
  );
}
