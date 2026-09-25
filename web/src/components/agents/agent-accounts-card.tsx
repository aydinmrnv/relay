'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowRight, ExternalLink, KeyRound, LogOut, RefreshCw, Smartphone, TerminalSquare } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { getConnector } from '@/lib/connectors';
import { useAgentsStore, type BridgeState } from '@/hooks/use-agent-accounts';
import { useNow } from '@/hooks/use-now';
import { timeAgo } from '@/lib/format';
import { ACCOUNT_META, AGENT_IDS, AGENT_META, type AccountId, type AgentAccount, type AgentId, type GithubAccount, type LoginMode, type LoginSessionView } from '@/lib/agents/types';
import { useCompanion } from '@/lib/companion/client';
import { machineStatusText } from '@/components/companion/machine-card';
import { cloudStatusText } from '@/components/companion/cloud-card';

const CONNECTOR_FOR: Record<AgentId, string> = { claude: 'claude-code', codex: 'codex-cli' };

/**
 * Sign-in state of the coding CLIs on the runner — the paired machine, or the
 * person's Relay Cloud machine — and buttons that start their own login flows
 * there. The studio never holds a credential: it asks, and it starts the
 * CLI's login.
 */
export function AgentAccountsCard() {
  const bridge = useAgentsStore((state) => state.bridge);
  const status = useAgentsStore((state) => state.status);
  const github = useAgentsStore((state) => state.github);
  const loading = useAgentsStore((state) => state.loading);
  const refresh = useAgentsStore((state) => state.refresh);
  const now = useNow();
  const companion = useCompanion((state) => state.status);
  const cloud = useCompanion((state) => state.target === 'cloud');
  const cloudStatus = useCompanion((state) => state.cloud);
  const withGithub = useCompanion((state) => (state.hello?.capabilities ?? []).includes('github'));
  const host = useCompanion((state) => (state.target === 'cloud' ? 'your cloud machine' : state.hello?.machine));
  const [signing, setSigning] = useState<{ agent: AccountId; mode: LoginMode } | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent accounts</CardTitle>
        <CardDescription>
          {bridge === 'unavailable'
            ? `${cloud ? cloudStatusText(companion, cloudStatus) : machineStatusText(companion, host)}, so the studio cannot ask the CLIs.`
            : status === null
              ? `Asking the CLIs on ${host ?? 'your machine'}…`
              : `Read live from the CLIs on ${host ?? 'your machine'}, ${timeAgo(status.checkedAt, now)}. Rechecked every 30 seconds and when you return to this tab.`}
        </CardDescription>
        <CardAction>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Check sign-in again" onClick={() => void refresh()} disabled={loading} />}>
              <RefreshCw className={loading ? 'animate-spin' : ''} />
            </TooltipTrigger>
            <TooltipContent>Check sign-in again</TooltipContent>
          </Tooltip>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3">
        {bridge === 'unavailable' && cloud ? (
          <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-pretty text-amber-800 dark:text-warning">
            Sign-in goes through your Relay Cloud machine, and it is not awake. Start it under Where agents run, above; it keeps every sign-in while it sleeps.
          </div>
        ) : bridge === 'unavailable' ? (
          <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-pretty text-amber-800 dark:text-warning">
            Sign-in from the browser goes through your machine. Run <span className="font-mono">relay connect</span> in your repository and open the link it prints (see Where agents run, above), or sign in from a terminal with{' '}
            <span className="font-mono">claude auth login</span> and <span className="font-mono">codex login</span>.
          </div>
        ) : null}
        {AGENT_IDS.map((id) => (
          <AgentRow key={id} id={id} account={status?.agents[id] ?? null} bridge={bridge} cloud={cloud} onSignIn={(mode) => setSigning({ agent: id, mode })} />
        ))}
        {withGithub ? <GithubRow account={github} bridge={bridge} onSignIn={() => setSigning({ agent: 'github', mode: 'device' })} /> : null}
      </CardContent>
      <CardFooter className="flex-wrap justify-between gap-2 text-xs text-muted-foreground">
        <span>{cloud ? 'These sign-ins live in the CLIs on your own cloud machine, which nobody else’s runs touch.' : 'These sign-ins live in the CLIs on your machine.'} GitHub Actions needs its own secrets.</span>
        <Link href="/settings#credentials" className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline">
          Credentials for exported workflows <ArrowRight className="size-3" aria-hidden />
        </Link>
      </CardFooter>
      <SignInDialog request={signing} onClose={() => setSigning(null)} />
    </Card>
  );
}

