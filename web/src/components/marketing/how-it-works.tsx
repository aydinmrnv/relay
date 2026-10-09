'use client';

import type { ReactNode } from 'react';
import { Check, CheckCircle2, FileCode2, GitPullRequestDraft, Hand, Lock, Power, ShieldX, Wallet } from 'lucide-react';
import { useBrand } from '@/hooks/use-brand';
import { cn } from '@/lib/utils';
import { AppMark, AppTile, Reveal, SAMPLE, SectionHeading } from './primitives';

/**
 * The steps of setting a project up, in the order setup asks them, each with
 * a small illustration built from the same pieces the studio uses, so the
 * page shows the product rather than describing it.
 */
export function HowItWorks() {
  const brand = useBrand();
  const steps: Array<{ title: string; body: string; visual: ReactNode }> = [
    {
      title: 'Connect a repository',
      body: `Say which repository. ${brand.name} never asks for access to your code: it writes a workflow file and the rules it runs under, and you commit them like any other change.`,
      visual: <RepositoryVisual />,
    },
    {
      title: 'Pick what it does',
      body: 'Start with issue to pull request: label an issue, and two agents plan it, write it and review each other. Or describe your own in a sentence and edit it on the canvas.',
      visual: <WorkflowVisual />,
    },
    {
      title: 'Set the rules',
      body: 'Who may start a run, what a run and a day may cost, and where a person has to say yes. A run that breaks a rule does not start.',
      visual: <GuardrailVisual />,
    },
    {
      title: 'It runs on your GitHub Actions',
      body: 'On your repository’s own minutes, with the Claude and ChatGPT plans you already pay for, held as secrets only GitHub has. One agent writes the plan and the other attacks it; then they swap for the code.',
      visual: <ReviewVisual />,
    },
    {
      title: 'You get a draft pull request',
      body: 'Tested, reviewed, and reported back on the issue. A run nobody is watching stops at a draft: the merge is yours.',
      visual: <DeliveryVisual />,
    },
  ];

  return (
    <section id="how" className="scroll-mt-20 border-t py-16 sm:py-24">
      <div className="container max-w-6xl">
        <SectionHeading
          eyebrow="How it works"
          title="From your repository to a reviewed pull request"
          description="Set it up once, in about two minutes. After that a label on an issue is all it takes."
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
  return <div className={cn('divide-y overflow-hidden rounded-xl border bg-card shadow-panel', className)}>{children}</div>;
}

function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex min-w-0 items-center gap-3 px-4 py-3', className)}>{children}</div>;
}

const SUCCESS_TEXT = 'text-[color-mix(in_oklch,var(--success)_80%,var(--foreground))] dark:text-success';
const DESTRUCTIVE_TEXT = 'text-[color-mix(in_oklch,var(--destructive)_85%,var(--foreground))] dark:text-destructive';

function RepositoryVisual() {
  // What setup leaves in the repository: three files, named as the export names them.
  const files = ['.github/workflows/issue-to-pull-request.yml', '.relay/config.json', '.relay/workflows/issue-to-pull-request.json'];
  return (
    <Panel>
      <Row>
        <AppTile connector="github" size={14} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-sm font-medium">{SAMPLE.repository}</p>
          <p className="truncate text-xs text-muted-foreground">runs on GitHub Actions</p>
        </div>
        <span className={cn('inline-flex shrink-0 items-center gap-1 text-xs font-medium', SUCCESS_TEXT)}>
          <Check className="size-3.5" /> Connected
        </span>
      </Row>
      {files.map((file) => (
        <Row key={file} className="py-2">
          <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{file}</p>
        </Row>
      ))}
      <p className="bg-muted/40 px-4 py-2.5 font-mono text-xs text-muted-foreground">committed by you · no access to your code is asked for</p>
    </Panel>
  );
}

function WorkflowVisual() {
  const workflows = [
    { name: 'Issue to pull request', detail: `label ${SAMPLE.label}`, picked: true },
    { name: 'Quick fix from an issue', detail: 'one agent, one session', picked: false },
    { name: 'Describe your own', detail: 'a sentence in, a workflow out', picked: false },
  ];
  return (
    <Panel>
      {workflows.map((workflow) => (
        <Row key={workflow.name}>
          <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-full border', workflow.picked && 'border-foreground bg-foreground text-background')}>
            {workflow.picked ? <Check className="size-3" /> : null}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{workflow.name}</p>
            <p className="truncate font-mono text-xs text-muted-foreground">{workflow.detail}</p>
          </div>
          {workflow.picked ? <span className={cn('hidden shrink-0 text-xs font-medium sm:block', SUCCESS_TEXT)}>Starts by itself</span> : null}
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
        <AppTile connector="codex" size={14} />
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
        <AppTile connector="claude" size={14} />
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

function DeliveryVisual() {
  const checks = ['Tests passed (exit 0)', 'Diff reviewed by Claude Code', 'Secret scan clean'];
  return (
    <Panel>
      <div className="px-4 py-3">
        <div className="flex items-start gap-2.5">
          <GitPullRequestDraft className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-pretty">{SAMPLE.title}</p>
            <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
              {SAMPLE.pullRequest} · {SAMPLE.branch} → main · <span className={SUCCESS_TEXT}>+84</span> <span className={DESTRUCTIVE_TEXT}>−12</span>
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
          <span className="text-muted-foreground">
            PR {SAMPLE.pullRequest} is ready for review · cost {SAMPLE.cost}
          </span>
        </p>
      </Row>
    </Panel>
  );
}
