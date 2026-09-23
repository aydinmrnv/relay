'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { useCalmMotion } from '@/components/motion/use-calm-motion';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { PORT_LEGEND, PORT_STYLE } from '@/components/builder/ports';
import { getNodeType, nodeTypeId, type NodeTypeDef, type PortType } from '@/lib/connectors';
import { cn } from '@/lib/utils';

/**
 * A small, static picture of a real workflow — trigger → budget gate →
 * pipeline → delivery → Slack — built from the live catalog, so the names and
 * port colours here are exactly the ones the canvas draws.
 */

interface Step {
  typeId: string;
  kicker: string;
  /** What this example has configured, in a few words. */
  setting: string;
  explain: React.ReactNode;
}

const STEPS: Step[] = [
  {
    typeId: nodeTypeId('linear', 'trigger', 'issue-assigned'),
    kicker: 'Trigger',
    setting: 'Assignee: @bot',
    explain: 'Something happened: a Linear issue was assigned to the bot. Every workflow has exactly one trigger, and it only has outputs. This one hands on a ticket.',
  },
  {
    typeId: nodeTypeId('gates', 'action', 'budget'),
    kicker: 'Guardrail',
    setting: '$6 a run · $40 a day',
    explain: 'Checks the spending ceilings before any agent starts. It has two outputs: the ticket carries on through Within budget, and Refused can be wired to a message so people learn why nothing happened.',
  },
  {
    typeId: nodeTypeId('pipeline', 'action', 'run'),
    kicker: 'Agents',
    setting: 'Standard review',
    explain: 'Plans, reviews, implements, reviews again and runs the tests, in its own worktree. It only accepts a ticket, and hands on a finished run.',
  },
  {
    typeId: nodeTypeId('delivery', 'action', 'deliver'),
    kicker: 'Delivery',
    setting: 'Draft pull request',
    explain: 'Turns the run into a change: here a draft pull request. A run somebody else started may never merge on its own; the validator refuses that wiring.',
  },
  {
    typeId: nodeTypeId('slack', 'action', 'share-pr'),
    kicker: 'Notify',
    setting: '#eng',
    explain: 'Tells the team. It accepts a change, so it can only be wired after delivery. Any of the catalog’s apps can sit at the end of a workflow like this.',
  },
];

/** What each port colour carries, in plain words. */
const PORT_MEANING: Record<PortType, string> = {
  issue: 'An issue with a title and a body, from a tracker, a chat message or an error report.',
  run: 'A finished pipeline run: status, cost, phases, diff and tests.',
  change: 'A branch or a pull request that delivery produced.',
  message: 'Text meant for a person.',
  event: 'A plain “this happened”, with nothing to work on. Refusals are events.',
  any: 'Accepts whatever it is given. Gates use it so they can sit anywhere.',
};

