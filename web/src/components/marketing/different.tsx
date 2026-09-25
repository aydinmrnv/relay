'use client';

import { Check, Minus, X } from 'lucide-react';
import { useBrand } from '@/hooks/use-brand';
import { cn } from '@/lib/utils';
import { Reveal, SectionHeading } from './primitives';

type Mark = 'yes' | 'no' | 'partial';

/**
 * What sets the product apart, against the two kinds of tool people reach
 * for today rather than named products, whose details change monthly. Every
 * "yes" in our column is something the studio does now, not a plan.
 */
export function Different() {
  const brand = useBrand();

  const highlights = [
    {
      title: 'Describe it, get a workflow',
      body: 'Type one sentence — “when a Sentry error is new, fix it under $3 and ping Discord” — and watch the graph build itself. It runs in your browser: no model call, no credits, nothing leaves the page.',
    },
    {
      title: 'A spend forecast before the first run',
      body: 'Hundreds of simulated runs of your exact graph give a typical cost, a bad-day cost, a monthly bill at your ticket volume, and how often your budget gate will say no.',
    },
    {
      title: 'Share it, remix it, badge it',
      body: 'Publish a workflow at a public link with secrets stripped. Anyone can remix it into their own studio, and a README badge points people to it.',
    },
    {
      title: 'Version history with one-click restore',
      body: 'A snapshot before every editing session, named versions when you want them, and a restore you can undo.',
    },
  ];

  const rows: Array<{ label: string; ours: Mark; agents: Mark; canvases: Mark; note?: string }> = [
    { label: 'Two vendors’ agents review each other’s plan and diff', ours: 'yes', agents: 'no', canvases: 'no' },
    { label: 'Runs on the Claude and ChatGPT plans you already pay for', ours: 'yes', agents: 'partial', canvases: 'no', note: 'Hosted agents usually bill seats or credits of their own; canvases call APIs per key.' },
    { label: 'Your code stays on your machine or your own CI runner', ours: 'yes', agents: 'no', canvases: 'partial' },
    { label: 'Forecast what a workflow will cost before it runs', ours: 'yes', agents: 'no', canvases: 'no' },
    { label: 'Build a workflow from a sentence without spending AI credits', ours: 'yes', agents: 'no', canvases: 'partial' },
    { label: 'Guardrails that refuse by default: budgets, allowlists, approval', ours: 'yes', agents: 'partial', canvases: 'partial' },
    { label: 'Unattended runs can never merge on their own', ours: 'yes', agents: 'partial', canvases: 'no' },
    { label: 'Exports to plain files you own: a config and a GitHub Actions workflow', ours: 'yes', agents: 'no', canvases: 'partial' },
    { label: 'Public share links that anyone can remix', ours: 'yes', agents: 'no', canvases: 'partial' },
  ];

  return (
    <section id="different" className="scroll-mt-20 border-t py-16 sm:py-24">
      <div className="container max-w-6xl">
        <SectionHeading
          eyebrow="What’s different"
          title={`What ${brand.name} does that others don’t`}
          description="Hosted coding agents do the work in someone else’s cloud with one model checking itself. Automation canvases can call a model, but do not know what a pull request is. This is the space between them."
        />

        <div className="mt-12 grid grid-cols-1 gap-x-10 gap-y-10 sm:mt-14 sm:grid-cols-2 lg:grid-cols-4">
          {highlights.map((item, index) => (
            <Reveal key={item.title} delay={index * 0.05} className="h-full">
              <article className="flex h-full flex-col gap-2 border-t pt-5">
                <h3 className="font-semibold tracking-tight">{item.title}</h3>
                <p className="text-sm leading-relaxed text-pretty text-muted-foreground">{item.body}</p>
              </article>
            </Reveal>
          ))}
        </div>

        <Reveal className="mt-16">
          {/* Relative, so the sr-only labels in the cells are clipped by the scroller instead of widening the page on phones. */}
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <caption className="sr-only">How {brand.name} compares with hosted coding agents and general automation canvases</caption>
              <thead>
                <tr className="border-b border-foreground/80 text-left">
                  <th scope="col" className="py-3 pr-4 font-medium text-muted-foreground">
                    What you get
                  </th>
                  <th scope="col" className="w-32 p-4 text-center font-semibold">
                    {brand.name}
                  </th>
                  <th scope="col" className="w-36 p-4 text-center font-medium text-muted-foreground">
                    Hosted coding agents
                  </th>
                  <th scope="col" className="w-36 p-4 text-center font-medium text-muted-foreground">
                    Automation canvases
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.label} className="border-b last:border-0">
                    <th scope="row" className="py-4 pr-4 text-left font-normal">
                      {row.label}
                      {row.note === undefined ? null : <span className="mt-0.5 block text-xs text-muted-foreground">{row.note}</span>}
                    </th>
                    <td className="bg-muted/50 p-4 text-center">
                      <MarkIcon mark={row.ours} />
                    </td>
                    <td className="p-4 text-center">
                      <MarkIcon mark={row.agents} />
                    </td>
                    <td className="p-4 text-center">
                      <MarkIcon mark={row.canvases} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">“Partial” means some tools in the category do it, or it takes setup. Categories, not products: individual tools change often.</p>
        </Reveal>
      </div>
    </section>
  );
}

/** Weight, not colour: a firm tick, a quiet dash, a faint cross. */
function MarkIcon({ mark }: { mark: Mark }) {
  const label = mark === 'yes' ? 'Yes' : mark === 'no' ? 'No' : 'Partly';
  return (
    <span className={cn('inline-flex items-center justify-center', mark === 'yes' ? 'text-foreground' : mark === 'no' ? 'text-muted-foreground/60' : 'text-muted-foreground')} title={label}>
      {mark === 'yes' ? <Check className="size-4" strokeWidth={2.5} /> : mark === 'no' ? <X className="size-3.5" /> : <Minus className="size-4" />}
      <span className="sr-only">{label}</span>
    </span>
  );
}
