'use client';

import type { ReactNode } from 'react';
import { Check, CheckCircle2, GitPullRequestDraft, Hand, Lock, Power, ShieldX, Wallet, Zap } from 'lucide-react';
import { useBrand } from '@/hooks/use-brand';
import { cn } from '@/lib/utils';
import { AppMark, AppTile, Reveal, SectionHeading } from './primitives';

/**
 * Four steps, each with a small illustration built from the same pieces the
 * builder uses, so the page shows the product rather than describing it.
 */
export function HowItWorks() {
  const brand = useBrand();

  const steps: Array<{ title: string; body: string; visual: ReactNode }> = [
    {
      title: 'Pick what starts a run',
      body: 'An issue assigned in Linear, a label on GitHub, a new Sentry error, a schedule or a webhook. The trigger hands a ticket to the rest of the flow.',
      visual: <TriggerVisual slug={brand.slug} />,
    },
    {
      title: 'Put guardrails in front',
      body: 'Budgets, an author allowlist, a human approval and a kill switch sit between the ticket and the agents. Each one refuses by default and says why.',
      visual: <GuardrailVisual />,
    },
    {
      title: 'Let the agents check each other',
      body: 'Claude Code plans and Codex attacks the plan against the real code. Codex implements and Claude Code reviews the diff. Only blocking findings go back, and rounds are capped.',
      visual: <ReviewVisual />,
    },
    {
      title: 'Deliver as far as you allow',
      body: 'A commit, a pushed branch or a draft pull request, after a secret scan. A run nobody started by hand can open a PR and can never merge one.',
      visual: <DeliveryVisual slug={brand.slug} />,
    },
  ];

  return (
    <section id="how" className="scroll-mt-16 border-t py-20 sm:py-28">
      <div className="container">
        <SectionHeading
          eyebrow="How it works"
          title="From ticket to pull request in four nodes"
          description={`You draw the flow once. After that, ${brand.name} runs the same steps every time a ticket arrives, and stops wherever a guardrail says no.`}
        />
        <ol className="mt-14 grid grid-cols-1 gap-4 md:grid-cols-2 lg:gap-5">
          {steps.map((step, index) => (
            <li key={step.title}>
              <Reveal delay={(index % 2) * 0.08} className="h-full">
                <article className="flex h-full flex-col overflow-hidden rounded-2xl border bg-card">
                  <div className="flex flex-col gap-2 p-6 pb-5">
                    <div className="flex items-center gap-3">
                      <span className="inline-flex size-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground tabular-nums">{index + 1}</span>
                      <h3 className="text-lg font-semibold tracking-tight">{step.title}</h3>
                    </div>
                    <p className="text-sm text-pretty text-muted-foreground">{step.body}</p>
                  </div>
                  <div className="flex flex-1 flex-col justify-center border-t bg-muted/30 p-4 sm:p-5">{step.visual}</div>
                </article>
              </Reveal>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex min-w-0 items-center gap-2.5 rounded-lg border bg-card px-3 py-2 shadow-xs', className)}>{children}</div>;
}

function TriggerVisual({ slug }: { slug: string }) {
  const triggers = [
    { id: 'linear', name: 'Linear', event: 'Issue assigned', detail: `ENG-142 → @${slug}-bot` },
    { id: 'github', name: 'GitHub', event: 'Label added', detail: `${slug}:go on #142` },
    { id: 'sentry', name: 'Sentry', event: 'New issue', detail: 'TypeError in retry.ts' },
  ];
  return (
    <div className="flex flex-col gap-2">
      {triggers.map((trigger) => (
        <Row key={trigger.id}>
          <AppTile connector={trigger.id} size={14} />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              <Zap className="size-2.5 fill-current text-warning" />
              {trigger.name}
            </p>
            <p className="truncate text-sm font-medium">{trigger.event}</p>
          </div>
          <span className="hidden truncate font-mono text-[11px] text-muted-foreground sm:block">{trigger.detail}</span>
        </Row>
      ))}
    </div>
  );
}

function GuardrailVisual() {
  const gates: Array<{ icon: typeof Wallet; name: string; detail: string; verdict: 'pass' | 'refused' | 'armed' }> = [
    { icon: Wallet, name: 'Budget', detail: '$6 a run · $40 a day', verdict: 'pass' },
    { icon: Lock, name: 'Allowlist', detail: '@mallory is not on it', verdict: 'refused' },
    { icon: Hand, name: 'Approval', detail: 'waits for a named person', verdict: 'armed' },
    { icon: Power, name: 'Kill switch', detail: 're-read before every start', verdict: 'armed' },
  ];
  return (
    <div className="flex flex-col gap-2">
      {gates.map(({ icon: Icon, name, detail, verdict }) => (
        <Row key={name}>
          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-success/10 text-success">
            <Icon className="size-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{name}</p>
            <p className="truncate text-xs text-muted-foreground">{detail}</p>
          </div>
          {verdict === 'pass' ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
              <Check className="size-3" /> Within budget
            </span>
          ) : verdict === 'refused' ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
              <ShieldX className="size-3" /> Refused
            </span>
          ) : (
            <span className="shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">On</span>
          )}
        </Row>
      ))}
    </div>
  );
}

function ReviewVisual() {
  return (
    <div className="flex flex-col gap-2">
      <Row className="items-start">
        <AppTile connector="codex-cli" size={14} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Codex</span> reviews the plan
            <span className="rounded bg-destructive/10 px-1.5 py-px font-mono text-[10px] font-semibold text-destructive">BLOCKING</span>
          </p>
          <p className="mt-1 text-sm text-pretty">The plan adds a retry inside withTimeout, which already retries. Two layers multiply the wait.</p>
        </div>
      </Row>
      <Row className="ml-6 items-start">
        <AppTile connector="claude-code" size={14} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Claude Code</span> answers
            <span className="rounded bg-success/10 px-1.5 py-px font-mono text-[10px] font-semibold text-success">ACCEPT</span>
          </p>
          <p className="mt-1 text-sm text-pretty">Revised: retry once, at the call site. Plan v2 goes to implementation.</p>
        </div>
      </Row>
      <p className="px-1 pt-1 font-mono text-[11px] text-muted-foreground">round 1 of 2 · the diff is computed from git, not taken from the agent</p>
    </div>
  );
}

function DeliveryVisual({ slug }: { slug: string }) {
  const checks = ['Tests passed (exit 0)', 'Diff reviewed by Claude Code', 'Secret scan clean'];
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-lg border bg-card p-3 shadow-xs">
        <div className="flex items-start gap-2.5">
          <GitPullRequestDraft className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-pretty">Fix the flaky timeout in the retry test</p>
            <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
              #412 · {slug}/eng-142 → main · <span className="text-success">+84</span> <span className="text-destructive">−12</span>
            </p>
          </div>
          <span className="shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">Draft</span>
        </div>
        <ul className="mt-2.5 flex flex-col gap-1 border-t pt-2.5">
          {checks.map((check) => (
            <li key={check} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CheckCircle2 className="size-3.5 text-success" />
              {check}
            </li>
          ))}
          <li className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="size-3.5" />
            Merge is left to a person
          </li>
        </ul>
      </div>
      <Row>
        <AppMark connector="slack" size={14} />
        <p className="min-w-0 flex-1 truncate text-xs">
          <span className="font-medium">#eng-agents</span> <span className="text-muted-foreground">PR #412 is ready for review · cost $1.84</span>
        </p>
      </Row>
    </div>
  );
}