export function WorkflowAnatomy() {
  const steps = STEPS.map((step) => ({ step, def: getNodeType(step.typeId) })).filter((entry): entry is { step: Step; def: NodeTypeDef } => entry.def !== undefined);

  return (
    <div className="grid grid-cols-1 gap-6">
      <figure className="relative overflow-hidden rounded-2xl border bg-muted/30">
        {/* The canvas's dotted background, so the picture reads as "this is the builder". */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-60 [background-image:radial-gradient(var(--color-border)_1px,transparent_1px)] [background-size:16px_16px] dark:opacity-40"
        />
        <div className="relative overflow-x-auto">
          <ol className="flex min-w-[660px] items-center px-5 pt-8 pb-7" aria-label="An example workflow, left to right">
            {steps.map(({ step, def }, index) => (
              <li key={step.typeId} className="contents">
                {index > 0 ? <Edge type={steps[index - 1]!.def.outputs[0]?.type ?? 'event'} index={index} /> : null}
                <MiniNode def={def} kicker={step.kicker} setting={step.setting} number={index + 1} />
              </li>
            ))}
          </ol>
        </div>
        <figcaption className="relative border-t bg-background/60 px-5 py-2.5 text-xs text-muted-foreground">
          Shaped like the <span className="font-medium text-foreground">Ticket to pull request</span> template, trimmed to five nodes. The numbers match the notes below.
          <span className="ml-1 sm:hidden">Scroll sideways to see all of it.</span>
        </figcaption>
      </figure>

      <ol className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        {steps.map(({ step, def }, index) => (
          <li key={step.typeId} className="flex gap-3">
            <Callout n={index + 1} />
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {def.name} <span className="font-normal text-muted-foreground">· {step.kicker.toLowerCase()}</span>
              </p>
              <p className="mt-0.5 text-sm text-pretty text-muted-foreground">{step.explain}</p>
            </div>
          </li>
        ))}
        <li className="flex gap-3 sm:col-span-2">
          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold text-muted-foreground">?</span>
          <p className="text-sm text-pretty text-muted-foreground">
            The same rules apply to every node in the palette: inputs on the left, outputs on the right, and a wire only where the colours fit. Open any template in the{' '}
            <Link href="/templates" className="font-medium text-foreground underline-offset-4 hover:underline">
              template gallery
            </Link>{' '}
            to see a complete one.
          </p>
        </li>
      </ol>

      <div className="rounded-xl border p-4">
        <p className="text-sm font-medium">Port colours</p>
        <p className="mt-0.5 text-sm text-muted-foreground">The dots on each node are typed. A wire is allowed when both ends are the same colour, or either end is light grey.</p>
        <ul className="mt-3 grid gap-2.5 sm:grid-cols-2">
          {PORT_LEGEND.map((type) => (
            <li key={type} className="flex items-start gap-2.5 text-sm">
              <span className={cn('mt-1 size-2.5 shrink-0 rounded-full ring-2 ring-background', PORT_STYLE[type].dot)} aria-hidden />
              <span>
                <span className="font-medium">{capitalise(PORT_STYLE[type].label)}</span>
                <span className="text-muted-foreground"> — {PORT_MEANING[type]}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function MiniNode({ def, kicker, setting, number }: { def: NodeTypeDef; kicker: string; setting: string; number: number }) {
  // The first output continues the line; any others (a gate's Refused) sit on
  // their own row at the bottom, the way the canvas stacks extra outputs.
  const [main, ...extra] = def.outputs;
  return (
    <div className="relative w-[7.5rem] shrink-0 rounded-xl border bg-card shadow-sm">
      <span className="absolute -top-2.5 -left-2.5 z-10">
        <Callout n={number} />
      </span>
      {def.inputs.map((port) => (
        <Dot key={port.id} type={port.type} className="top-1/2 -left-[5.5px] -translate-y-1/2" title={`Takes in ${PORT_STYLE[port.type].noun}`} />
      ))}
      {main === undefined ? null : (
        <Dot type={main.type} className="top-1/2 -right-[5.5px] -translate-y-1/2" title={`${extra.length > 0 ? `${main.label}: hands` : 'Hands'} on ${PORT_STYLE[main.type].noun}`} />
      )}
      <div className="grid gap-1 p-2.5">
        <div className="flex items-center gap-1.5">
          <ConnectorIcon connector={def.connector} size={10} />
          <span className="truncate text-[9px] font-medium tracking-wide text-muted-foreground uppercase">{kicker}</span>
        </div>
        <p className="text-xs leading-tight font-medium">{def.name}</p>
        <p className="truncate text-[10px] text-muted-foreground">{setting}</p>
      </div>
      {extra.map((port) => (
        <div key={port.id} className="relative flex items-center justify-end border-t px-2.5 py-1 text-[10px] text-muted-foreground">
          {port.label}
          <Dot type={port.type} className="top-1/2 -right-[5.5px] -translate-y-1/2" title={`${port.label}: hands on ${PORT_STYLE[port.type].noun}`} />
        </div>
      ))}
    </div>
  );
}

/** A wire between two nodes, in the colour of what it carries, with a dot travelling along it. */
function Edge({ type, index }: { type: PortType; index: number }) {
  const reduce = useCalmMotion();
  return (
    <div className="relative mx-1 h-0.5 min-w-5 flex-1 self-center" aria-hidden>
      <div className={cn('absolute inset-0 rounded-full opacity-60', PORT_STYLE[type].dot)} />
      {reduce ? null : (
        <motion.span
          className={cn('absolute top-1/2 size-1.5 -translate-y-1/2 rounded-full', PORT_STYLE[type].dot)}
          initial={{ left: '0%', opacity: 0 }}
          animate={{ left: ['0%', '100%'], opacity: [0, 1, 1, 0] }}
          transition={{ duration: 1.4, ease: 'easeInOut', repeat: Infinity, repeatDelay: 2.2, delay: index * 0.45 }}
        />
      )}
    </div>
  );
}

function Dot({ type, className, title }: { type: PortType; className?: string; title: string }) {
  return <span title={title} className={cn('absolute size-2.5 rounded-full ring-2 ring-card', PORT_STYLE[type].dot, className)} />;
}

function Callout({ n }: { n: number }) {
  return <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground shadow-sm">{n}</span>;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
