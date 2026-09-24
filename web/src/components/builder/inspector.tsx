'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, Braces, CircleAlert, Copy, CornerDownRight, Info, Plug, Trash2, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { HelpTip } from '@/components/app/help-tip';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { AgentStatusStrip } from '@/components/agents/agent-status-strip';
import { useAgentsStore } from '@/hooks/use-agent-accounts';
import { getConnector, getNodeType, type FieldSpec, type NodeTypeDef } from '@/lib/connectors';
import { VARIABLE_HINTS } from '@/lib/workflow/template';
import { describeNode, describeWorkflow } from '@/lib/workflow/describe';
import { useStudio } from '@/lib/store';
import type { Term } from '@/lib/glossary';
import type { ValidationIssue } from '@/lib/workflow/validate';
import type { Run, Workflow } from '@/lib/workflow/schema';
import { cn } from '@/lib/utils';
import { PORT_LEGEND, PORT_STYLE } from './ports';
import type { CanvasNode } from './types';

interface Props {
  node: CanvasNode | null;
  workflow: Workflow;
  issues: ValidationIssue[];
  run: Run | null;
  onChange: (nodeId: string, patch: { label?: string | null; config?: Record<string, unknown> }) => void;
  onDelete: (nodeId: string) => void;
  onDuplicate: (nodeId: string) => void;
  onSelect: (nodeId: string) => void;
}

/** Glossary entries that explain a node type, and a few fields, in more depth than their one-line description. */
const NODE_TERMS: Record<string, Term> = {
  'pipeline.action.run': 'pipeline',
  'pipeline.action.fast': 'pipeline',
  'gates.action.budget': 'budget',
  'gates.action.allowlist': 'allowlist',
  'gates.action.approval': 'approval',
  'gates.action.kill-switch': 'kill-switch',
  'delivery.action.deliver': 'delivery',
};
const FIELD_TERMS: Record<string, Term> = { review: 'review-level', planner: 'roles', planReviewer: 'roles', implementer: 'roles', codeReviewer: 'roles', policy: 'delivery' };

export function Inspector(props: Props) {
  if (props.node === null) return <WorkflowPanel workflow={props.workflow} issues={props.issues} onSelect={props.onSelect} />;
  return <NodePanel {...props} node={props.node} />;
}

/* ------------------------------------------------------------------ */
/* Nothing selected: the workflow as a whole                            */
/* ------------------------------------------------------------------ */

