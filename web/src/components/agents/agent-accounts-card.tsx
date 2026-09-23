'use client';

import { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, KeyRound, LogOut, RefreshCw, Smartphone, TerminalSquare } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { getConnector } from '@/lib/connectors';
import { useAgentsStore } from '@/hooks/use-agent-accounts';
import { useStudio } from '@/lib/store';
import { AGENT_IDS, AGENT_META, type AgentAccount, type AgentId, type LoginMode, type LoginSessionView } from '@/lib/agents/types';

const CONNECTOR_FOR: Record<AgentId, string> = { claude: 'claude-code', codex: 'codex-cli' };

export function AgentAccountsCard() {
  const bridge = useAgentsStore((state) => state.bridge);
  const status = useAgentsStore((state) => state.status);
  const loading = useAgentsStore((state) => state.loading);
  const refresh = useAgentsStore((state) => state.refresh);
  const repository = useStudio((state) => state.settings.defaultRepository);
  const [signing, setSigning] = useState<{ agent: AgentId; mode: LoginMode } | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span>Agent accounts</span>
          <Button variant="ghost" size="icon-xs" aria-label="Refresh" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={loading ? 'animate-spin' : ''} />
          </Button>
        </CardTitle>
        <CardDescription>
          Bring your own subscription. Each coding agent signs in with its own CLI and its own account. The studio never sees a key or a token: it asks the CLI whether it is signed in and can start the CLI’s login for you.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {bridge === 'unavailable' ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
            The local bridge is not reachable, so sign-in from the browser is off. Run the studio on the machine where the CLIs live (<span className="font-mono">npm run dev</span>), or sign in from a terminal with{' '}
            <span className="font-mono">claude auth login</span> and <span className="font-mono">codex login</span>.
          </div>
        ) : null}
        {AGENT_IDS.map((id) => (
          <AgentRow key={id} id={id} account={status?.agents[id] ?? null} bridge={bridge} onSignIn={(mode) => setSigning({ agent: id, mode })} />
        ))}
        <ActionsSecrets repository={repository} />
      </CardContent>
      <SignInDialog request={signing} onClose={() => setSigning(null)} />
    </Card>
  );
}

function AgentRow({ id, account, bridge, onSignIn }: { id: AgentId; account: AgentAccount | null; bridge: string; onSignIn: (mode: LoginMode) => void }) {
  const meta = AGENT_META[id];
  const connector = getConnector(CONNECTOR_FOR[id]);
  const logout = useAgentsStore((state) => state.logout);
  const [busy, setBusy] = useState(false);

  const signedIn = account?.loggedIn === true;
  const installed = account?.installed === true;

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
      {connector === undefined ? null : <ConnectorIcon connector={connector} size={18} />}
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-medium">
          {meta.name}
          {account?.version !== null && account?.version !== undefined ? <span className="font-mono text-[10px] text-muted-foreground">v{account.version}</span> : null}
          {signedIn ? (
            <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-300">
              {account?.method === 'subscription' ? 'Subscription' : account?.method === 'api-key' ? 'API key' : 'Signed in'}
              {account?.plan !== null && account?.plan !== undefined ? ` · ${account.plan}` : ''}
            </Badge>
          ) : bridge === 'available' && account !== null && !installed ? (
            <Badge variant="outline" className="text-[10px]">
              Not installed
            </Badge>
          ) : bridge === 'available' ? (
            <Badge variant="outline" className="text-[10px]">
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
            <LogOut data-icon="inline-start" /> Sign out
          </Button>
        ) : (
          <>
            <Button size="sm" disabled={bridge !== 'available' || !installed} onClick={() => onSignIn('browser')}>
              {id === 'claude' ? 'Sign in with Claude' : 'Sign in with ChatGPT'}
            </Button>
            {id === 'codex' ? (
              <Button size="sm" variant="ghost" disabled={bridge !== 'available' || !installed} onClick={() => onSignIn('device')} title="Device code">
                <Smartphone />
              </Button>
            ) : (
              <Button size="sm" variant="ghost" disabled={bridge !== 'available' || !installed} onClick={() => onSignIn('console')} title="Use an Anthropic Console API account instead">
                <KeyRound />
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ActionsSecrets({ repository }: { repository: string }) {
  const repo = repository.trim() || 'owner/repo';
  return (
    <details className="rounded-lg border bg-muted/30 p-3 text-xs">
      <summary className="cursor-pointer font-medium">Use the same subscriptions in GitHub Actions</summary>
      <p className="mt-2 text-muted-foreground">
        Exported workflows run on GitHub’s runners, where nobody can click a sign-in page. Each vendor has a supported way to carry a subscription there. Run these in your own terminal; the studio never sees the values.
      </p>
      <div className="mt-3 grid gap-3">
        <CommandLine label="Claude Code · a long-lived subscription token (valid one year)" command={`claude setup-token\ngh secret set CLAUDE_CODE_OAUTH_TOKEN -R ${repo}   # paste the token when asked`} />
        <CommandLine label="Codex · the sign-in file the CLI already keeps (OpenAI’s documented CI method)" command={`codex login\ngh secret set CODEX_AUTH_JSON -R ${repo} < ~/.codex/auth.json`} />
      </div>
      <p className="mt-3 text-muted-foreground">
        OpenAI asks that the auth.json method not be used on public repositories. The Claude token is tied to the person who created it and counts against that plan.
      </p>
    </details>
  );
}

function CommandLine({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <p className="mb-1 flex items-center justify-between text-[11px] font-medium">
        {label}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Copy"
          onClick={async () => {
            await navigator.clipboard.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </p>
      <pre className="overflow-x-auto rounded-md bg-background p-2 font-mono text-[11px]">{command}</pre>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function SignInDialog({ request, onClose }: { request: { agent: AgentId; mode: LoginMode } | null; onClose: () => void }) {
  if (request === null) return null;
  // Keyed by agent+mode so every new request mounts with fresh state instead of
  // resetting the old state inside an effect.
  return <SignInFlow key={`${request.agent}:${request.mode}`} agent={request.agent} mode={request.mode} onClose={onClose} />;
}

function SignInFlow({ agent, mode, onClose }: { agent: AgentId; mode: LoginMode; onClose: () => void }) {
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
          toast.success(`${AGENT_META[next.agent].name} is signed in.`);
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

  const meta = AGENT_META[agent];
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
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">{error}</div>
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
