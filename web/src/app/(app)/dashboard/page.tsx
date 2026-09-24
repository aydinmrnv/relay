'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { LayoutTemplate, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-header';
import { FadeIn } from '@/components/motion/fade-in';
import { ActivityChart } from '@/components/dashboard/activity-chart';
import { attentionItems, dailyCeiling, dailyOutcomes, spendByWorkflow, spendToday, weekStats } from '@/components/dashboard/derive';
import { GettingStarted, type ChecklistStep } from '@/components/dashboard/getting-started';
import { KpiTiles } from '@/components/dashboard/kpi-tiles';
import { NeedsAttention } from '@/components/dashboard/needs-attention';
import { RecentRuns } from '@/components/dashboard/recent-runs';
import { SpendCard } from '@/components/dashboard/spend-card';
import { useRunAgain } from '@/components/runs/use-run-again';
import { useAgentsStore, useSignedIn } from '@/hooks/use-agent-accounts';
import { useBrand } from '@/hooks/use-brand';
import { useCreateWorkflow } from '@/hooks/use-create-workflow';
import { useNow } from '@/hooks/use-now';
import { DEFAULT_BRAND } from '@/lib/brand';
import { CONNECTORS } from '@/lib/connectors';
import { useStudio, useWorkflows } from '@/lib/store';
import { validateWorkflow } from '@/lib/workflow/validate';
import { HOSTED_DEMO } from '@/lib/hosted';

