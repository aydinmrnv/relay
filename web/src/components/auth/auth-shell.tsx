'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { motion } from 'motion/react';
import { ArrowLeft, Check, GitCompareArrows, KeyRound, ShieldCheck } from 'lucide-react';
import { BrandMark } from '@/components/app/brand-mark';
import { ThemeToggle } from '@/components/app/theme-toggle';
import { useCalmMotion } from '@/components/motion/use-calm-motion';
import { AppMark, SAMPLE, useCloudOffered } from '@/components/marketing/primitives';
import { useBrand } from '@/hooks/use-brand';
import { stashPairing } from '@/lib/companion/client';

const POINTS = [
  { icon: GitCompareArrows, title: 'Nothing grades its own homework', body: 'Claude Code and Codex review each other’s plan and diff before a pull request exists.' },
  { icon: KeyRound, title: 'Your plans, on your machine', body: 'No API keys to paste. Agents run on the subscriptions you already pay for, where you signed them in.' },
  { icon: ShieldCheck, title: 'Guardrails refuse by default', body: 'Budgets, allowlists and approvals stand in front of every unattended run.' },
];

const RECEIPT = [
  { agent: 'claude', label: 'Plan', meta: 'plan.md' },
  { agent: 'codex', label: 'Plan review', meta: '3 findings' },
  { agent: 'codex', label: 'Implement', meta: '+84 −12' },
  { agent: 'claude', label: 'Code review', meta: 'approved' },
  { agent: null, label: 'Tests', meta: 'exit 0' },
] as const;

/**
 * The frame around sign-in and sign-up — Clerk's form on the
 * right, and on the left what an account is for, with a run receipt that
 * shows the product rather than describing it.
 */
export function AuthShell({ children }: { children: React.ReactNode }) {
  const brand = useBrand();
  const reduce = useCalmMotion();
  const cloud = useCloudOffered();
  // A `relay connect` link opened while signed out lands here on its way to `/connect`.
  useEffect(stashPairing, []);
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <aside className="relative hidden overflow-hidden border-r bg-muted/40 lg:flex lg:flex-col">
        <div className="relative flex flex-1 flex-col justify-between gap-10 p-10 xl:p-14">
          <Link href="/" className="flex w-fit items-center gap-2.5 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            <BrandMark className="size-8" />
            <span className="text-lg font-semibold tracking-tight">{brand.name}</span>
          </Link>
          <div className="flex max-w-lg flex-col gap-8">
            <div className="flex flex-col gap-3">
              {/* A paragraph, not a heading: the page's one heading is the form's, and this panel is beside the point for a screen reader. */}
              <p className="text-3xl font-semibold tracking-tight text-balance xl:text-4xl">Ticket in. Reviewed PR out.</p>
              <p className="text-pretty text-muted-foreground">Draw the workflow once. Every ticket after that is planned, cross-reviewed, implemented, tested and delivered the same way.</p>
            </div>
            {/* Only the position moves: the receipt is in the server's HTML, and must be readable before any script runs. */}
            <motion.div
              initial={reduce ? false : { y: 10 }}
              animate={{ y: 0 }}
              transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              className="rounded-lg border bg-card p-4"
            >
              <div className="mb-3 flex items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-2 font-medium">
                  <AppMark connector="github" size={14} /> {SAMPLE.issue} · {SAMPLE.title}
                </span>
                <span className="rounded-md border px-2 py-0.5 font-medium text-muted-foreground">Draft PR {SAMPLE.pullRequest}</span>
              </div>
              <ol className="flex flex-col divide-y border-y">
                {RECEIPT.map((step, index) => (
                  <motion.li
                    key={step.label}
                    initial={reduce ? false : { x: -6 }}
                    animate={{ x: 0 }}
                    transition={{ delay: 0.25 + index * 0.12, duration: 0.3 }}
                    className="flex items-center gap-2.5 py-1.5 text-sm"
                  >
                    <Check className="size-3.5 text-muted-foreground" aria-hidden />
                    <span className="flex-1">{step.label}</span>
                    {step.agent === null ? null : <AppMark connector={step.agent} size={13} />}
                    <span className="w-20 text-right font-mono text-xs text-muted-foreground">{step.meta}</span>
                  </motion.li>
                ))}
              </ol>
              <p className="mt-3 text-xs text-muted-foreground">{SAMPLE.cost} · 21 min · every claim checked against git</p>
            </motion.div>
            <ul className="flex flex-col gap-4">
              {POINTS.map((point) => (
                <li key={point.title} className="flex gap-3">
                  <point.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{point.title}</span>
                    <span className="text-sm text-muted-foreground">{point.body}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="border-t pt-4 text-sm text-pretty text-muted-foreground">
              Your account keeps your workflows, runs and settings in every browser you sign in to{cloud ? ', and is how Relay Cloud knows which machine is yours' : ''}.
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            Free while in beta. The studio’s servers never receive your code: the agents work in your repository, on your computer or your CI
            {cloud ? ', or on a Relay Cloud machine of your own, which is where your code and sign-ins then are' : ''}.
          </p>
        </div>
      </aside>
      <main className="flex flex-col">
        <div className="flex items-center gap-2 p-4 sm:p-6">
          <Link href="/" className="flex items-center gap-2 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
            <ArrowLeft className="size-4" aria-hidden />
            <span className="lg:hidden">
              <BrandMark className="mr-1.5 inline size-5 align-[-5px]" />
              {brand.name}
            </span>
            <span className="hidden lg:inline">Back to the site</span>
          </Link>
          <ThemeToggle className="ml-auto size-8" />
        </div>
        <div className="flex flex-1 items-center justify-center px-4 pb-16 sm:px-6">
          <div className="w-full max-w-sm">{children}</div>
        </div>
      </main>
    </div>
  );
}
