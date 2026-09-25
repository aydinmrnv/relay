'use client';

import { useBrand } from '@/hooks/use-brand';
import { CATALOG_STATS } from '@/lib/connectors';
import { Reveal, SectionHeading } from './primitives';

export function Features() {
  const brand = useBrand();

  // Each card ends in the concrete mechanism behind the claim, in the CLI's own terms.
  const features = [
    {
      title: 'Cross-model review',
      body: 'The model that reviews a plan or a diff is never the one that wrote it. Nothing grades its own homework, and reviewers run read-only.',
      proof: 'planner: claude · planReviewer: codex',
    },
    {
      title: 'Every claim checked against git',
      body: `${brand.name} computes the diff itself, judges tests by exit code and takes cost from what the CLIs report. An agent saying “done” proves nothing.`,
      proof: 'git diff --cached <baseSha>',
    },
    {
      title: 'Refuses by default',
      body: 'An empty allowlist means nobody may start a run. Budgets are checked before anything spends, and an unattended run stops at a draft pull request.',
      proof: 'unattended.deliver: "pr"',
    },
    {
      title: 'A node for every app',
      body: `${CATALOG_STATS.connectors} apps as triggers and actions. Ports are typed, so a ticket cannot be wired into something that expects a pull request.`,
      proof: `${CATALOG_STATS.triggers} triggers · ${CATALOG_STATS.actions} actions`,
    },
    {
      title: 'Bring your own subscription',
      body: `Claude Code signs in with your Claude plan and Codex with your ChatGPT plan. There are no API keys to paste, and no token ever passes through ${brand.name}.`,
      proof: 'claude auth login · codex login',
    },
    {
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
        <div className="mt-12 grid grid-cols-1 gap-x-10 gap-y-12 sm:mt-14 sm:grid-cols-2 lg:grid-cols-3">
          {features.map(({ title, body, proof }, index) => (
            <Reveal key={title} delay={(index % 3) * 0.06} className="h-full">
              <article className="flex h-full flex-col gap-2 border-t pt-5">
                <h3 className="text-base font-semibold tracking-tight">{title}</h3>
                <p className="text-sm leading-relaxed text-pretty text-muted-foreground">{body}</p>
                <p className="mt-auto pt-2 font-mono text-xs break-words text-muted-foreground">{proof}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
