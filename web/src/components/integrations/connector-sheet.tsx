'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, ExternalLink, FlaskConical, Globe, Play, Plug, Unplug } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { HelpTip } from '@/components/app/help-tip';
import { PORT_STYLE } from '@/components/builder/ports';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { useBrand } from '@/hooks/use-brand';
import { useNow } from '@/hooks/use-now';
import { useStudio } from '@/lib/store';
import { CATEGORY_LABELS, nodeTypeId, type ActionSpec, type Connector, type FieldSpec, type PortSpec, type TriggerSpec } from '@/lib/connectors';
import { workflowFromTrigger } from '@/lib/workflow/templates';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ConnectDialog } from './connect-dialog';
import { AUTH_ICON, authExplainer, authLabel, isBuiltIn } from './connector-meta';

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
  const [connectOpen, setConnectOpen] = useState(false);

  const builtIn = isBuiltIn(connector);
  const how = authExplainer(connector, brand.name);
  const AuthIcon = AUTH_ICON[connector.auth];

  const startFrom = (trigger: TriggerSpec) => {
    const workflow = workflowFromTrigger(nodeTypeId(connector.id, 'trigger', trigger.id), brand, repository);
    if (workflow === undefined) return;
    upsertWorkflow(workflow);
    toast.success(`Created “${workflow.name}”`, { description: 'The trigger is in place. Add what should happen next.' });
    router.push(`/workflows/${workflow.id}`);
  };

  const onDisconnect = () => {
    if (connection === undefined) return;
    const account = connection.account;
    disconnect(connector.id);
    toast(`Disconnected ${connector.name}`, { action: { label: 'Undo', onClick: () => connect(connector.id, account) } });
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
          {builtIn ? (
            <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-muted px-2.5 text-xs text-muted-foreground">
              <span className="size-1.5 rounded-full bg-success" aria-hidden /> Always available
            </span>
          ) : connection === undefined ? (
            <>
              <Button size="sm" onClick={() => setConnectOpen(true)}>
                <Plug data-icon="inline-start" /> Connect
              </Button>
              <span className="text-xs text-muted-foreground">Not connected. You can still build and test with it.</span>
            </>
          ) : (
            <>
              <span className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full bg-success/10 px-2.5 text-xs text-success">
                <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden />
                <span className="truncate">
                  Connected as <span className="font-medium">{connection.account}</span> · {timeAgo(connection.connectedAt, now)}
                </span>
              </span>
              <Button size="sm" variant="outline" onClick={onDisconnect}>
                <Unplug data-icon="inline-start" /> Disconnect
              </Button>
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
        <section className="rounded-lg border bg-muted/30 p-3.5">
          <p className="flex items-center gap-2 text-sm font-medium">
            <AuthIcon className="size-4 text-muted-foreground" aria-hidden />
            {how.title}
            <HelpTip term="connection" className="ml-auto" />
          </p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{how.body}</p>
          {builtIn ? null : (
            <p className="mt-2.5 flex gap-2 border-t border-dashed pt-2.5 text-[13px] leading-relaxed text-muted-foreground">
              <FlaskConical className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
              <span>
                For now that step is a marker: connecting only records a label with your workflows. Every trigger and action below works in the builder and in test runs either way.
              </span>
            </p>
          )}
        </section>

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
              <button type="button" className="font-medium text-primary hover:underline" onClick={() => onOpenApp('http')}>
                See HTTP & webhooks
              </button>
            </span>
          </p>
        )}
      </div>

      <ConnectDialog connector={connector} open={connectOpen} onOpenChange={setConnectOpen} />
    </>
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
