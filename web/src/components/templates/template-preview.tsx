'use client';

import Link from 'next/link';
import { ArrowRight, Bot, CheckCircle2, CircleDashed, CornerDownRight, Plug, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { HelpTip } from '@/components/app/help-tip';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { useSignedIn } from '@/hooks/use-agent-accounts';
import { useStudio } from '@/lib/store';
import { getConnector } from '@/lib/connectors';
import { AGENT_OPTIONS } from '@/lib/connectors/catalog/core';
import type { DescribedStep } from '@/lib/workflow/describe';
import type { Workflow } from '@/lib/workflow/schema';
import { cn } from '@/lib/utils';
import { GraphView } from './graph-view';
import type { TemplateEntry } from './template-entry';

interface Props {
  entry: TemplateEntry | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUse: (templateId: string) => void;
}

/** The whole template before you take it: the graph, what each step does in order, and what it needs from you. */
export function TemplatePreview({ entry, open, onOpenChange, onUse }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        {entry === undefined ? null : <PreviewBody entry={entry} onUse={onUse} />}
      </DialogContent>
    </Dialog>
  );
}

function PreviewBody({ entry, onUse }: { entry: TemplateEntry; onUse: (templateId: string) => void }) {
  const { meta, workflow, description, connectors } = entry;
  return (
    <>
      <div className="flex flex-col gap-2 border-b p-5 pr-12">
        <div className="flex flex-wrap items-center gap-1">
          {connectors.map((connector) => (
            <span key={connector.id} title={connector.name}>
              <ConnectorIcon connector={connector} size={12} />
            </span>
          ))}
        </div>
        <DialogTitle className="text-lg font-semibold tracking-tight">{meta.name}</DialogTitle>
        <DialogDescription className="max-w-3xl text-pretty">{meta.description}</DialogDescription>
        <div className="flex flex-wrap gap-1">
          {meta.tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="font-normal">
              {tag}
            </Badge>
          ))}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-5">
        <GraphView workflow={workflow} className="h-52 shrink-0 sm:h-80" />

        <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_17rem]">
          <section>
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              Step by step
              <HelpTip title="Reading the steps">
                Each step is one node, in the order a run reaches it from the trigger. Indented steps sit on a branch and only run when that branch is taken.
              </HelpTip>
            </h3>
            <ol className="mt-3 flex flex-col">
              {description.steps.map((step, index) => (
                <StepItem key={step.nodeId} step={step} index={index} from={branchParent(workflow, description.steps, index)} last={index === description.steps.length - 1} />
              ))}
            </ol>
            {description.unreachable.length > 0 ? (
              <div className="mt-2 flex gap-2.5 rounded-lg border border-dashed p-3 text-[13px] text-muted-foreground">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                <p>
                  <span className="font-medium text-foreground">Placed but not wired in: </span>
                  {description.unreachable.map((step) => step.title).join(', ')}. {description.unreachable.length === 1 ? 'It stays' : 'They stay'} on the canvas as an option and never run until you wire {description.unreachable.length === 1 ? 'it' : 'them'} in.
                </p>
              </div>
            ) : null}
          </section>

          <aside className="flex flex-col gap-5">
            <h3 className="text-sm font-semibold">What you’ll need</h3>
            <NeededApps apps={description.apps} />
            <NeededAgents agents={description.agents} />
            <p className="text-xs leading-relaxed text-muted-foreground">
              None of this blocks you: the copy opens in the builder straight away, and test runs are simulated, so you can try it before connecting anything.
            </p>
          </aside>
        </div>
      </div>

      <div className="flex flex-col-reverse gap-2 border-t bg-muted/40 p-4 sm:flex-row sm:items-center sm:justify-end">
        <p className="mr-auto hidden text-xs text-muted-foreground sm:block">Using it makes your own copy. The template stays as it is.</p>
        <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
        <Button onClick={() => onUse(meta.id)}>
          Use this template <ArrowRight data-icon="inline-end" />
        </Button>
      </div>
    </>
  );
}

