'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, CircleCheck, CircleDashed, CornerDownRight, ExternalLink, Globe, LayoutTemplate, Play, Plug, RefreshCw, Send, ShieldCheck, Unplug, UserPlus, Workflow as WorkflowIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { HelpTip } from '@/components/app/help-tip';
import { PORT_STYLE } from '@/components/builder/ports';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { useBrand } from '@/hooks/use-brand';
import { useCreateWorkflow } from '@/hooks/use-create-workflow';
import { useNow } from '@/hooks/use-now';
import { useStudio, useWorkflows } from '@/lib/store';
import { appsInUse, connectionState, nothingToConnect, STATE_LABEL, uncoveredNodes, type AppUsage } from '@/lib/connectors/connection-state';
import { credentialSpec } from '@/lib/connectors/credentials';
import { CATEGORY_LABELS, nodeTypeId, type ActionSpec, type Connector, type FieldSpec, type PortSpec, type TriggerSpec } from '@/lib/connectors';
import { workflowFromTrigger } from '@/lib/workflow/templates';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ConnectDialog, useConnectMode } from './connect-dialog';
import { ConnectionStatus } from './connection-status';
import { DisconnectDialog } from './disconnect-dialog';
import { useConnectionActions } from './use-connection-actions';
import { AUTH_ICON, authExplainer, authLabel, isBuiltIn, templatesUsing } from './connector-meta';

interface Props {
  connector: Connector | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Switch the sheet to another app, e.g. HTTP & webhooks from the "missing something?" hint. */
  onOpenApp: (id: string) => void;
}

/** Everything one app can do, explained, with a way to start building from any of its triggers. */
export function ConnectorSheet({ connector, open, onOpenChange, onOpenApp }: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        {connector === undefined ? null : <ConnectorDetail key={connector.id} connector={connector} onOpenApp={onOpenApp} />}
      </SheetContent>
    </Sheet>
  );
}

