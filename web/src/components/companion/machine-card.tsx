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
import { useCompanion, type CompanionStatus } from '@/lib/companion/client';
import { repositoryLabel } from '@/lib/companion/types';
import { useAgentsStore } from '@/hooks/use-agent-accounts';
import { useNow } from '@/hooks/use-now';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';

export const INSTALL_COMMAND = 'npm install -g github:aydinmrnv/relay';
export const CONNECT_COMMAND = 'relay connect';

/** One line on where the studio's machine stands, for badges and the sidebar. */
export function machineStatusText(status: CompanionStatus, host: string | undefined): string {
  switch (status) {
    case 'connected':
      return `Connected to ${host ?? 'your machine'}`;
    case 'connecting':
      return 'Looking for your machine…';
    case 'unreachable':
      return 'Paired, but `relay connect` is not running';
    case 'rejected':
      return 'The machine no longer accepts this pairing';
    default:
      return 'No machine connected';
  }
}

/** The two commands that connect a machine, each with a copy button. */
export function ConnectSteps({ className }: { className?: string }) {
  return (
    <ol className={cn('grid gap-2 text-sm', className)}>
      <Step n={1} text="Install the Relay CLI, once:" command={INSTALL_COMMAND} />
      <Step n={2} text="In the repository your workflows run on, start the companion. It opens this studio with a pairing link:" command={CONNECT_COMMAND} />
    </ol>
  );
}

function Step({ n, text, command }: { n: number; text: string; command: string }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold">{n}</span>
      <div className="grid min-w-0 flex-1 gap-1">
        <span className="text-pretty">{text}</span>
        <span className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 py-1 pr-1 pl-2.5 font-mono text-xs">
          <span className="truncate">{command}</span>
          <CopyButton value={command} label={`Copy: ${command}`} />
        </span>
      </div>
    </li>
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
  const forget = useCompanion((state) => state.forget);
  const refreshAgents = useAgentsStore((state) => state.refresh);
  const now = useNow();
  const [busy, setBusy] = useState(false);

  const connected = status === 'connected';
  const repo = repositoryLabel(hello?.repository);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Laptop className="size-4 text-muted-foreground" aria-hidden />
          {connected ? (hello?.machine ?? 'Your machine') : 'Connect your machine'}
          <Badge
            variant="outline"
            className={cn(
              'text-[10px]',
              connected ? 'border-success/40 bg-success/10 text-success' : status === 'unpaired' ? 'text-muted-foreground' : 'border-warning/40 bg-warning/10 text-amber-700 dark:text-warning',
            )}
          >
            {connected ? 'Connected' : status === 'unpaired' ? 'Not paired' : status === 'connecting' ? 'Checking' : status === 'rejected' ? 'Pairing refused' : 'Not running'}
          </Badge>
        </CardTitle>
        <CardDescription className="text-pretty">
          {connected
            ? `Signs in your coding agents, runs workflows for real and installs exports, through relay connect${checkedAt === null ? '' : ` · checked ${timeAgo(checkedAt, now)}`}.`
            : status === 'unreachable'
              ? `This browser is paired with the companion on port ${pairing?.port ?? '?'}, but nothing answers there. Start it again in your repository with relay connect.`
              : status === 'rejected'
                ? 'The companion is running but refused this browser’s token — it was rotated with --new-token. Open the new link it printed.'
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
        ) : (
          <ConnectSteps />
        )}
      </CardContent>
      <CardFooter className="flex-wrap justify-between gap-2 text-xs text-muted-foreground">
        <span className="text-pretty">It listens on 127.0.0.1 only, answers only this studio, and never sees a token: the CLIs keep their own sign-ins.</span>
        {pairing !== null ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              forget();
              void refreshAgents();
              toast('Forgot this machine', { description: 'Run relay connect and open its link to pair again.' });
            }}
          >
            <Unplug data-icon="inline-start" /> Forget this machine
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
