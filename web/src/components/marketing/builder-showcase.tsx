'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { ArrowRight, CheckCircle2, FileCode2, FlaskConical, Plug, ShieldAlert, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BorderBeam } from '@/components/21st/border-beam';
import { useBrand } from '@/hooks/use-brand';
import { getNodeType, type NodeTypeDef, type PortType } from '@/lib/connectors';
import { instantiateTemplate } from '@/lib/workflow/templates';
import { compileWorkflow } from '@/lib/workflow/compile';
import { validateWorkflow } from '@/lib/workflow/validate';
import type { Workflow } from '@/lib/workflow/schema';
import { cn } from '@/lib/utils';
import { AppTile, Reveal, SectionHeading, useCalmMotion } from './primitives';

const NODE_W = 220;
const NODE_H = 78;
// The template is laid out for a roomy canvas; pulling the columns together keeps text legible at landing-page scale.
const SQUEEZE = 0.88;
const PAD = 28;

const PORT_STROKE: Record<PortType, string> = {
  issue: 'stroke-sky-500',
  run: 'stroke-violet-500',
  change: 'stroke-indigo-500 dark:stroke-indigo-400',
  message: 'stroke-pink-500',
  event: 'stroke-zinc-400 dark:stroke-zinc-500',
  any: 'stroke-zinc-400 dark:stroke-zinc-500',
};

const PORT_FILL: Record<PortType, string> = {
  issue: 'fill-sky-500',
  run: 'fill-violet-500',
  change: 'fill-indigo-500 dark:fill-indigo-400',
  message: 'fill-pink-500',
  event: 'fill-zinc-400 dark:fill-zinc-500',
  any: 'fill-zinc-300 dark:fill-zinc-600',
};

const CAPABILITIES = [
  {
    icon: Plug,
    title: 'Typed ports',
    body: 'Blue carries a ticket, violet a finished run, indigo a pull request. The canvas refuses a wire whose colours do not fit.',
  },
  {
    icon: ShieldAlert,
    title: 'Validation as you edit',
    body: 'The same rules the CLI enforces: one trigger, read-only reviewers, and no unattended path to a merge.',
  },
  {
    icon: FlaskConical,
    title: 'Free test runs',
    body: 'Play the flow back with a sample ticket: phases, review rounds, budgets and refusals, simulated in your browser.',
  },
  { icon: FileCode2, title: 'Export that is real', body: 'Inspect the actual config and Actions workflow generated for this template.' },
];

/**
 * The builder, shown rather than described: the "Ticket to pull request"
 * template drawn as a static canvas, next to the exact files the compiler
 * writes for it. Both are generated from the live catalog and templates, so
 * the page cannot drift from what the studio does.
 */
