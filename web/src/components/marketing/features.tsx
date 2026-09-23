'use client';

import { Blocks, GitCompareArrows, KeyRound, PlayCircle, ShieldCheck, Users } from 'lucide-react';
import { Spotlight } from '@/components/21st/spotlight';
import { useBrand } from '@/hooks/use-brand';
import { CATALOG_STATS } from '@/lib/connectors';
import { Reveal, SectionHeading } from './primitives';

export function Features() {
  const brand = useBrand();

  // Each card ends in the concrete mechanism behind the claim, in the CLI's own terms.
  const features = [
    {
      icon: Users,
      title: 'Cross-model review',
      body: 'The model that reviews a plan or a diff is never the one that wrote it. Nothing grades its own homework, and reviewers run read-only.',
      proof: 'planner: claude · planReviewer: codex',
    },
    {
      icon: GitCompareArrows,
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
      title: 'A node for every app',
      body: `${CATALOG_STATS.connectors} apps as triggers and actions. Ports are typed, so a ticket cannot be wired into something that expects a pull request.`,
      proof: `${CATALOG_STATS.triggers} triggers · ${CATALOG_STATS.actions} actions`,
    },
    {
      icon: KeyRound,
      title: 'Bring your own subscription',
      body: `Claude Code signs in with your Claude plan and Codex with your ChatGPT plan. There are no API keys to paste, and no token ever passes through ${brand.name}.`,
      proof: 'claude auth login · codex login',
    },
    {
      icon: PlayCircle,
      title: 'Runs on your Actions minutes',
      body: 'Export writes a GitHub Actions workflow next to the config, so real runs happen in your repository, on your runner minutes. Nothing is hosted or billed.',
      proof: '.github/workflows/<name>.yml',
    },
  ];

  return (
    <section id="features" className="scroll-mt-16 border-t bg-muted/20 py-20 sm:py-28">
      <div className="container">
        <SectionHeading
          eyebrow="Why it holds up"
          title="Agents that check each other, and guardrails that say no"
          description="Running agents is the easy part. These are the rules that make a run you did not watch worth reading."
        />
        <div className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map(({ icon: Icon, title, body, proof }, index) => (
            <Reveal key={title} delay={(index % 3) * 0.06} className="h-full">
              <article className="relative flex h-full flex-col gap-3 overflow-hidden rounded-2xl border bg-card p-6">
                <Spotlight size={260} className="from-primary/20 via-primary/5 to-transparent dark:from-primary/25 dark:via-primary/5 dark:to-transparent" />
                <span className="relative inline-flex size-10 items-center justify-center rounded-xl border bg-primary/8 text-primary">
                  <Icon className="size-5" />
                </span>
                <h3 className="relative text-base font-semibold tracking-tight">{title}</h3>
                <p className="relative text-sm text-pretty text-muted-foreground">{body}</p>
                <p className="relative mt-auto truncate border-t pt-3 font-mono text-[11px] text-muted-foreground">{proof}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