export default function DashboardPage() {
  const brand = useBrand();
  const now = useNow();
  const create = useCreateWorkflow();
  const runAgain = useRunAgain();
  const workflows = useWorkflows();
  const workflowMap = useStudio((state) => state.workflows);
  const runs = useStudio((state) => state.runs);
  const connections = useStudio((state) => state.connections);
  const hydrated = useStudio((state) => state.hydrated);
  const checklistDismissed = useStudio((state) => state.checklistDismissed);
  const bridge = useAgentsStore((state) => state.bridge);
  const signedIn = useSignedIn();

  const validity = useMemo(() => workflows.map((workflow) => ({ workflow, ok: validateWorkflow(workflow).ok })), [workflows]);
  const firstValid = validity.find((entry) => entry.ok)?.workflow;
  const days = useMemo(() => dailyOutcomes(runs, now), [runs, now]);
  const week = useMemo(() => weekStats(runs, now), [runs, now]);
  const spend = useMemo(() => spendByWorkflow(runs, workflowMap, now), [runs, workflowMap, now]);
  const ceiling = useMemo(() => dailyCeiling(workflows), [workflows]);
  const today = useMemo(() => spendToday(runs, now), [runs, now]);
  const attention = useMemo(() => attentionItems(runs, workflows, now), [runs, workflows, now]);
  const connected = Object.keys(connections).length;

  // Before the store hydrates the server has no clock of ours to agree with, so the greeting waits too.
  const hour = new Date(now).getHours();
  const greeting = !hydrated ? 'Welcome back' : hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  const agentNames = [signedIn.claude === true ? 'Claude Code' : null, signedIn.codex === true ? 'Codex' : null].filter((name): name is string => name !== null);
  const exported = workflows.find((workflow) => workflow.exportedAt !== undefined);
  const exportTarget = firstValid ?? workflows[0];

  const steps: ChecklistStep[] = [
    {
      id: 'agent',
      title: 'Sign in a coding agent',
      why: 'The pipeline runs on Claude Code or Codex with your own subscription. Nothing to paste; the studio never sees a token.',
      done: agentNames.length > 0,
      doneNote: `${agentNames.join(' and ')} ${agentNames.length === 1 ? 'is' : 'are'} signed in on this machine.`,
      ...(bridge === 'unavailable'
        ? {
            warning: HOSTED_DEMO
              ? 'This is the hosted demo, which cannot see the CLIs on your computer. Sign-in works when the studio runs on your machine.'
              : 'The local bridge is not answering, so the studio cannot ask the CLIs. Sign-in works when the studio runs on your machine.',
          }
        : {}),
      action: { label: 'Open Settings', href: '/settings#agents' },
    },
    {
      id: 'connect',
      title: 'Connect an app',
      why: 'Triggers and actions talk to apps like Linear, GitHub and Slack. In this prototype a connection is a local flag, not a real login.',
      done: connected > 0,
      doneNote: `${connected} ${connected === 1 ? 'app' : 'apps'} connected.`,
      action: { label: 'Browse integrations', href: '/integrations' },
    },
    {
      id: 'workflow',
      title: 'Create a workflow',
      why: 'A workflow says what starts a run, which guardrails check it, what the agents do and where the result goes.',
      done: workflows.length > 0,
      doneNote: `${workflows.length} ${workflows.length === 1 ? 'workflow' : 'workflows'} in this browser.`,
      action: { label: 'New workflow', onClick: () => create.blank(), icon: 'plus' },
    },
    {
      id: 'test',
      title: 'Play a test run',
      why: 'See every node do its job with a sample ticket before anything real is wired up. Free, and nothing leaves this browser.',
      done: runs.length > 0,
      doneNote: `${runs.length} ${runs.length === 1 ? 'run' : 'runs'} recorded.`,
      action: firstValid !== undefined ? { label: `Test ${firstValid.name}`, onClick: () => runAgain(firstValid.id, { navigate: true }), icon: 'play' } : { label: 'Open workflows', href: '/workflows' },
    },
    {
      id: 'export',
      title: 'Export to a repository',
      why: `Export compiles a workflow into a config and a GitHub Actions file, so it runs on your repository with your own subscriptions.${exportTarget === undefined ? '' : ` Open “${exportTarget.name}” and press Export.`}`,
      done: exported !== undefined,
      doneNote: exported === undefined ? '' : `${exported.name} was exported.`,
      action: exportTarget === undefined ? null : { label: 'Open in the builder', href: `/workflows/${exportTarget.id}` },
    },
    {
      id: 'rename',
      title: 'Name the product',
      why: `“${DEFAULT_BRAND.name}” is a working title. Rename it once in Settings and every screen, branch prefix and exported file follows.`,
      done: brand.name !== DEFAULT_BRAND.name,
      doneNote: `It is called ${brand.name} now.`,
      optional: true,
      action: { label: 'Rename', href: '/settings#general' },
    },
  ];
  const setupComplete = steps.every((step) => step.done || step.optional === true);
  const showChecklist = hydrated && !checklistDismissed && !setupComplete;

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <PageHeader
        title={greeting}
        description={`${brand.name} turns tickets into reviewed pull requests. Design a workflow here, play it as a free test run, then export it to run on your own GitHub Actions.`}
        actions={
          <>
            <Button variant="outline" nativeButton={false} render={<Link href="/templates" />}>
              <LayoutTemplate data-icon="inline-start" /> Templates
            </Button>
            <Button onClick={() => create.blank()}>
              <Plus data-icon="inline-start" /> New workflow
            </Button>
          </>
        }
      />

      {!hydrated ? null : (
        <>
          <AnimatePresence initial={false}>
            {showChecklist ? (
              <motion.div key="checklist" exit={{ opacity: 0, height: 0, marginBottom: -24 }} transition={{ duration: 0.25 }} className="overflow-hidden">
                <FadeIn>
                  <GettingStarted steps={steps} />
                </FadeIn>
              </motion.div>
            ) : null}
          </AnimatePresence>

          <KpiTiles
            workflows={workflows.length}
            enabled={workflows.filter((workflow) => workflow.enabled).length}
            broken={validity.filter((entry) => !entry.ok).length}
            runs={week.runs}
            previousRuns={week.previousRuns}
            successRate={week.successRate}
            finished={week.finished}
            spend={week.spend}
            connected={connected}
            catalog={CONNECTORS.length}
          />

          <FadeIn delay={0.08} className="grid items-stretch gap-6 lg:grid-cols-3">
            <ActivityChart days={days} className="lg:col-span-2" />
            <SpendCard today={today} ceiling={ceiling} rows={spend.rows} other={spend.other} weekTotal={spend.total} />
          </FadeIn>

          <FadeIn delay={0.12} className="grid items-stretch gap-6 lg:grid-cols-3">
            <RecentRuns
              runs={runs.slice(0, 6)}
              total={runs.length}
              now={now}
              className="lg:col-span-2"
              {...(firstValid === undefined ? {} : { onTest: () => runAgain(firstValid.id, { navigate: true }), testLabel: `Test ${firstValid.name}` })}
            />
            <NeedsAttention items={attention} now={now} />
          </FadeIn>
        </>
      )}
    </div>
  );
}
