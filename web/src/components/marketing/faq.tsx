'use client';

import Link from 'next/link';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { useBrand } from '@/hooks/use-brand';
import { CATALOG_STATS } from '@/lib/connectors';
import { REPO_URL, Reveal } from './primitives';

export function Faq() {
  const brand = useBrand();

  const items = [
    {
      id: 'cost',
      question: 'Does this cost anything?',
      answer:
        'No. The studio runs in your browser and keeps everything in its local storage. Exported workflows run on your own GitHub Actions minutes, which are free on public repositories and come out of your plan’s included minutes on private ones. Model usage counts against the Claude and ChatGPT subscriptions you already have, or your own API keys if you prefer.',
    },
    {
      id: 'real',
      question: 'Are the runs in the studio real?',
      answer:
        'No, they are simulated: the same phases, review rounds, budgets and refusals, played back deterministically so you can see what a workflow would do before it costs anything. To run one for real, export it and commit the files it produces.',
    },
    {
      id: 'agents',
      question: 'Which coding agents does it use?',
      answer:
        'Claude Code and Codex, the CLIs you already have installed and signed in to. By default Claude Code plans and reviews the code, and Codex reviews the plan and implements. Gemini CLI and Aider can be added as config harnesses; Aider can implement but never review, because it has no read-only mode.',
    },
    {
      id: 'keys',
      question: 'Do I need API keys?',
      answer: `No. Claude Code signs in with your Claude plan and Codex with your ChatGPT plan; the studio can start each CLI’s own login and then asks it whether it worked. ${brand.name} never sees a token. In GitHub Actions the export uses the vendors’ supported methods: CLAUDE_CODE_OAUTH_TOKEN from claude setup-token, and CODEX_AUTH_JSON.`,
    },
    {
      id: 'merge',
      question: 'Can it merge on its own?',
      answer:
        'Only when a person started the run and every merge gate passes: tests verifiably green, blocking findings resolved, an unprotected base branch. A ticket assignment, a label, a schedule or a webhook is an unattended start, and unattended runs stop at a draft pull request. The builder refuses to export anything else.',
    },
    {
      id: 'code',
      question: 'Where does my code go?',
      answer:
        'Nowhere new. The agents work in a separate git worktree on your machine or on your Actions runner, so your own checkout is only read. Nothing is pushed until the delivery step, after a secret scan, and only as far as your delivery setting allows.',
    },
    {
      id: 'apps',
      question: 'How do connectors work without a backend?',
      answer: `In the prototype a connection is a local flag, so you can design against all ${CATALOG_STATS.connectors} apps today. GitHub, Slack, Discord and any HTTP endpoint are wired directly in the exported Actions workflow; other apps need a bridge the hosted product would provide.`,
    },
    {
      id: 'name',
      question: `Why is it called ${brand.name}?`,
      answer: 'It might not be. The name is one field on the Settings page, and every screen, export and slug reads it from there.',
    },
  ];

  return (
    <section id="faq" className="scroll-mt-16 border-t py-20 sm:py-28">
      <div className="container grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:gap-16">
        <Reveal className="flex flex-col gap-3">
          <p className="text-xs font-semibold tracking-[0.16em] text-primary uppercase">FAQ</p>
          <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">What it is, what it is not, and what it costs</h2>
          <p className="text-pretty text-muted-foreground">
            The whole design, including the safety rules and how cross-model review is measured, is written up in the README.
          </p>
          <div className="flex flex-col gap-2">
            <a href={REPO_URL} target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline">
              Read the README on GitHub
              <ArrowUpRight className="size-3.5" />
            </a>
            <Link href="/guide" className="inline-flex w-fit items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline">
              Every term the studio uses, explained
              <ArrowRight className="size-3.5" />
            </Link>
          </div>
        </Reveal>
        <Reveal delay={0.06}>
          <Accordion className="rounded-2xl border bg-card px-5">
            {items.map((item) => (
              <AccordionItem key={item.id} value={item.id}>
                <AccordionTrigger className="py-4 text-[15px] hover:no-underline">{item.question}</AccordionTrigger>
                <AccordionContent className="pb-4 text-muted-foreground">
                  <p className="text-pretty">{item.answer}</p>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </Reveal>
      </div>
    </section>
  );
}