export function BuilderShowcase() {
  const brand = useBrand();
  const reduce = useCalmMotion();
  const workflow = useMemo(() => instantiateTemplate('ticket-to-pr', brand), [brand]);
  const compiled = useMemo(() => (workflow === undefined ? undefined : compileWorkflow(workflow, brand)), [workflow, brand]);
  const validation = useMemo(() => (workflow === undefined ? undefined : validateWorkflow(workflow)), [workflow]);
  // The graph JSON carries generated ids and a timestamp, which would differ between server and client render.
  const files = useMemo(
    () => (compiled === undefined || workflow === undefined ? [] : compiled.files.filter((file) => !file.content.includes(workflow.id))),
    [compiled, workflow],
  );

  return (
    <section id="builder" className="scroll-mt-16 border-t bg-muted/20 py-16 sm:py-24">
      <div className="container max-w-6xl">
        <SectionHeading
          eyebrow="The studio"
          title="Drag the flow. Ship the config."
          description={`Design visually, try a simulated run, then export the config and GitHub Actions workflow. The preview below uses the same compiler as the studio.`}
        />

        <Reveal className="mt-10 sm:mt-12">
          <div className="relative overflow-hidden rounded-2xl border bg-card shadow-xl shadow-primary/5">
            <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-2.5">
              <div aria-hidden className="mr-1 flex gap-1.5">
                <span className="size-2.5 rounded-full bg-foreground/15" />
                <span className="size-2.5 rounded-full bg-foreground/15" />
                <span className="size-2.5 rounded-full bg-foreground/15" />
              </div>
              <p className="text-xs font-medium">{workflow?.name ?? 'Workflow'}</p>
              {validation === undefined ? null : validation.errors === 0 ? (
                <Badge variant="secondary" className="bg-success/10 text-[color-mix(in_oklch,var(--success)_75%,var(--foreground))] dark:text-success">
                  <CheckCircle2 data-icon="inline-start" />
                  Valid
                </Badge>
              ) : (
                <Badge variant="destructive">{validation.errors} errors</Badge>
              )}
              <p className="ml-auto text-xs text-muted-foreground">
                <span className="hidden sm:inline">{workflow?.nodes.length ?? 0} nodes, drawn from the template</span>
                <span className="sm:hidden">Scroll sideways</span>
              </p>
            </div>
            <div className="overflow-x-auto bg-grid" tabIndex={0} role="region" aria-label="Workflow canvas preview">
              {workflow === undefined ? null : <MiniCanvas workflow={workflow} />}
            </div>
            {reduce ? null : <BorderBeam size={120} duration={10} colorFrom="#8b5cf6" colorTo="#38bdf8" />}
          </div>
        </Reveal>

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-5">
          <Reveal className="lg:col-span-2">
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1">
              {CAPABILITIES.map(({ icon: Icon, title, body }) => (
                <li key={title} className="flex gap-3 rounded-xl border bg-card p-4">
                  <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary">
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{title}</p>
                    <p className="mt-0.5 text-sm leading-relaxed text-pretty text-muted-foreground">{body}</p>
                  </div>
                </li>
              ))}
            </ul>
            <Button className="mt-4" variant="outline" nativeButton={false} render={<Link href="/workflows" />}>
              Open the builder
              <ArrowRight data-icon="inline-end" />
            </Button>
          </Reveal>

          <Reveal delay={0.08} className="min-w-0 lg:col-span-3">
            {files.length === 0 ? null : (
              <Tabs defaultValue={files[0].path} className="h-full gap-0 overflow-hidden rounded-xl border bg-card">
                <div className="flex items-center gap-2 overflow-x-auto border-b bg-muted/40 px-2 py-2">
                  <TabsList className="h-8 bg-transparent">
                    {files.map((file) => (
                      <TabsTrigger key={file.path} value={file.path} className="px-2.5 font-mono text-xs">
                        {file.path.split('/').at(-1)}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </div>
                {files.map((file) => (
                  <TabsContent key={file.path} value={file.path} className="flex min-h-0 flex-col">
                    <p className="border-b px-4 py-2 text-xs text-muted-foreground">
                      <span className="font-mono text-foreground">{file.path}</span> · {file.description}
                    </p>
                    <pre
                      className="max-h-96 overflow-auto p-4 font-mono text-[12px] leading-relaxed text-foreground/85"
                      tabIndex={0}
                      aria-label={file.path}
                    >
                      {file.content}
                    </pre>
                  </TabsContent>
                ))}
              </Tabs>
            )}
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/** A one-line reading of a node's settings, so the preview says something specific. */
function summarize(def: NodeTypeDef, config: Record<string, unknown>): string {
  if (def.id === 'gates.action.budget') return `$${String(config['maxRunCostUsd'])} a run · $${String(config['maxDailyCostUsd'])} a day`;
  if (def.id === 'pipeline.action.run')
    return `${String(config['planner'])} + ${String(config['implementer'])}, ${String(config['review'])} review`;
  if (def.id === 'delivery.action.deliver') return config['draft'] === true ? 'Draft pull request' : 'Pull request';
  if (typeof config['channel'] === 'string') return String(config['channel']);
  if (typeof config['assignee'] === 'string') return `Assigned to ${String(config['assignee'])}`;
  return def.description;
}

function portY(count: number, index: number): number {
  return (NODE_H * (index + 1)) / (count + 1);
}

function MiniCanvas({ workflow }: { workflow: Workflow }) {
  const nodes = workflow.nodes
    .map((node) => ({ node, def: getNodeType(node.data.typeId) }))
    .filter((entry): entry is { node: (typeof workflow.nodes)[number]; def: NodeTypeDef } => entry.def !== undefined)
    .map(({ node, def }) => ({ node, def, x: node.position.x * SQUEEZE, y: node.position.y * SQUEEZE }));
  const byId = new Map(nodes.map((entry) => [entry.node.id, entry]));

  const minX = Math.min(...nodes.map((entry) => entry.x)) - PAD;
  const minY = Math.min(...nodes.map((entry) => entry.y)) - PAD;
  const width = Math.max(...nodes.map((entry) => entry.x)) + NODE_W + PAD - minX;
  const height = Math.max(...nodes.map((entry) => entry.y)) + NODE_H + PAD - minY;

  const edges = workflow.edges.flatMap((edge) => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) return [];
    const outIndex = Math.max(
      0,
      source.def.outputs.findIndex((port) => port.id === edge.sourceHandle),
    );
    const outPort = source.def.outputs[outIndex];
    const inPort = target.def.inputs.find((port) => port.id === edge.targetHandle) ?? target.def.inputs[0];
    const type: PortType = outPort !== undefined && outPort.type !== 'any' ? outPort.type : (inPort?.type ?? 'any');
    const sx = source.x + NODE_W;
    const sy = source.y + portY(source.def.outputs.length, outIndex);
    const tx = target.x;
    const ty = target.y + NODE_H / 2;
    const bend = Math.max(36, (tx - sx) / 2);
    return [{ id: edge.id, type, d: `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}` }];
  });

  return (
    <svg
      viewBox={`${minX} ${minY} ${width} ${height}`}
      className="block h-auto w-full min-w-[960px] lg:min-w-0"
      role="img"
      aria-label={`The ${workflow.name} workflow: ${nodes.map((entry) => entry.node.data.label ?? entry.def.name).join(', ')}`}
    >
      {edges.map((edge) => (
        <path
          key={edge.id}
          d={edge.d}
          fill="none"
          strokeWidth={1.75}
          strokeLinecap="round"
          className={cn(PORT_STROKE[edge.type], 'opacity-80')}
        />
      ))}
      {nodes.map(({ node, def, x, y }) => (
        <g key={node.id}>
          <foreignObject x={x} y={y} width={NODE_W} height={NODE_H} className="overflow-visible">
            <div className="relative flex h-full items-start gap-2.5 overflow-hidden rounded-xl border bg-card p-3 shadow-sm">
              <div className="absolute inset-x-3 top-0 h-0.5 rounded-b-full opacity-70" style={{ background: def.connector.icon.color }} />
              <AppTile connector={def.connector} size={15} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  {def.kind === 'trigger' ? <Zap className="size-2.5 fill-current text-warning" /> : null}
                  <span className="truncate">{def.connector.name}</span>
                </p>
                <p className="truncate text-[13px] leading-snug font-semibold">{node.data.label ?? def.name}</p>
                <p className="truncate text-xs text-muted-foreground">{summarize(def, node.data.config)}</p>
              </div>
            </div>
          </foreignObject>
          {def.inputs.length > 0 ? (
            <circle cx={x} cy={y + NODE_H / 2} r={5} className={cn(PORT_FILL[def.inputs[0].type], 'stroke-card')} strokeWidth={2.5} />
          ) : null}
          {def.outputs.map((port, index) => (
            <circle
              key={port.id}
              cx={x + NODE_W}
              cy={y + portY(def.outputs.length, index)}
              r={5}
              className={cn(PORT_FILL[port.type], 'stroke-card')}
              strokeWidth={2.5}
            />
          ))}
        </g>
      ))}
    </svg>
  );
}
