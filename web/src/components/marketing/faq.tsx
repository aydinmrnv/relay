'use client';

import Link from 'next/link';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { useBrand } from '@/hooks/use-brand';
import { REPO_URL, Reveal } from './primitives';

export function Faq() {
  const brand = useBrand();

  const items = [
    {
      id: 'cost',
      question: 'Does this cost anything?',
      answer:
        'The studio and engine are free. Model usage counts against your own Claude and ChatGPT plans or API keys. If you export to GitHub Actions, runner usage follows your GitHub plan.',
    },
    {
      id: 'real',
      question: 'Are the runs in the studio real?',
      answer:
        'Test runs are simulated so you can explore a workflow for free. Connect the CLI with relay connect to run it on your machine with your own agents, or export it to run in GitHub Actions.',
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
  ];

  return (
    <section id="faq" className="scroll-mt-16 border-t py-16 sm:py-24">
      <div className="container max-w-6xl grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:gap-20">
        <Reveal className="flex flex-col gap-3">
          <p className="text-xs font-semibold tracking-[0.16em] text-primary uppercase">FAQ</p>
          <h2 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">A few things to know</h2>
          <p className="text-pretty text-muted-foreground">How the agents run, where your code lives, and what stays in your hands.</p>
          <div className="flex flex-col gap-2">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex w-fit items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              Read the README on GitHub
              <ArrowUpRight className="size-3.5" />
            </a>
            <Link
              href="/guide"
              className="inline-flex w-fit items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              Explore the guide
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