function WorkflowPanel({ workflow, issues, onSelect }: { workflow: Workflow; issues: ValidationIssue[]; onSelect: (nodeId: string) => void }) {
  const updateWorkflowMeta = useStudio((state) => state.updateWorkflowMeta);
  const connections = useStudio((state) => state.connections);
  const agentStatus = useAgentsStore((state) => state.status);
  const description = useMemo(() => describeWorkflow(workflow), [workflow]);
  const errors = issues.filter((issue) => issue.level === 'error');
  const warnings = issues.filter((issue) => issue.level === 'warning');

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-4">
        <section className="grid gap-3">
          <PanelTitle icon={<Info className="size-3.5" />} title="This workflow" term="workflow" />
          <div className="grid gap-1.5">
            <Label htmlFor="wf-description" className="text-xs">
              Description
            </Label>
            <Textarea
              id="wf-description"
              value={workflow.description}
              placeholder="What is this workflow for? Your future self will thank you."
              onChange={(event) => updateWorkflowMeta(workflow.id, { description: event.target.value })}
              className="min-h-16 text-sm"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="wf-repo" className="flex items-center gap-1 text-xs">
              Repository <HelpTip title="Repository">The GitHub repository the agents work in and the export is meant for, as owner/name. Test runs use it for branch names and pull request links.</HelpTip>
            </Label>
            <Input id="wf-repo" value={workflow.repository ?? ''} placeholder="owner/repo" onChange={(event) => updateWorkflowMeta(workflow.id, { repository: event.target.value })} className="h-8 font-mono text-sm" />
          </div>
        </section>

        <section className="grid gap-2">
          <PanelTitle title="What it does" hint="Read top to bottom. Click a step to edit it." />
          {description.steps.length === 0 ? (
            <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">Nothing yet. Add a trigger — the thing that starts this workflow — from the left, or press A on the canvas.</p>
          ) : (
            <ol className="grid gap-1">
              {description.steps.map((step, index) => (
                <li key={step.nodeId} style={{ paddingLeft: step.depth * 14 }}>
                  <button type="button" onClick={() => onSelect(step.nodeId)} className="group flex w-full gap-2.5 rounded-lg p-2 text-left transition-colors hover:bg-muted">
                    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border bg-background text-[10px] font-medium text-muted-foreground tabular-nums">
                      {step.def.kind === 'trigger' ? <Zap className="size-2.5 fill-amber-400 text-amber-500" /> : index}
                    </span>
                    <span className="min-w-0 flex-1">
                      {step.branch === undefined ? null : (
                        <span className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                          <CornerDownRight className="size-3" /> {step.branch}
                        </span>
                      )}
                      <span className="flex items-center gap-1.5 text-[13px] font-medium">
                        <ConnectorIcon connector={step.def.connector} size={10} variant="mark" />
                        <span className="truncate">{step.title}</span>
                      </span>
                      <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{step.sentence}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
          {description.unreachable.length > 0 ? (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-xs">
              <p className="font-medium">Not connected to the trigger, so these never run:</p>
              <ul className="mt-1 grid gap-0.5">
                {description.unreachable.map((step) => (
                  <li key={step.nodeId}>
                    <button type="button" className="underline-offset-2 hover:underline" onClick={() => onSelect(step.nodeId)}>
                      {step.title}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>

        {description.apps.length > 0 || description.agents.length > 0 ? (
          <section className="grid gap-2">
            <PanelTitle title="What it needs" hint="Test runs work without these; a real run does not." />
            <ul className="grid gap-1 text-xs">
              {description.apps.map((id) => {
                const connector = getConnector(id);
                if (connector === undefined) return null;
                const ok = connections[id] !== undefined || connector.auth === 'none';
                return (
                  <li key={id} className="flex items-center gap-2 rounded-md border px-2 py-1.5">
                    <ConnectorIcon connector={connector} size={11} />
                    <span className="flex-1 truncate">{connector.name}</span>
                    {ok ? (
                      <span className="text-success">connected</span>
                    ) : (
                      <Link href={`/integrations?app=${id}`} className="flex items-center gap-1 font-medium text-primary hover:underline">
                        <Plug className="size-3" /> connect
                      </Link>
                    )}
                  </li>
                );
              })}
              {description.agents.map((agent) => {
                const account = agentStatus?.agents[agent as 'claude' | 'codex'];
                const name = agent === 'claude' ? 'Claude Code' : agent === 'codex' ? 'Codex' : agent;
                return (
                  <li key={agent} className="flex items-center gap-2 rounded-md border px-2 py-1.5">
                    <span className={cn('size-1.5 rounded-full', account?.loggedIn === true ? 'bg-success' : account === undefined ? 'bg-muted-foreground/40' : 'bg-warning')} />
                    <span className="flex-1 truncate">{name}</span>
                    {account?.loggedIn === true ? (
                      <span className="text-success">signed in</span>
                    ) : account === undefined ? (
                      <span className="text-muted-foreground">unknown</span>
                    ) : (
                      <Link href="/settings#agents" className="font-medium text-primary hover:underline">
                        sign in
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        <section className="grid gap-2">
          <PanelTitle title="Checks" term="validation" />
          {errors.length === 0 && warnings.length === 0 ? (
            <p className="rounded-lg border bg-success/5 p-2.5 text-xs text-success">No problems. This workflow can be test-run and exported.</p>
          ) : (
            <ul className="grid gap-1.5">
              {[...errors, ...warnings].map((issue, index) => (
                <IssueRow key={index} issue={issue} onSelect={onSelect} />
              ))}
            </ul>
          )}
        </section>

        <section className="grid gap-2 rounded-lg border bg-muted/30 p-3">
          <PanelTitle title="Port colours" term="port" />
          <ul className="grid grid-cols-2 gap-1.5 text-xs">
            {PORT_LEGEND.map((type) => (
              <li key={type} className="flex items-center gap-1.5">
                <span className={cn('size-2.5 rounded-full ring-2 ring-card', PORT_STYLE[type].dot)} />
                {PORT_STYLE[type].label}
              </li>
            ))}
          </ul>
          <p className="text-[11px] leading-snug text-muted-foreground">A connection is allowed when the colours match or either end takes anything. Drag from a port onto empty canvas to add the next step already connected.</p>
        </section>
      </div>
    </ScrollArea>
  );
}

function IssueRow({ issue, onSelect }: { issue: ValidationIssue; onSelect: (nodeId: string) => void }) {
  const error = issue.level === 'error';
  const body = (
    <>
      <span className="flex items-start gap-1.5 font-medium">
        {error ? <CircleAlert className="mt-px size-3.5 shrink-0" /> : <AlertTriangle className="mt-px size-3.5 shrink-0" />}
        {issue.message}
      </span>
      {issue.hint === undefined ? null : <span className="mt-0.5 block pl-5 opacity-80">{issue.hint}</span>}
    </>
  );
  const cls = cn('block w-full rounded-lg border p-2.5 text-left text-xs', error ? 'border-destructive/40 bg-destructive/8 text-destructive' : 'border-warning/40 bg-warning/10 text-amber-800 dark:text-warning');
  return (
    <li>
      {issue.nodeId === undefined ? (
        <div className={cls}>{body}</div>
      ) : (
        <button type="button" className={cn(cls, 'transition-opacity hover:opacity-80')} onClick={() => onSelect(issue.nodeId!)}>
          {body}
        </button>
      )}
    </li>
  );
}

function PanelTitle({ title, hint, term, icon }: { title: string; hint?: string; term?: Term; icon?: React.ReactNode }) {
  return (
    <div>
      <p className="flex items-center gap-1.5 text-xs font-semibold">
        {icon}
        {title}
        {term === undefined ? null : <HelpTip term={term} />}
      </p>
      {hint === undefined ? null : <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* A node is selected                                                   */
/* ------------------------------------------------------------------ */

function NodePanel({ node, issues, run, onChange, onDelete, onDuplicate }: Props & { node: CanvasNode }) {
  const connections = useStudio((state) => state.connections);
  const def = getNodeType(node.data.typeId);
  const sentence = useMemo(() => describeNode({ id: node.id, type: 'wf', position: node.position, data: node.data }), [node.id, node.position, node.data]);

  if (def === undefined) {
    return (
      <div className="p-4 text-sm">
        <p className="font-medium text-destructive">Unknown node type</p>
        <p className="mt-1 text-xs text-muted-foreground">{node.data.typeId} is not in the catalog any more. Delete it and add the node again from the palette.</p>
        <Button variant="destructive" size="sm" className="mt-3" onClick={() => onDelete(node.id)}>
          <Trash2 data-icon="inline-start" /> Delete
        </Button>
      </div>
    );
  }

  const nodeIssues = issues.filter((issue) => issue.nodeId === node.id);
  const connected = connections[def.connectorId] !== undefined || def.connector.category === 'core' || def.connector.auth === 'none';
  const term = NODE_TERMS[def.id];
  const events = run === null ? [] : run.events.filter((event) => event.nodeId === node.id);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-3 border-b p-4">
        <ConnectorIcon connector={def.connector} size={18} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            {def.kind === 'trigger' ? <Zap className="size-2.5 fill-amber-400 text-amber-500" /> : null}
            {def.connector.name} · {def.kind}
          </p>
          <p className="flex items-center gap-1.5 text-sm leading-tight font-semibold">
            {def.name}
            {term === undefined ? null : <HelpTip term={term} detailed />}
          </p>
          <p className="mt-1 text-xs leading-snug text-muted-foreground">{def.description}</p>
        </div>
      </div>

      <Tabs defaultValue="settings" className="min-h-0 flex-1 gap-0">
        <TabsList variant="line" className="w-full justify-start border-b px-3">
          <TabsTrigger value="settings" className="text-xs">
            Settings
          </TabsTrigger>
          <TabsTrigger value="about" className="text-xs">
            How it works
          </TabsTrigger>
          <TabsTrigger value="run" className="text-xs">
            Last run {events.length > 0 ? <span className="ml-1 text-muted-foreground tabular-nums">{events.length}</span> : null}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="settings" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <div className="flex flex-col gap-4 p-4">
              {!connected ? (
                <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-xs">
                  <Plug className="mt-0.5 size-3.5 shrink-0" />
                  <p>
                    {def.connector.name} isn’t connected. Test runs still work; connect it before a real run.{' '}
                    <Link href={`/integrations?app=${def.connectorId}`} className="font-medium underline underline-offset-2">
                      Connect {def.connector.name}
                    </Link>
                  </p>
                </div>
              ) : null}

              {nodeIssues.length > 0 ? (
                <ul className="flex flex-col gap-1.5">
                  {nodeIssues.map((issue, index) => (
                    <IssueRow key={index} issue={issue} onSelect={() => undefined} />
                  ))}
                </ul>
              ) : null}

              <div className="grid gap-1.5">
                <Label htmlFor="node-label" className="text-xs">
                  Name on the canvas
                </Label>
                <Input id="node-label" value={node.data.label ?? ''} placeholder={def.name} onChange={(event) => onChange(node.id, { label: event.target.value.length === 0 ? null : event.target.value })} className="h-8 text-sm" />
              </div>

              {def.connectorId === 'pipeline' && def.specId !== 'estimate' ? (
                <AgentStatusStrip used={['planner', 'planReviewer', 'implementer', 'codeReviewer'].map((role) => String(node.data.config[role] ?? '')).filter(Boolean)} />
              ) : null}

              {def.fields.length > 0 ? (
                <div className="grid gap-3.5">
                  {def.fields.map((field) => (
                    <FieldControl key={field.key} field={field} value={node.data.config[field.key]} onChange={(value) => onChange(node.id, { config: { ...node.data.config, [field.key]: value } })} />
                  ))}
                </div>
              ) : (
                <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">This node has nothing to configure. It works as soon as it is connected.</p>
              )}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="about" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <AboutNode def={def} sentence={sentence} />
          </ScrollArea>
        </TabsContent>

        <TabsContent value="run" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <div className="p-4">
              {events.length === 0 ? (
                <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                  {run === null ? 'No test run yet. Press Test run and this tab shows what this node did.' : 'The last test run did not reach this node.'}
                </p>
              ) : (
                <ol className="grid gap-2">
                  {events.map((event, index) => (
                    <li key={index} className="rounded-lg border p-2.5 text-xs">
                      <p className="flex items-center justify-between gap-2">
                        <span className="font-medium">{event.message}</span>
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{new Date(event.at).toLocaleTimeString()}</span>
                      </p>
                      {event.detail === undefined ? null : <pre className="mt-1.5 max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-[10px] whitespace-pre-wrap">{event.detail}</pre>}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>

      <div className="flex items-center gap-2 border-t p-3">
        <Button variant="outline" size="sm" onClick={() => onDuplicate(node.id)}>
          <Copy data-icon="inline-start" /> Duplicate
        </Button>
        <Button variant="destructive" size="sm" className="ml-auto" onClick={() => onDelete(node.id)}>
          <Trash2 data-icon="inline-start" /> Delete
        </Button>
      </div>
    </div>
  );
}

function AboutNode({ def, sentence }: { def: NodeTypeDef; sentence: string | undefined }) {
  return (
    <div className="flex flex-col gap-4 p-4 text-sm">
      {sentence === undefined ? null : (
        <div className="rounded-lg border bg-muted/30 p-3">
          <p className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">With these settings</p>
          <p className="mt-1 text-[13px] leading-relaxed">{sentence}</p>
        </div>
      )}
      <div className="grid gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold">
          In and out <HelpTip term="port" />
        </p>
        {def.inputs.length === 0 ? (
          <p className="text-xs text-muted-foreground">{def.kind === 'trigger' ? 'Nothing comes in: a trigger is where a workflow starts.' : 'Takes nothing in.'}</p>
        ) : (
          def.inputs.map((port) => (
            <p key={port.id} className="flex items-center gap-2 text-xs">
              <span className={cn('size-2.5 rounded-full', PORT_STYLE[port.type].dot)} /> Takes in {PORT_STYLE[port.type].noun}
            </p>
          ))
        )}
        {def.outputs.map((port) => (
          <p key={port.id} className="flex items-center gap-2 text-xs">
            <span className={cn('size-2.5 rounded-full', PORT_STYLE[port.type].dot)} /> <ArrowRight className="size-3 text-muted-foreground" />
            {def.outputs.length > 1 ? <span className="font-medium">{port.label}:</span> : null} hands on {PORT_STYLE[port.type].noun}
          </p>
        ))}
        {def.outputs.length === 0 ? <p className="text-xs text-muted-foreground">Hands nothing on; the workflow ends here.</p> : null}
      </div>
      {def.sample !== undefined ? (
        <div className="grid gap-1.5">
          <p className="text-xs font-semibold">What the trigger hands on</p>
          <p className="text-[11px] text-muted-foreground">An example payload. Use its fields in text boxes as variables, e.g. {'{{issue.title}}'}.</p>
          <pre className="max-h-56 overflow-auto rounded-lg bg-muted p-2.5 font-mono text-[11px]">{JSON.stringify(def.sample, null, 2)}</pre>
        </div>
      ) : null}
      {def.connector.docsUrl === undefined ? null : (
        <a href={def.connector.docsUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-primary hover:underline">
          {def.connector.name} documentation →
        </a>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Fields                                                               */
/* ------------------------------------------------------------------ */

function FieldControl({ field, value, onChange }: { field: FieldSpec; value: unknown; onChange: (value: unknown) => void }) {
  const id = `field-${field.key}`;
  const term = FIELD_TERMS[field.key];
  const label = (
    <Label htmlFor={id} className="flex items-center gap-1 text-xs">
      {field.label}
      {field.required === true ? <span className="text-destructive" aria-label="required">*</span> : null}
      {term === undefined ? null : <HelpTip term={term} />}
    </Label>
  );
  const help = field.help !== undefined ? <p className="text-[11px] leading-snug text-muted-foreground">{field.help}</p> : null;

  switch (field.type) {
    case 'boolean':
      return (
        <div className="flex items-start justify-between gap-3 rounded-lg border p-2.5">
          <div className="grid gap-0.5">
            {label}
            {help}
          </div>
          <Switch id={id} checked={value === true} onCheckedChange={(checked) => onChange(checked)} />
        </div>
      );
    case 'select': {
      const current = typeof value === 'string' ? value : field.default === undefined ? null : String(field.default);
      const selected = field.options?.find((option) => option.value === current);
      return (
        <div className="grid gap-1.5">
          {label}
          <Select value={current} onValueChange={(next) => onChange(next)} items={(field.options ?? []).map((option) => ({ value: option.value, label: option.label }))}>
            <SelectTrigger id={id} className="w-full" size="sm">
              <SelectValue placeholder="Choose…" />
            </SelectTrigger>
            <SelectContent>
              {(field.options ?? []).map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  <div className="flex flex-col">
                    <span>{option.label}</span>
                    {option.description !== undefined ? <span className="text-[11px] text-muted-foreground">{option.description}</span> : null}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selected?.description !== undefined ? <p className="text-[11px] leading-snug text-muted-foreground">{selected.description}</p> : help}
        </div>
      );
    }
    case 'multiselect': {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="grid gap-1.5">
          {label}
          <div className="grid gap-1 rounded-lg border p-2">
            {(field.options ?? []).map((option) => (
              <label key={option.value} className="flex items-center gap-2 text-xs">
                <Checkbox checked={selected.includes(option.value)} onCheckedChange={(checked) => onChange(checked ? [...selected, option.value] : selected.filter((item) => item !== option.value))} />
                {option.label}
              </label>
            ))}
          </div>
          {help}
        </div>
      );
    }
    case 'number':
      return (
        <div className="grid gap-1.5">
          {label}
          <Input
            id={id}
            type="number"
            inputMode="decimal"
            value={value === undefined || value === null ? '' : String(value)}
            min={field.min}
            max={field.max}
            step={field.step}
            placeholder={field.placeholder}
            onChange={(event) => onChange(event.target.value === '' ? '' : Number(event.target.value))}
            className="h-8 text-sm tabular-nums"
          />
          {help}
        </div>
      );
    case 'textarea':
    case 'json':
      return (
        <div className="grid gap-1.5">
          {label}
          <Textarea
            id={id}
            value={typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2)}
            placeholder={field.placeholder}
            onChange={(event) => onChange(event.target.value)}
            className={cn('min-h-20 text-sm', field.type === 'json' ? 'font-mono text-xs' : '')}
          />
          {help}
        </div>
      );
    case 'template':
      return <TemplateField id={id} label={label} help={help} field={field} value={typeof value === 'string' ? value : ''} onChange={onChange} />;
    case 'secret':
      return (
        <div className="grid gap-1.5">
          {label}
          <Input id={id} type="password" autoComplete="off" value={typeof value === 'string' ? value : ''} placeholder={field.placeholder ?? '••••••••'} onChange={(event) => onChange(event.target.value)} className="h-8 text-sm" />
          <p className="text-[11px] text-muted-foreground">Stays in this browser. The export refers to it by secret name, never by value.</p>
        </div>
      );
    default:
      return (
        <div className="grid gap-1.5">
          {label}
          <Input id={id} value={typeof value === 'string' ? value : value === undefined ? '' : String(value)} placeholder={field.placeholder} onChange={(event) => onChange(event.target.value)} className="h-8 text-sm" />
          {help}
        </div>
      );
  }
}

function TemplateField({ id, label, help, field, value, onChange }: { id: string; label: React.ReactNode; help: React.ReactNode; field: FieldSpec; value: string; onChange: (value: unknown) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between">
        {label}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger render={<Button variant="ghost" size="xs" />}>
            <Braces data-icon="inline-start" /> Insert variable
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 p-2">
            <p className="px-1 pb-1 text-[11px] text-muted-foreground">Filled in when the workflow runs.</p>
            <ScrollArea className="h-64">
              {VARIABLE_HINTS.map((group) => (
                <div key={group.group} className="mb-2">
                  <p className="px-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{group.group}</p>
                  {group.variables.map((variable) => (
                    <button
                      key={variable.path}
                      type="button"
                      className="flex w-full flex-col items-start rounded-md px-1.5 py-1 text-left hover:bg-muted"
                      onClick={() => {
                        onChange(`${value}${value.length > 0 && !value.endsWith(' ') && !value.endsWith('\n') ? ' ' : ''}{{${variable.path}}}`);
                        setOpen(false);
                      }}
                    >
                      <span className="font-mono text-xs">{`{{${variable.path}}}`}</span>
                      <span className="text-[11px] text-muted-foreground">{variable.description}</span>
                    </button>
                  ))}
                </div>
              ))}
            </ScrollArea>
          </PopoverContent>
        </Popover>
      </div>
      <Textarea id={id} value={value} placeholder={field.placeholder} onChange={(event) => onChange(event.target.value)} className="min-h-20 font-mono text-xs" />
      {help}
    </div>
  );
}
