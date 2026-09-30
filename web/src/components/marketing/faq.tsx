'use client';

import Link from 'next/link';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { useBrand } from '@/hooks/use-brand';
import { Eyebrow, REPO_URL, Reveal, SECTION_TITLE } from './primitives';

export function Faq() {
  const brand = useBrand();

  const items = [
    {
      id: 'cost',
      question: 'Does this cost anything?',
      answer:
        'The studio, accounts and the engine are free. Model usage counts against your own Claude and ChatGPT plans or API keys, and the spend forecast in the builder estimates it before you run anything. If you export to GitHub Actions, runner usage follows your GitHub plan.',
    },
    {
      id: 'account',
      question: 'Do I need an account, and what do you store?',
      answer:
        'Yes, a free one: it takes a minute, and it keeps your workflows in every browser you sign in to, with share links and version history. Sign-in is handled by Clerk; the studio stores only the workflows and run records you make, under your Clerk user id — never your code, your repository or your agents’ tokens. Download everything or delete your account from Settings at any time.',
    },
    {
      id: 'real',
      question: 'Are the runs in the studio real?',
      answer:
        'Test runs are simulated so you can explore a workflow for free. For a real run you pick a runner: pair your own computer with relay connect, or use Relay Cloud, where Relay makes and wakes a machine for you. Export a workflow and it runs unattended on your repository’s own GitHub Actions minutes.',
    },
    {
      id: 'cloud',
      question: 'What is Relay Cloud?',
      answer:
        'A Linux machine of yours that Relay makes for you, wakes when you run something and puts itself to sleep after ten idle minutes — one machine per person, so your sign-ins and your code stay yours and nobody else’s. It speaks the same protocol as relay connect on your own computer, so the run is identical: same agents, same plans, same pull request. The difference is that there is nothing to install, and it is there when your laptop is shut. It needs an account, because Relay knows your machine by your sign-in.',
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
        'Nowhere new. The agents work in a separate git worktree on your computer, on your Relay Cloud machine, or on your Actions runner, so your own checkout is only read. Nothing is pushed until the delivery step, after a secret scan, and only as far as your delivery setting allows.',
    },
  ];

  return (
    <section id="faq" className="scroll-mt-16 border-t py-16 sm:py-24">
      <div className="container max-w-6xl grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:gap-20">
        <Reveal className="flex flex-col gap-4">
          <Eyebrow>FAQ</Eyebrow>
          <h2 className={SECTION_TITLE}>A few things to know</h2>
          <p className="text-pretty text-muted-foreground sm:text-[17px]">How the agents run, where your code lives, and what stays in your hands.</p>
          <div className="mt-2 flex flex-col gap-2">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex w-fit items-center gap-1 text-sm font-medium underline underline-offset-4 decoration-foreground/30 hover:decoration-foreground"
            >
              Read the README on GitHub
              <ArrowUpRight className="size-3.5" />
            </a>
            <Link
              href="/guide"
              className="inline-flex w-fit items-center gap-1 text-sm font-medium underline underline-offset-4 decoration-foreground/30 hover:decoration-foreground"
            >
              Explore the guide
              <ArrowRight className="size-3.5" />
            </Link>
          </div>
        </Reveal>
        <Reveal delay={0.06}>
          <Accordion className="border-t">
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