function ConnectorDetail({ connector, onOpenApp }: { connector: Connector; onOpenApp: (id: string) => void }) {
  const brand = useBrand();
  const router = useRouter();
  const now = useNow();
  const connection = useStudio((state) => state.connections[connector.id]);
  const connect = useStudio((state) => state.connect);
  const disconnect = useStudio((state) => state.disconnect);
  const upsertWorkflow = useStudio((state) => state.upsertWorkflow);
  const repository = useStudio((state) => state.settings.defaultRepository);
  const workflows = useWorkflows();
  const usage = useMemo(() => appsInUse(workflows).get(connector.id), [workflows, connector.id]);
  const [connectOpen, setConnectOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const actions = useConnectionActions();
  const create = useCreateWorkflow();

  const builtIn = isBuiltIn(connector);
  const state = connectionState(connector, connection);
  const spec = credentialSpec(connector.id);
  const mode = useConnectMode(connector.id);
  const templates = templatesUsing(connector.id);
  const how = authExplainer(connector, brand.name);
  const AuthIcon = AUTH_ICON[connector.auth];

  const startFrom = (trigger: TriggerSpec) => {
    const workflow = workflowFromTrigger(nodeTypeId(connector.id, 'trigger', trigger.id), brand, repository);
    if (workflow === undefined) return;
    upsertWorkflow(workflow);
    toast.success(`Created “${workflow.name}”`, { description: 'The trigger is in place. Add what should happen next.' });
    router.push(`/workflows/${workflow.id}`);
  };

  const unmark = () => {
    if (connection === undefined) return;
    const account = connection.account;
    disconnect(connector.id);
    toast(`Unmarked ${connector.name}`, { action: { label: 'Undo', onClick: () => connect(connector.id, account) } });
  };

  return (
    <>
      <div className="border-b p-5 pr-12">
        <div className="flex items-start gap-3.5">
          <ConnectorIcon connector={connector} size={24} />
          <div className="min-w-0">
            <SheetTitle className="text-lg leading-tight font-semibold">{connector.name}</SheetTitle>
            <SheetDescription className="mt-0.5 text-[13px]">
              {builtIn ? `Built into ${brand.name}` : `${CATEGORY_LABELS[connector.category]} · ${authLabel(connector)}`}
            </SheetDescription>
          </div>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-pretty">{connector.description}</p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {nothingToConnect(state) ? (
            <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-muted px-2.5 text-xs text-muted-foreground">{builtIn ? 'Always available' : STATE_LABEL[state]}</span>
          ) : state === 'missing' ? (
            <>
              <Button size="sm" onClick={() => setConnectOpen(true)}>
                {spec === undefined ? <CircleDashed data-icon="inline-start" /> : <Plug data-icon="inline-start" />} {spec === undefined ? 'Mark ready' : 'Connect'}
              </Button>
              <span className="text-xs text-muted-foreground">Not connected. You can still build and test with it.</span>
            </>
          ) : (
            <>
              <span className="inline-flex h-7 max-w-full items-center rounded-full bg-muted px-2.5">
                <ConnectionStatus state={state} connection={connection} />
                {connection === undefined ? null : <span className="ml-1 shrink-0 text-xs text-muted-foreground">· {timeAgo(connection.credential?.checkedAt ?? connection.connectedAt, now)}</span>}
              </span>
              {state === 'marked' ? (
                <>
                  {spec === undefined ? null : (
                    <Button size="sm" onClick={() => setConnectOpen(true)}>
                      <Plug data-icon="inline-start" /> Connect for real
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={unmark}>
                    Unmark
                  </Button>
                </>
              ) : null}
            </>
          )}
          {connector.docsUrl === undefined ? null : (
            <Button size="sm" variant="ghost" nativeButton={false} render={<a href={connector.docsUrl} target="_blank" rel="noreferrer" />}>
              API docs <ExternalLink data-icon="inline-end" />
            </Button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto p-5">
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">What teams use it for</h3>
          <ul className="flex flex-col gap-1.5">
            {connector.uses.map((use) => (
              <li key={use} className="flex gap-2 text-[13px] leading-relaxed">
                <CornerDownRight className="mt-1 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="text-pretty">{use}</span>
              </li>
            ))}
          </ul>
        </section>

        {spec !== undefined && connection?.credential !== undefined ? (
          <section className={cn('rounded-lg border p-3.5', state === 'failing' ? 'border-destructive/40 bg-destructive/5' : 'bg-muted/30')}>
            <p className="flex items-center gap-2 text-sm font-medium">
              <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
              Connected with {spec.noun}
              <HelpTip term="connection" className="ml-auto" />
            </p>
            <dl className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]">
              <dt className="text-muted-foreground">Posts as</dt>
              <dd className="truncate font-medium">{connection.account}</dd>
              <dt className="text-muted-foreground">Credential</dt>
              <dd className="font-mono text-xs leading-5">···{connection.credential.hint}</dd>
              <dt className="text-muted-foreground">Last check</dt>
              <dd className={state === 'failing' ? 'text-destructive' : ''}>
                {state === 'failing' ? `Refused ${timeAgo(connection.credential.checkedAt, now)}: ${connection.credential.error ?? `${connector.name} did not accept it.`}` : `${connector.name} accepted it ${timeAgo(connection.credential.checkedAt, now)}`}
              </dd>
            </dl>
            <div className="mt-3 flex flex-wrap gap-2">
              {state === 'failing' ? (
                <Button size="sm" onClick={() => setConnectOpen(true)}>
                  <Plug data-icon="inline-start" /> Paste a new one
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled={actions.busy !== null} onClick={() => void actions.test(connector)}>
                  {actions.busy === 'test' ? <Spinner data-icon="inline-start" /> : <Send data-icon="inline-start" />} Send a test message
                </Button>
              )}
              <Button size="sm" variant="outline" disabled={actions.busy !== null} onClick={() => void actions.check(connector)}>
                {actions.busy === 'check' ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />} Check again
              </Button>
              {state === 'failing' ? null : (
                <Button size="sm" variant="ghost" onClick={() => setConnectOpen(true)}>
                  Replace
                </Button>
              )}
              <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={actions.busy !== null} onClick={() => setConfirmOpen(true)}>
                <Unplug data-icon="inline-start" /> Disconnect
              </Button>
            </div>
            <p className="mt-3 border-t border-dashed pt-2.5 text-[13px] leading-relaxed text-muted-foreground">
              {spec.scope} Checking asks {connector.name} whether it still works and posts nothing.
            </p>
          </section>
        ) : (
          <section className="rounded-lg border bg-muted/30 p-3.5">
            <p className="flex items-center gap-2 text-sm font-medium">
              {spec === undefined ? <AuthIcon className="size-4 text-muted-foreground" aria-hidden /> : <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />}
              {spec === undefined ? how.title : `Connects with ${spec.noun}`}
              {spec === undefined && !nothingToConnect(state) ? (
                <span className="rounded-full border px-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Planned</span>
              ) : null}
              <HelpTip term="connection" className="ml-auto" />
            </p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
              {spec === undefined ? how.body : `${connector.name} checks it before ${brand.name} keeps it, encrypted. ${spec.scope}`}
            </p>
            {nothingToConnect(state) ? null : spec === undefined ? (
              <p className="mt-2.5 flex gap-2 border-t border-dashed pt-2.5 text-[13px] leading-relaxed text-muted-foreground">
                <CircleDashed className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>Until then you can mark it ready, which records a label and signs in to nothing. Every trigger and action below works in the builder and in test runs either way.</span>
              </p>
            ) : mode === 'needs-account' ? (
              <p className="mt-2.5 flex gap-2 border-t border-dashed pt-2.5 text-[13px] leading-relaxed text-muted-foreground">
                <UserPlus className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>Connecting for real keeps it in your account, so it needs one. Free, and what you made in this browser comes with you.</span>
              </p>
            ) : null}
          </section>
        )}

        {spec === undefined ? null : <Coverage connector={connector} actions={spec.actions} caveat={spec.caveat} name={spec.name} />}

        {usage === undefined ? null : <UsedBy usage={usage} />}

        {templates.length === 0 ? null : (
          <section className="flex flex-col gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                Ready-made workflows
                <span className="rounded-full bg-muted px-1.5 text-[11px] font-medium text-muted-foreground tabular-nums">{templates.length}</span>
              </h3>
              <p className="mt-0.5 text-[13px] text-muted-foreground">Complete workflows that use {connector.name}, guardrails included. Start from one and change what you need.</p>
            </div>
            {templates.map((template) => (
              <div key={template.id} className="rounded-lg border p-3.5">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <LayoutTemplate className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  {template.name}
                </p>
                <p className="mt-1 text-[13px] leading-snug text-pretty text-muted-foreground">{template.when}</p>
                <div className="mt-2.5 flex justify-end">
                  <Button size="xs" onClick={() => create.fromTemplate(template.id)}>
                    Use this template <ArrowRight data-icon="inline-end" />
                  </Button>
                </div>
              </div>
            ))}
          </section>
        )}

        <section className="flex flex-col gap-3">
          <SectionHeading
            title="Triggers"
            count={connector.triggers.length}
            term="trigger"
            hint={
              connector.triggers.length === 0
                ? `${connector.name} cannot start a workflow on its own. Start from a schedule, a webhook or another app, and use its actions.`
                : 'Things that happen in the app and can start a workflow. Start from one and the builder opens with it in place.'
            }
          />
          {connector.triggers.map((trigger) => (
            <div key={trigger.id} className="rounded-lg border p-3.5">
              <SpecText name={trigger.name} description={trigger.description} />
              <div className="mt-2.5 flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
                <div className="flex min-w-0 flex-col gap-1">
                  <PortLine verb="Hands on" ports={trigger.outputs ?? []} kind="trigger" />
                  <FieldsLine fields={trigger.fields} />
                </div>
                <Button size="xs" variant="outline" onClick={() => startFrom(trigger)}>
                  <Play data-icon="inline-start" /> Start a workflow with this
                </Button>
              </div>
            </div>
          ))}
        </section>

        <section className="flex flex-col gap-3">
          <SectionHeading
            title="Actions"
            count={connector.actions.length}
            term="action"
            hint={connector.actions.length === 0 ? `${connector.name} only starts workflows; it has nothing to do at the end of one.` : `Steps a workflow can take in ${connector.name}. Add them from the palette in the builder.`}
          />
          <div className="divide-y rounded-lg border">
            {connector.actions.map((action) => (
              <ActionRow key={action.id} action={action} />
            ))}
          </div>
        </section>

        {builtIn ? null : (
          <p className="flex items-start gap-2 text-[13px] text-muted-foreground">
            <Globe className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              Need something {connector.name} does not list here? An HTTP request can call its API directly.{' '}
              <button type="button" className="font-medium text-signal hover:underline" onClick={() => onOpenApp('http')}>
                See HTTP & webhooks
              </button>
            </span>
          </p>
        )}
      </div>

      <ConnectDialog connector={connector} open={connectOpen} onOpenChange={setConnectOpen} />
      <DisconnectDialog connector={connector} open={confirmOpen} onOpenChange={setConfirmOpen} onConfirm={() => void actions.disconnect(connector)} />
    </>
  );
}

/** What a webhook can do among the app's steps, and what still needs a full sign-in. */
function Coverage({ connector, actions, caveat, name }: { connector: Connector; actions: string[]; caveat: string | undefined; name: string }) {
  const covered = connector.actions.filter((action) => actions.includes(action.id));
  const rest = connector.actions.filter((action) => !actions.includes(action.id));
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">What the {name.toLowerCase()} can do</h3>
      <ul className="grid gap-1 text-[13px]">
        {covered.map((action) => (
          <li key={action.id} className="flex items-center gap-2">
            <CircleCheck className="size-3.5 shrink-0 text-success" aria-hidden />
            {action.name}
          </li>
        ))}
      </ul>
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        {rest.length > 0 ? `${rest.map((action) => action.name).join(', ')}${connector.triggers.length > 0 ? ' and its triggers' : ''} need a full ${connector.name} sign-in, which is not built yet; they still play in test runs.` : null} {caveat}
      </p>
    </section>
  );
}

/** The workflows that use this app, one click from each. */
function UsedBy({ usage }: { usage: AppUsage }) {
  const uncovered = uncoveredNodes(usage.connectorId, usage.nodes);
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        In your workflows
        <span className="rounded-full bg-muted px-1.5 text-[11px] font-medium text-muted-foreground tabular-nums">{usage.workflows.length}</span>
      </h3>
      <ul className="divide-y rounded-lg border">
        {usage.workflows.map((workflow) => (
          <li key={workflow.id}>
            <Link href={`/workflows/${workflow.id}`} className="flex items-center gap-2 px-3 py-2 text-[13px] outline-none hover:bg-muted/50 focus-visible:bg-muted/50">
              <WorkflowIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate font-medium">{workflow.name}</span>
              <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
      {uncovered.length === 0 ? null : (
        <p className="text-xs text-pretty text-amber-700 dark:text-warning">
          They use {uncovered.map((def) => def.name).join(', ')}, which a webhook cannot do: a real run stops there until {usage.nodes[0]?.connector.name ?? 'the app'} has a full sign-in.
        </p>
      )}
    </section>
  );
}

function SectionHeading({ title, count, term, hint }: { title: string; count: number; term: 'trigger' | 'action'; hint: string }) {
  return (
    <div>
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        {title}
        <span className="rounded-full bg-muted px-1.5 text-[11px] font-medium text-muted-foreground tabular-nums">{count}</span>
        <HelpTip term={term} />
      </h3>
      <p className="mt-0.5 text-[13px] text-muted-foreground">{hint}</p>
    </div>
  );
}

function SpecText({ name, description }: { name: string; description: string }) {
  return (
    <div className="min-w-0">
      <p className="text-sm font-medium">{name}</p>
      <p className="text-[13px] leading-snug text-muted-foreground">{description}</p>
    </div>
  );
}

function ActionRow({ action }: { action: ActionSpec }) {
  return (
    <div className="p-3.5">
      <SpecText name={action.name} description={action.description} />
      <div className="mt-2 flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <PortLine verb="Takes" ports={action.inputs ?? []} kind="action" />
          <ArrowRight className="size-3 text-muted-foreground/60" aria-hidden />
          <PortLine verb="hands on" ports={action.outputs ?? []} kind="action" />
        </div>
        <FieldsLine fields={action.fields} />
      </div>
    </div>
  );
}

/** "Hands on a ticket", "Takes anything", or "branches: Within budget / Refused" — ports in words, with the builder's colours. */
function PortLine({ verb, ports, kind }: { verb: string; ports: PortSpec[]; kind: 'trigger' | 'action' }) {
  if (ports.length === 0) return null;
  if (ports.length === 1) {
    const port = ports[0]!;
    // An action's lone plain-event output is just "I'm done"; say that instead of naming a type.
    const words = kind === 'action' && port.type === 'event' && verb !== 'Takes' ? 'a signal that it finished' : PORT_STYLE[port.type].noun;
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Dot type={port.type} />
        {verb} {words}
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span>branches:</span>
      {ports.map((port) => (
        <span key={port.id} className="inline-flex items-center gap-1.5" title={`${port.label}: hands on ${PORT_STYLE[port.type].noun}`}>
          <Dot type={port.type} />
          <span className="font-medium text-foreground/80">{port.label}</span>
        </span>
      ))}
    </span>
  );
}

function Dot({ type }: { type: PortSpec['type'] }) {
  return <span className={cn('size-2 shrink-0 rounded-full ring-2 ring-background', PORT_STYLE[type].dot)} aria-hidden />;
}

function FieldsLine({ fields }: { fields: FieldSpec[] | undefined }) {
  if (fields === undefined || fields.length === 0) return null;
  const labels = fields.map((field) => field.label);
  return (
    <p className="text-xs text-muted-foreground">
      You set: <span className="text-foreground/80">{labels.slice(0, 4).join(', ')}</span>
      {labels.length > 4 ? ` and ${labels.length - 4} more` : ''}
    </p>
  );
}