function AgentRow({ id, account, bridge, cloud, onSignIn }: { id: AgentId; account: AgentAccount | null; bridge: BridgeState; cloud: boolean; onSignIn: (mode: LoginMode) => void }) {
  const meta = AGENT_META[id];
  const connector = getConnector(CONNECTOR_FOR[id]);
  const logout = useAgentsStore((state) => state.logout);
  const [busy, setBusy] = useState(false);

  const signedIn = account?.loggedIn === true;
  const installed = account?.installed === true;
  const canStart = bridge === 'available' && installed;
  // ChatGPT's browser sign-in returns to localhost on the machine running Codex,
  // which a cloud machine's browser-less owner cannot reach: there, the device code is the way.
  const primary: LoginMode = cloud && id === 'codex' ? 'device' : 'browser';
  const alternative =
    id === 'codex'
      ? cloud
        ? null
        : { mode: 'device' as const, icon: Smartphone, label: 'Sign in with a device code instead', hint: 'Shows a one-time code to type on OpenAI’s page. Handy when this browser is not where you are signed in.' }
      : { mode: 'console' as const, icon: KeyRound, label: 'Use an Anthropic Console API account instead', hint: 'Signs Claude Code in with a Console account. Usage is billed per token to it, not to a Claude plan.' };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
      {connector === undefined ? null : <ConnectorIcon connector={connector} size={18} />}
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {meta.name}
          {account?.version !== null && account?.version !== undefined ? <span className="font-mono text-[10px] text-muted-foreground">v{account.version}</span> : null}
          {signedIn ? (
            <Badge variant="outline" className="border-success/40 bg-success/10 text-[10px] text-success">
              {account?.method === 'subscription' ? 'Subscription' : account?.method === 'api-key' ? 'API key' : 'Signed in'}
              {account?.plan !== null && account?.plan !== undefined ? ` · ${account.plan}` : ''}
            </Badge>
          ) : bridge === 'unknown' ? (
            <Badge variant="outline" className="gap-1 text-[10px] text-muted-foreground">
              <Spinner className="size-2.5" /> Checking
            </Badge>
          ) : bridge === 'available' && account !== null && !installed ? (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              Not installed
            </Badge>
          ) : bridge === 'available' ? (
            <Badge variant="outline" className="border-warning/40 bg-warning/10 text-[10px] text-amber-700 dark:text-warning">
              Not signed in
            </Badge>
          ) : null}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {signedIn && account?.email !== null && account?.email !== undefined
            ? account.email
            : signedIn
              ? `Signed in through ${meta.vendor}.`
              : installed || bridge !== 'available'
                ? `Sign in with your ${meta.subscription} account.`
                : `Install it first: ${meta.installCommand}`}
        </p>
      </div>
      <div className="flex items-center gap-1.5">
        {signedIn ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await logout(id);
                toast(`Signed out of ${meta.name}.`);
              } catch (error) {
                toast.error(error instanceof Error ? error.message : String(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Spinner data-icon="inline-start" /> : <LogOut data-icon="inline-start" />} Sign out
          </Button>
        ) : (
          <>
            <Button size="sm" disabled={!canStart} onClick={() => onSignIn(primary)}>
              {id === 'claude' ? 'Sign in with Claude' : 'Sign in with ChatGPT'}
            </Button>
            {alternative === null ? null : (
              <Tooltip>
                <TooltipTrigger render={<Button size="icon-sm" variant="ghost" aria-label={alternative.label} disabled={!canStart} onClick={() => onSignIn(alternative.mode)} />}>
                  <alternative.icon />
                </TooltipTrigger>
                <TooltipContent className="max-w-64">
                  <span className="font-medium">{alternative.label}.</span> {alternative.hint}
                </TooltipContent>
              </Tooltip>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** GitHub on a cloud machine: what clones private repositories and opens the pull request. */
function GithubRow({ account, bridge, onSignIn }: { account: GithubAccount | null; bridge: BridgeState; onSignIn: () => void }) {
  const logout = useAgentsStore((state) => state.logout);
  const [busy, setBusy] = useState(false);
  const signedIn = account?.loggedIn === true;
  const connector = getConnector('github');
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
      {connector === undefined ? null : <ConnectorIcon connector={connector} size={18} />}
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          GitHub
          {signedIn ? (
            <Badge variant="outline" className="border-success/40 bg-success/10 text-[10px] text-success">
              Signed in
            </Badge>
          ) : bridge === 'available' ? (
            <Badge variant="outline" className="border-warning/40 bg-warning/10 text-[10px] text-amber-700 dark:text-warning">
              Not signed in
            </Badge>
          ) : null}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {signedIn && account?.login ? `@${account.login} — clones your repositories and opens pull requests.` : 'Needed for private repositories and for pull requests. A one-time code, typed at github.com.'}
        </p>
      </div>
      {signedIn ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await logout('github');
              toast('Signed out of GitHub.');
            } catch (error) {
              toast.error(error instanceof Error ? error.message : String(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Spinner data-icon="inline-start" /> : <LogOut data-icon="inline-start" />} Sign out
        </Button>
      ) : (
        <Button size="sm" disabled={bridge !== 'available' || account?.installed === false} onClick={onSignIn}>
          Sign in to GitHub
        </Button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function SignInDialog({ request, onClose }: { request: { agent: AccountId; mode: LoginMode } | null; onClose: () => void }) {
  if (request === null) return null;
  // Keyed by agent+mode so every new request mounts with fresh state instead of
  // resetting the old state inside an effect.
  return <SignInFlow key={`${request.agent}:${request.mode}`} agent={request.agent} mode={request.mode} onClose={onClose} />;
}

function SignInFlow({ agent, mode, onClose }: { agent: AccountId; mode: LoginMode; onClose: () => void }) {
  const startLogin = useAgentsStore((state) => state.startLogin);
  const pollLogin = useAgentsStore((state) => state.pollLogin);
  const submitCode = useAgentsStore((state) => state.submitCode);
  const cancelLogin = useAgentsStore((state) => state.cancelLogin);
  const refresh = useAgentsStore((state) => state.refresh);
  const [session, setSession] = useState<LoginSessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // The id of the CLI process this effect owns, so unmounting cancels it.
    let pendingId: string | null = null;

    const tick = async (id: string) => {
      try {
        const next = await pollLogin(id);
        if (!active) return;
        setSession(next);
        if (next.status !== 'pending') pendingId = null;
        if (next.status === 'pending') timer = setTimeout(() => void tick(id), 1500);
        else if (next.status === 'succeeded') {
          await refresh();
          toast.success(`${ACCOUNT_META[next.agent].name} is signed in.`);
          onClose();
        } else if (next.status === 'failed') setError(next.error ?? 'Sign-in failed.');
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      }
    };

    void (async () => {
      try {
        const started = await startLogin(agent, mode);
        if (!active) {
          if (started.status === 'pending') void cancelLogin(started.id);
          return;
        }
        setSession(started);
        if (started.status === 'pending') {
          pendingId = started.id;
          timer = setTimeout(() => void tick(started.id), 1200);
        }
        else if (started.status === 'failed') setError(started.error ?? 'Sign-in failed.');
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();

    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
      if (pendingId !== null) void cancelLogin(pendingId);
    };
  }, [agent, mode, startLogin, pollLogin, refresh, cancelLogin, onClose]);

  const close = () => onClose();

  const meta = ACCOUNT_META[agent];
  const title = mode === 'console' ? `Sign in to ${meta.name} with an API account` : mode === 'device' ? `Sign in to ${meta.name} with a device code` : `Sign in to ${meta.name}`;

  return (
    <Dialog open onOpenChange={(open) => (!open ? close() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {mode === 'console'
              ? `The ${meta.name} CLI is running its Console login. Usage will be billed to that API account.`
              : `The ${meta.name} CLI is running its own login. Finish it on ${meta.vendor}’s page; the credential lands in the CLI, not here.`}
          </DialogDescription>
        </DialogHeader>

        {error !== null ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
        ) : session === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Starting {meta.name}…
          </div>
        ) : (
          <div className="grid gap-3">
            {session.mode === 'device' ? (
              <>
                <Step n={1} text={`Open ${meta.vendor}’s device page and sign in.`} />
                {session.url ? <OpenLink url={session.url} /> : <Waiting text="Waiting for the CLI to print the page…" />}
                <Step n={2} text="Enter this one-time code when the page asks for it." />
                {session.code ? (
                  <div className="flex items-center justify-center rounded-lg border bg-muted/40 py-3 font-mono text-2xl tracking-widest">{session.code}</div>
                ) : (
                  <Waiting text="Waiting for the code…" />
                )}
                <p className="text-[11px] text-muted-foreground">Continue only because you started this sign-in here. If a website or another person gave you a code, cancel.</p>
              </>
            ) : session.needsCode ? (
              <>
                <Step n={1} text={`Sign in on the ${meta.vendor} page. The CLI opened it; if not, use the link.`} />
                {session.url ? <OpenLink url={session.url} /> : <Waiting text="Waiting for the CLI to print the sign-in link…" />}
                <Step n={2} text="The page shows an authorization code. Paste it here." />
                <form
                  className="flex gap-2"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    try {
                      await submitCode(session.id, code);
                      setSubmitted(true);
                      setCode('');
                    } catch (caught) {
                      setError(caught instanceof Error ? caught.message : String(caught));
                    }
                  }}
                >
                  <div className="grid flex-1 gap-1">
                    <Label htmlFor="auth-code" className="sr-only">
                      Authorization code
                    </Label>
                    <Input id="auth-code" value={code} onChange={(event) => setCode(event.target.value)} placeholder="Paste the code" autoComplete="off" spellCheck={false} className="font-mono" disabled={submitted} />
                  </div>
                  <Button type="submit" disabled={code.trim().length === 0 || submitted}>
                    {submitted ? <Spinner /> : 'Submit'}
                  </Button>
                </form>
                {submitted ? <p className="text-xs text-muted-foreground">Handed to the CLI. Finishing…</p> : null}
                <p className="text-[11px] text-muted-foreground">The code goes to the CLI’s stdin and is not kept. The CLI exchanges it and stores its own credential.</p>
              </>
            ) : (
              <>
                <Step n={1} text={`Finish signing in on the ${meta.vendor} page that just opened.`} />
                {session.url ? <OpenLink url={session.url} label="Open the sign-in page again" /> : <Waiting text="Waiting for the CLI to print the sign-in link…" />}
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Spinner /> Waiting for the CLI to report success…
                </p>
              </>
            )}
          </div>
        )}

        <DialogFooter className="items-center justify-between sm:justify-between">
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <TerminalSquare className="size-3" /> Prefer a terminal? <span className="font-mono">{meta.loginCommand}</span>
          </span>
          <Button variant="outline" onClick={close}>
            {session?.status === 'pending' ? 'Cancel' : 'Close'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <p className="flex items-start gap-2 text-sm">
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold">{n}</span>
      <span>{text}</span>
    </p>
  );
}

function OpenLink({ url, label = 'Open the sign-in page' }: { url: string; label?: string }) {
  return (
    <Button variant="outline" className="justify-between" render={<a href={url} target="_blank" rel="noreferrer noopener" />} nativeButton={false}>
      <span className="truncate">{label}</span>
      <ExternalLink data-icon="inline-end" />
    </Button>
  );
}

function Waiting({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <Spinner /> {text}
    </p>
  );
}
