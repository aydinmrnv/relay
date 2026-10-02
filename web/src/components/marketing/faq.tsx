'use client';

import Link from 'next/link';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { SUPPORT_EMAIL } from '@/lib/links';
import { Eyebrow, REPO_URL, Reveal, SECTION_TITLE, useCloudOffered } from './primitives';

export function Faq() {
  const cloud = useCloudOffered();

  const items = [
    {
      id: 'cost',
      question: 'Does this cost anything?',
      answer:
        'The studio and accounts are free while in beta, and the engine is open source. Model usage counts against your own Claude and ChatGPT plans or API keys, and the spend forecast in the builder gives a rough range before you run anything. If you export to GitHub Actions, runner usage follows your GitHub plan.',
    },
    {
      id: 'account',
      question: 'Do I need an account, and what do you store?',
      answer:
        `Yes, a free one: it takes a minute, and it keeps your workflows in every browser you sign in to, with share links and version history. Sign-in is handled by Clerk. Under your Clerk user id the studio stores the workflows, saved versions and run records you make, your settings and onboarding answers, any Slack or Discord webhook you connect (encrypted), and the name shown on a workflow you share. The studio’s servers never receive your code or your agents’ tokens.${cloud ? ' A Relay Cloud machine, if you use one, is where your code is checked out and your agents are signed in.' : ''} Download everything or delete your account from Settings at any time.`,
    },
    {
      id: 'real',
      question: 'Are the runs in the studio real?',
      answer:
        `Test runs are simulated so you can explore a workflow for free. For a real run you pick a runner: pair your own computer with relay connect${cloud ? ', or use Relay Cloud, where Relay makes and wakes a machine for you' : ''}. A workflow that starts from a GitHub issue label can also be exported, and then runs unattended on your repository’s own GitHub Actions minutes.`,
    },
    ...(cloud
      ? [
          {
            id: 'cloud',
            question: 'What is Relay Cloud?',
            answer: `An invite-only beta. A Linux machine of yours that Relay makes for you, wakes when you run something and puts to sleep after ten idle minutes — one machine per person, so your sign-ins and your code are on a machine nobody else’s runs touch. It speaks the same protocol as relay connect on your own computer: same agents, same plans, same pull request, with nothing to install, and it is there when your laptop is shut. It runs one run at a time. It needs an account, and for now an invitation: write to ${SUPPORT_EMAIL} to ask for access.`,
          },
        ]
      : []),
    {
      id: 'agents',
      question: 'Which coding agents does it use?',
      answer:
        'Claude Code and Codex, the CLIs you already have installed and signed in to. By default Claude Code plans and reviews the code, and Codex reviews the plan and implements. Either one can also take every role by itself, with each review done by a fresh, read-only session.',
    },
    {
      id: 'keys',
      question: 'Do I need API keys?',
      answer: `No. Claude Code signs in with your Claude plan and Codex with your ChatGPT plan; the studio can start each CLI’s own login and then asks it whether it worked. On your own computer Codex can also use Continue with ChatGPT, where you allow Relay to use your plan and set its limit in ChatGPT’s settings. The studio never sees a token: the sign-ins live in the CLIs, on your computer${cloud ? ' or on your Relay Cloud machine' : ''}. In GitHub Actions the export uses the vendors’ supported methods, held as secrets in your repository: CLAUDE_CODE_OAUTH_TOKEN from claude setup-token, and CODEX_AUTH_JSON.`,
    },
    {
      id: 'merge',
      question: 'Can it merge on its own?',
      answer:
        'Not from the studio, and never unattended. A run started here, or by a label on an issue, goes as far as a pull request and stops: merging is yours. The CLI can merge only when you run it yourself in a terminal, ask for it, and every merge gate passes: tests verifiably green, blocking findings resolved, an unprotected base branch.',
    },
    {
      id: 'code',
      question: 'Where does my code go?',
      answer:
        `To the model vendors you already use, and nowhere else new. The agents work in a separate git worktree on your computer${cloud ? ', on your Relay Cloud machine,' : ''} or on your Actions runner, so your own checkout is only read, and the studio’s servers never receive your code. Nothing is pushed until the delivery step, after a secret scan, and only as far as your delivery setting allows.`,
    },
  ];

  return (
    <section id="faq" className="scroll-mt-20 border-t py-16 sm:py-24">
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
              Read the guide
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
