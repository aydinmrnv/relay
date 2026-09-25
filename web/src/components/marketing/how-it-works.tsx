'use client';

import type { ReactNode } from 'react';
import { Check, CheckCircle2, GitPullRequestDraft, Hand, Lock, Power, ShieldX, Wallet } from 'lucide-react';
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
      body: 'Choose an issue, a label, a schedule, or a webhook. The trigger passes a ticket into your workflow.',
      visual: <TriggerVisual slug={brand.slug} />,
    },
    {
      title: 'Put guardrails in front',
      body: 'Set a budget, restrict who can start a run, and add approval where it matters. Failed checks stop the run.',
      visual: <GuardrailVisual />,
    },
    {
      title: 'Let the agents check each other',
      body: 'One agent writes the plan and code. Another reviews both against your repository. Blocking findings go back for a fix.',
      visual: <ReviewVisual />,
    },
    {
      title: 'Deliver as far as you allow',
      body: 'Choose a commit, branch, or draft pull request. Unattended runs stop at a draft PR, leaving the merge to you.',
      visual: <DeliveryVisual slug={brand.slug} />,
    },
  ];

  return (
    <section id="how" className="scroll-mt-16 border-t py-16 sm:py-24">
      <div className="container max-w-6xl">
        <SectionHeading
          eyebrow="How it works"
          title="A clear path from ticket to pull request"
          description={`Build the workflow once. ${brand.name} handles each handoff and stops when a guardrail says no.`}
        />
        <ol className="mt-12 border-b sm:mt-14">
          {steps.map((step, index) => (
            <li key={step.title} className="border-t py-8 sm:py-10">
              <Reveal className="grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:gap-12">
                <div className="flex gap-4">
                  <span className="pt-1 font-mono text-sm text-muted-foreground tabular-nums">0{index + 1}</span>
                  <div className="flex flex-col gap-2">
                    <h3 className="text-xl font-semibold tracking-tight">{step.title}</h3>
                    <p className="max-w-sm text-sm leading-relaxed text-pretty text-muted-foreground sm:text-base">{step.body}</p>
                  </div>
                </div>
                <div className="min-w-0">{step.visual}</div>
              </Reveal>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** A mock of the studio's own UI: one bordered panel, rows divided by rules. */
function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('divide-y overflow-hidden rounded-lg border bg-card', className)}>{children}</div>;
}

function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex min-w-0 items-center gap-3 px-4 py-3', className)}>{children}</div>;
}

const SUCCESS_TEXT = 'text-[color-mix(in_oklch,var(--success)_80%,var(--foreground))] dark:text-success';
const DESTRUCTIVE_TEXT = 'text-[color-mix(in_oklch,var(--destructive)_85%,var(--foreground))] dark:text-destructive';

function TriggerVisual({ slug }: { slug: string }) {
  const triggers = [
    { id: 'linear', name: 'Linear', event: 'Issue assigned', detail: `ENG-142 → @${slug}-bot` },
    { id: 'github', name: 'GitHub', event: 'Label added', detail: `${slug}:go on #142` },
    { id: 'sentry', name: 'Sentry', event: 'New issue', detail: 'TypeError in retry.ts' },
  ];
  return (
    <Panel>
      {triggers.map((trigger) => (
        <Row key={trigger.id}>
          <AppTile connector={trigger.id} size={14} />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">{trigger.name}</p>
            <p className="truncate text-sm font-medium">{trigger.event}</p>
          </div>
          <span className="hidden truncate font-mono text-xs text-muted-foreground sm:block">{trigger.detail}</span>
        </Row>
      ))}
    </Panel>
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
    <Panel>
      {gates.map(({ icon: Icon, name, detail, verdict }) => (
        <Row key={name}>
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{name}</p>
            <p className="truncate text-xs text-muted-foreground">{detail}</p>
          </div>
          {verdict === 'pass' ? (
            <span className={cn('inline-flex shrink-0 items-center gap-1 text-xs font-medium', SUCCESS_TEXT)}>
              <Check className="size-3.5" /> Within budget
            </span>
          ) : verdict === 'refused' ? (
            <span className={cn('inline-flex shrink-0 items-center gap-1 text-xs font-medium', DESTRUCTIVE_TEXT)}>
              <ShieldX className="size-3.5" /> Refused
            </span>
          ) : (
            <span className="shrink-0 text-xs text-muted-foreground">On</span>
          )}
        </Row>
      ))}
    </Panel>
  );
}

function ReviewVisual() {
  return (
    <Panel>
      <Row className="items-start">
        <AppTile connector="codex-cli" size={14} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Codex</span> reviews the plan
            <span className={cn('font-mono text-[11px] font-semibold', DESTRUCTIVE_TEXT)}>BLOCKING</span>
          </p>
          <p className="mt-1 text-sm text-pretty">
            The plan adds a retry inside withTimeout, which already retries. Two layers multiply the wait.
          </p>
        </div>
      </Row>
      <Row className="items-start">
        <AppTile connector="claude-code" size={14} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Claude Code</span> answers
            <span className={cn('font-mono text-[11px] font-semibold', SUCCESS_TEXT)}>ACCEPT</span>
          </p>
          <p className="mt-1 text-sm text-pretty">Revised: retry once, at the call site. Plan v2 goes to implementation.</p>
        </div>
      </Row>
      <p className="bg-muted/40 px-4 py-2.5 font-mono text-xs text-muted-foreground">
        round 1 of 2 · the diff is computed from git, not taken from the agent
      </p>
    </Panel>
  );
}

function DeliveryVisual({ slug }: { slug: string }) {
  const checks = ['Tests passed (exit 0)', 'Diff reviewed by Claude Code', 'Secret scan clean'];
  return (
    <Panel>
      <div className="px-4 py-3">
        <div className="flex items-start gap-2.5">
          <GitPullRequestDraft className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-pretty">Fix the flaky timeout in the retry test</p>
            <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
              #412 · {slug}/eng-142 → main · <span className={SUCCESS_TEXT}>+84</span> <span className={DESTRUCTIVE_TEXT}>−12</span>
            </p>
          </div>
          <span className="shrink-0 rounded-md border px-2 py-0.5 text-xs text-muted-foreground">Draft</span>
        </div>
        <ul className="mt-3 flex flex-col gap-1.5 pl-6.5">
          {checks.map((check) => (
            <li key={check} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CheckCircle2 className={cn('size-3.5', SUCCESS_TEXT)} />
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
          <span className="font-medium">#eng-agents</span>{' '}
          <span className="text-muted-foreground">PR #412 is ready for review · cost $1.84</span>
        </p>
      </Row>
    </Panel>
  );
}
