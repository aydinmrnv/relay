'use client';

import { Blocks, GitCompareArrows, KeyRound, ShieldCheck, SquareTerminal, Workflow } from 'lucide-react';
import { useBrand } from '@/hooks/use-brand';
import { TEMPLATES } from '@/lib/workflow/templates';
import { Reveal, SectionHeading } from './primitives';

export function Features() {
  const brand = useBrand();

  // Each card ends in the concrete mechanism behind the claim, in the CLI's own terms.
  const features = [
    {
      icon: GitCompareArrows,
      title: 'Cross-model review',
      body: 'The model that reviews a plan or a diff is never the one that wrote it. Nothing grades its own homework, and reviewers run read-only.',
      proof: 'planner: claude · planReviewer: codex',
    },
    {
      icon: SquareTerminal,
      title: 'Every claim checked against git',
      body: `${brand.name} computes the diff itself, judges tests by exit code and takes cost from what the CLIs report. An agent saying “done” proves nothing.`,
      proof: 'git diff --cached <baseSha>',
    },
    {
      icon: ShieldCheck,
      title: 'Refuses by default',
      body: 'An empty allowlist means nobody may start a run. Budgets are checked before anything spends, and an unattended run stops at a draft pull request.',
      proof: 'unattended.deliver: "pr"',
    },
    {
      icon: Blocks,
      title: 'Built for the work you hand over',
      body: 'A red main, a new Sentry error, a security alert, a finished feature flag, a bug report in Slack: each arrives as a task with its evidence attached, and the answer goes back where it was asked.',
      proof: `${TEMPLATES.length} ready-made workflows`,
    },
    {
      icon: KeyRound,
      title: 'Bring your own subscription',
      body: `Claude Code signs in with your Claude plan and Codex with your ChatGPT plan. There are no API keys to paste, and no sign-in ever leaves the machine that runs your agents.`,
      proof: 'claude auth login · codex login',
    },
    {
      icon: Workflow,
      title: 'Runs on your Actions minutes',
      body: 'Export writes a GitHub Actions workflow next to the config, so real runs happen in your repository, on your runner minutes. Usage stays on your own plans.',
      proof: '.github/workflows/<name>.yml',
    },
  ];

  return (
    <section id="features" className="scroll-mt-16 border-t py-16 sm:py-24">
      <div className="container max-w-6xl">
        <SectionHeading
          eyebrow="Why it holds up"
          title="Built to earn your trust"
          description="Independent reviews, verifiable results, and limits you control."
        />
        {/* One ruled grid: the hairlines are the gap, showing through a border-coloured backing. */}
        <Reveal className="mt-12 sm:mt-14">
          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border bg-border shadow-panel sm:grid-cols-2 lg:grid-cols-3">
            {features.map(({ icon: Icon, title, body, proof }) => (
              <article key={title} className="flex flex-col bg-card p-6 sm:p-7">
                <span className="flex size-9 items-center justify-center rounded-lg border bg-background">
                  <Icon className="size-4" strokeWidth={1.75} />
                </span>
                <h3 className="mt-5 text-base font-semibold tracking-tight">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-pretty text-muted-foreground">{body}</p>
                <p className="mt-auto pt-5">
                  <code className="inline-block rounded-md border bg-muted/50 px-2 py-1 font-mono text-[11px] break-words text-muted-foreground">{proof}</code>
                </p>
              </article>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
