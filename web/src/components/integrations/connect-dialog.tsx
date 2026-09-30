'use client';

import Link from 'next/link';
import { useState } from 'react';
import { CircleAlert, CircleDashed, ExternalLink, ShieldCheck, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { useBrand } from '@/hooks/use-brand';
import { useAccount, useCapabilities } from '@/lib/cloud/account';
import { connectForReal, sendTestMessage } from '@/lib/cloud/connections';
import { credentialSpec, type CredentialSpec } from '@/lib/connectors/credentials';
import { useStudio } from '@/lib/store';
import type { Connector } from '@/lib/connectors';
import { authExplainer, authLabel } from './connector-meta';

interface Props {
  connector: Connector | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** How this app can be connected here, now. */
export type ConnectMode =
  /** Paste a credential; the server checks it with the app and keeps it encrypted. */
  | 'real'
  /** The app connects for real, but only into an account. */
  | 'needs-account'
  /** Only a marker: the app has no real sign-in yet, or this server cannot keep credentials. */
  | 'marker';

export function useConnectMode(connectorId: string): ConnectMode {
  const capabilities = useCapabilities();
  const signedIn = useAccount((state) => state.status === 'signed-in');
  if (credentialSpec(connectorId) === undefined || capabilities.credentials !== true) return 'marker';
  return signedIn ? 'real' : 'needs-account';
}

/**
 * Connecting an app. Slack and Discord take a webhook, which the server
 * checks with the app before keeping; everything else can be marked ready,
 * and the dialog says plainly that nothing is signed in to.
 */
export function ConnectDialog({ connector, open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* Keyed so every app starts with empty fields. */}
        {connector === null ? null : <ConnectBody key={connector.id} connector={connector} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function ConnectBody({ connector, onDone }: { connector: Connector; onDone: () => void }) {
  const mode = useConnectMode(connector.id);
  const spec = credentialSpec(connector.id);
  if (mode === 'real' && spec !== undefined) return <RealForm connector={connector} spec={spec} onDone={onDone} />;
  return <MarkerForm connector={connector} spec={mode === 'needs-account' ? spec : undefined} onDone={onDone} />;
}

function Header({ connector, title, subtitle }: { connector: Connector; title: string; subtitle: string }) {
  return (
    <DialogHeader>
      <div className="flex items-center gap-3">
        <ConnectorIcon connector={connector} size={20} />
        <div className="min-w-0">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="mt-1">{subtitle}</DialogDescription>
        </div>
      </div>
    </DialogHeader>
  );
}

/* ------------------------------------------------------------------ */
/* A real credential                                                    */
/* ------------------------------------------------------------------ */

function RealForm({ connector, spec, onDone }: { connector: Connector; spec: CredentialSpec; onDone: () => void }) {
  const brand = useBrand();
  const existing = useStudio((state) => state.connections[connector.id]);
  const replacing = existing?.credential !== undefined;
  const [secret, setSecret] = useState('');
  const [label, setLabel] = useState(replacing ? existing.account : '');
  const [touched, setTouched] = useState(false);
  const [checking, setChecking] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const value = secret.trim();
  const shapeOk = spec.input.pattern.test(value);
  // Only complain about the shape once someone has pasted or left the field; not while they type.
  const showMismatch = value.length > 0 && !shapeOk && (touched || value.length > 40);

  const submit = async () => {
    setTouched(true);
    if (!shapeOk || checking) return;
    setChecking(true);
    setRefusal(null);
    try {
      const connection = await connectForReal(connector.id, value, label);
      toast.success(`${connector.name} connected`, {
        description: `${connector.name} accepted ${spec.noun.replace(/^an? /, 'the ')}. Workflows post as “${connection.account}”.`,
        action: {
          label: 'Send a test message',
          onClick: () => {
            void sendTestMessage(connector.id, brand.name).then(
              () => toast.success('Test message sent', { description: `Look for it in ${connection.account}.` }),
              (error: unknown) => toast.error(`${connector.name} did not take the test message`, { description: error instanceof Error ? error.message : undefined }),
            );
          },
        },
      });
      onDone();
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : `${connector.name} did not accept it.`);
    } finally {
      setChecking(false);
    }
  };

  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Header connector={connector} title={replacing ? `Replace ${connector.name}’s ${spec.name.toLowerCase()}` : `Connect ${connector.name}`} subtitle={`${spec.name} · checked with ${connector.name}, then kept encrypted`} />

      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Get one</p>
          <Button size="xs" variant="outline" nativeButton={false} render={<a href={spec.setup.href} target="_blank" rel="noreferrer" />}>
            {spec.setup.label} <ExternalLink data-icon="inline-end" />
          </Button>
        </div>
        <ol className="grid gap-1.5 text-[13px] leading-snug">
          {spec.steps.map((step, index) => (
            <li key={step} className="flex gap-2.5">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium text-muted-foreground tabular-nums">{index + 1}</span>
              <span className="pt-0.5 text-pretty">{step}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="connect-secret">{spec.input.label}</Label>
        <Input
          id="connect-secret"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={secret}
          onChange={(event) => {
            setSecret(event.target.value);
            setRefusal(null);
          }}
          onBlur={() => setTouched(true)}
          placeholder={spec.input.placeholder}
          aria-invalid={showMismatch || refusal !== null}
          aria-describedby="connect-secret-help"
          className="font-mono text-xs"
        />
        <p id="connect-secret-help" className={showMismatch ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
          {showMismatch ? spec.input.mismatch : replacing ? `Replaces the one ending ···${existing.credential!.hint}. Paste the whole URL; it is not shown again after this.` : 'Paste the whole URL. It is not shown again after this.'}
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="connect-label">
          {spec.label.label} <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Input id="connect-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder={spec.label.placeholder} maxLength={80} />
        <p className="text-xs text-muted-foreground">{spec.label.help}</p>
      </div>

      <div className="flex gap-2.5 rounded-lg border bg-muted/30 p-3 text-[13px] leading-relaxed text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-foreground" aria-hidden />
        <p>
          <span className="font-medium text-foreground">What it can do.</span> {spec.scope} {brand.name} encrypts it on the server; the browser only keeps its last four characters.
        </p>
      </div>

      {refusal === null ? null : (
        <div role="alert" className="flex gap-2.5 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-[13px] leading-relaxed">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          <p>
            <span className="font-medium text-destructive">Not connected.</span> <span className="text-muted-foreground">{refusal}</span>
          </p>
        </div>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={checking || value.length === 0}>
          {checking ? (
            <>
              <Spinner data-icon="inline-start" /> Checking with {connector.name}…
            </>
          ) : replacing ? (
            'Check and replace'
          ) : (
            'Check and connect'
          )}
        </Button>
      </DialogFooter>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* A marker                                                             */
/* ------------------------------------------------------------------ */

/**
 * Marking an app ready. With `spec`, the app does connect for real, just not
 * for a guest: the dialog offers an account first and the marker second.
 */
function MarkerForm({ connector, spec, onDone }: { connector: Connector; spec: CredentialSpec | undefined; onDone: () => void }) {
  const brand = useBrand();
  const connect = useStudio((state) => state.connect);
  const accountsOn = useCapabilities().enabled;
  const [account, setAccount] = useState('');
  const fallback = `acme (${connector.name})`;
  const how = authExplainer(connector, brand.name);
  const next = encodeURIComponent(`/integrations?app=${connector.id}`);
  const realElsewhere = spec === undefined && credentialSpec(connector.id) !== undefined;

  const submit = () => {
    const label = account.trim() || fallback;
    connect(connector.id, label);
    toast.success(`${connector.name} marked ready`, { description: `As “${label}”. Nothing was signed in to; its nodes just stop asking.` });
    onDone();
  };

  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Header
        connector={connector}
        title={spec === undefined ? `Mark ${connector.name} ready` : `Connect ${connector.name}`}
        subtitle={`${spec?.name ?? authLabel(connector)} · ${connector.triggers.length} triggers · ${connector.actions.length} actions`}
      />

      {spec === undefined ? (
        <div className="grid gap-1 text-[13px]">
          <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{realElsewhere ? 'Connecting for real' : 'Not built yet'}</p>
          <p className="font-medium">{realElsewhere ? `${connector.name} connects for real on a server that keeps credentials` : how.title}</p>
          <p className="leading-relaxed text-muted-foreground">
            {realElsewhere ? 'This one has accounts or its encryption key switched off, so here it can only be marked ready.' : how.body}
          </p>
        </div>
      ) : (
        <div className="grid gap-3 rounded-lg border p-3.5">
          <div className="flex gap-2.5 text-[13px] leading-relaxed">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">{connector.name} connects for real.</span> Paste its {spec.input.label.toLowerCase()} and {brand.name} checks it with {connector.name} and keeps it encrypted in your account. That needs an account: free, and what you made in this browser comes with you.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 pl-6.5">
            <Button size="sm" nativeButton={false} render={<Link href={`/sign-up?next=${next}`} />}>
              <UserPlus data-icon="inline-start" /> Create an account
            </Button>
            {accountsOn ? (
              <Button size="sm" variant="ghost" nativeButton={false} render={<Link href={`/sign-in?next=${next}`} />}>
                Sign in
              </Button>
            ) : null}
          </div>
        </div>
      )}

      <div className="grid gap-2">
        {spec === undefined ? null : <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Or mark it ready for now</p>}
        <div className="flex gap-2.5 rounded-lg border border-dashed p-3 text-[13px] leading-relaxed text-muted-foreground">
          <CircleDashed className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            <span className="font-medium text-foreground">Marking it ready signs in to nothing.</span> It records a label so {connector.name}’s nodes stop asking to be connected. Test runs work either way; an export uses your repository’s secrets.
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="connect-account">Label</Label>
          <Input id="connect-account" autoFocus={spec === undefined} value={account} onChange={(event) => setAccount(event.target.value)} placeholder={fallback} maxLength={80} />
          <p className="text-xs text-muted-foreground">Shown on the card and in the builder. Left empty, it is “{fallback}”.</p>
        </div>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant={spec === undefined ? 'default' : 'outline'}>
          Mark as ready
        </Button>
      </DialogFooter>
    </form>
  );
}