/**
 * For a step on a side branch that does not directly follow its parent (the
 * refused path of a gate listed after the happy path), the parent's number,
 * so "If refused" can say which step refused.
 */
export function branchParent(workflow: Workflow, steps: DescribedStep[], index: number): number | undefined {
  const step = steps[index];
  if (step === undefined || step.branch === undefined) return undefined;
  const source = workflow.edges.find((edge) => edge.target === step.nodeId)?.source;
  const parent = steps.findIndex((candidate) => candidate.nodeId === source);
  return parent < 0 || parent === index - 1 ? undefined : parent + 1;
}

export function StepItem({ step, index, from, last }: { step: DescribedStep; index: number; from: number | undefined; last: boolean }) {
  const trigger = step.def.kind === 'trigger';
  return (
    <li className="flex gap-3" style={{ paddingLeft: `${step.depth * 1.5}rem` }}>
      <div className="flex flex-col items-center">
        <ConnectorIcon connector={step.def.connector} size={13} />
        {last ? null : <span className="my-1 w-px flex-1 bg-border" aria-hidden />}
      </div>
      <div className={cn('min-w-0 flex-1', last ? '' : 'pb-4')}>
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
          {step.branch === undefined ? null : (
            <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', step.depth > 0 ? 'bg-warning/10 text-warning' : 'bg-muted text-muted-foreground')}>
              <CornerDownRight className="size-3" aria-hidden />
              {step.branch}
              {from === undefined ? null : ` at step ${from}`}
              <span aria-hidden>→</span>
            </span>
          )}
          <span className="font-medium">
            <span className="text-muted-foreground tabular-nums">{index + 1}.</span> {step.title}
          </span>
          <span className="text-xs text-muted-foreground">{trigger ? `· trigger in ${step.def.connector.name}` : `· ${step.def.connector.name}`}</span>
        </p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{step.sentence}</p>
      </div>
    </li>
  );
}

function NeededApps({ apps }: { apps: string[] }) {
  const connections = useStudio((state) => state.connections);
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Plug className="size-3.5" aria-hidden /> Apps to connect
        <HelpTip term="connection" />
      </p>
      {apps.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">None. Everything in it is built in.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {apps.map((id) => {
            const connector = getConnector(id);
            if (connector === undefined) return null;
            const connection = connections[id];
            return (
              <li key={id} className="flex items-center gap-2 text-[13px]">
                <ConnectorIcon connector={connector} size={12} />
                <span className="min-w-0 flex-1 truncate font-medium">{connector.name}</span>
                {connection === undefined ? (
                  <Link href={`/integrations?app=${encodeURIComponent(id)}`} className="shrink-0 text-xs font-medium text-primary hover:underline">
                    Connect
                  </Link>
                ) : (
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs text-success" title={`Connected as ${connection.account}`}>
                    <CheckCircle2 className="size-3.5" aria-hidden /> Connected
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function NeededAgents({ agents }: { agents: string[] }) {
  const signedIn = useSignedIn();
  if (agents.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Bot className="size-3.5" aria-hidden /> Coding agents to sign in
        <HelpTip term="subscription" />
      </p>
      <ul className="flex flex-col gap-1.5">
        {agents.map((id) => {
          const label = AGENT_OPTIONS.find((option) => option.value === id)?.label ?? id;
          const state = id === 'claude' || id === 'codex' ? signedIn[id] : undefined;
          return (
            <li key={id} className="flex items-center gap-2 text-[13px]">
              <span className="flex size-[22px] shrink-0 items-center justify-center rounded-lg border bg-muted/50">
                <Bot className="size-3 text-muted-foreground" aria-hidden />
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
              {state === true ? (
                <span className="inline-flex shrink-0 items-center gap-1 text-xs text-success">
                  <CheckCircle2 className="size-3.5" aria-hidden /> Signed in
                </span>
              ) : (
                <Link href="/settings" className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline">
                  {state === false ? null : <CircleDashed className="size-3" aria-hidden />}
                  {state === false ? 'Sign in' : 'Check'}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
