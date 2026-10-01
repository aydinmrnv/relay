'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { LayoutTemplate, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-header';
import { FadeIn } from '@/components/motion/fade-in';
import { ActivityChart } from '@/components/dashboard/activity-chart';
import { ConnectionsCard, appRows } from '@/components/dashboard/connections-card';
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
import { CONNECTORS, getConnector } from '@/lib/connectors';
import { connectionState } from '@/lib/connectors/connection-state';
import { CREDENTIAL_SPECS } from '@/lib/connectors/credentials';
import { useStudio, useWorkflows } from '@/lib/store';
import { validateWorkflow } from '@/lib/workflow/validate';
import { useCompanion } from '@/lib/companion/client';
import { repositoryLabel } from '@/lib/companion/types';
import { useAccount, useCapabilities } from '@/lib/cloud/account';

const REAL_APPS = CREDENTIAL_SPECS.map((spec) => getConnector(spec.connectorId)?.name ?? spec.connectorId).join(' and ');

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
  // `status` describes whichever runner is the target, so the computer is only
  // "a machine" while it is the target and answering; `cloud` is only read
  // while the cloud is the target, for the same reason.
  const machine = useCompanion((state) => (state.target === 'machine' && state.status === 'connected' ? state.hello : null));
  const target = useCompanion((state) => state.target);
  const cloud = useCompanion((state) => (state.target === 'cloud' ? state.cloud : null));
  // A cloud machine counts as chosen once it exists: it sleeps by itself after
  // ten idle minutes, and a checklist that un-ticks itself every night would be
  // telling the truth about the wrong thing.
  const cloudChosen = cloud !== null && cloud.state !== 'none' && cloud.state !== 'failed';
  const runnerLabel = machine !== null ? (machine.machine ?? 'your machine') : target === 'cloud' ? 'Relay Cloud' : 'your machine';
  const signedIn = useSignedIn();
  const accounts = useCapabilities().enabled;
  const account = useAccount((state) => (state.status === 'signed-in' ? state.user : null));
  const onboarded = useAccount((state) => state.onboardedAt !== null);

  const validity = useMemo(() => workflows.map((workflow) => ({ workflow, ok: validateWorkflow(workflow).ok })), [workflows]);
  const firstValid = validity.find((entry) => entry.ok)?.workflow;
  const days = useMemo(() => dailyOutcomes(runs, now), [runs, now]);
  const week = useMemo(() => weekStats(runs, now), [runs, now]);
  const spend = useMemo(() => spendByWorkflow(runs, workflowMap, now), [runs, workflowMap, now]);
  const ceiling = useMemo(() => dailyCeiling(workflows), [workflows]);
  const today = useMemo(() => spendToday(runs, now), [runs, now]);
  const attention = useMemo(() => attentionItems(runs, workflows, now, connections), [runs, workflows, now, connections]);
  // Counted by what each connection is, not by how many entries there are: a marker is not a sign-in.
  const tally = useMemo(() => {
    const result = { verified: 0, marked: 0, failing: 0, missing: 0 };
    for (const connection of Object.values(connections)) {
      const connector = getConnector(connection.connectorId);
      if (connector === undefined) continue;
      const state = connectionState(connector, connection);
      if (state === 'verified' || state === 'marked' || state === 'failing') result[state] += 1;
    }
    result.missing = appRows(workflows, connections).filter((row) => row.state === 'missing').length;
    return result;
  }, [connections, workflows]);
  const connected = tally.verified + tally.marked + tally.failing;

  // Before the store hydrates the server has no clock of ours to agree with, so the greeting waits too.
  const hour = new Date(now).getHours();
  const greeting = !hydrated ? 'Welcome back' : hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  const agentNames = [signedIn.claude === true ? 'Claude Code' : null, signedIn.codex === true ? 'Codex' : null].filter((name): name is string => name !== null);
  const exported = workflows.find((workflow) => workflow.exportedAt !== undefined);
  const exportTarget = firstValid ?? workflows[0];

  const steps: ChecklistStep[] = [
    ...(accounts
      ? [
          account === null
            ? {
                id: 'account',
                title: 'Create your account',
                why: 'Keep your workflows in any browser, share them with a public link, and get version history. Free, and your guest work comes with you.',
                done: false,
                doneNote: '',
                action: { label: 'Create an account', href: '/sign-up?next=/dashboard' },
              }
            : {
                id: 'account',
                title: 'Set up your account',
                why: 'Tell the studio how you work and it builds your first workflow from the answers.',
                done: onboarded,
                doneNote: `Signed in as ${account.email}.`,
                action: { label: 'Finish setting up', href: '/onboarding' },
              },
        ]
      : []),
    {
      id: 'machine',
      title: 'Choose where your agents run',
      why: 'Your coding agents run somewhere: on your own computer through relay connect, or on a machine Relay runs for you in Relay Cloud. Both use your Claude and ChatGPT plans, and test runs stay free either way.',
      done: machine !== null || cloudChosen,
      doneNote:
        machine !== null
          ? `Connected to ${machine.machine ?? 'your machine'}${repositoryLabel(machine.repository) === null ? '' : `, in ${repositoryLabel(machine.repository)}`}.`
          : 'Sign-ins and runs go to Relay Cloud, which wakes when you need it and sleeps when it is idle.',
      action: { label: 'Compare the two runners', href: '/runners' },
      extra: { label: 'Connect your computer', href: '/connect' },
    },
    {
      id: 'agent',
      title: 'Sign in a coding agent',
      why: 'The pipeline runs on Claude Code or Codex with your own subscription. Nothing to paste; the studio never sees a token.',
      done: agentNames.length > 0,
      doneNote: `${agentNames.join(' and ')} ${agentNames.length === 1 ? 'is' : 'are'} signed in on ${runnerLabel}.`,
      ...(bridge === 'unavailable' ? { warning: `Sign-in from the browser goes through your runner: connect one first, or sign in from a terminal.` } : {}),
      action: { label: 'Open Settings', href: '/settings#agents' },
    },
    {
      id: 'connect',
      title: 'Connect your apps',
      why: `${REAL_APPS} connect for real: paste a webhook and ${brand.name} checks it with the app. Other apps can be marked ready until their sign-in is built.`,
      done: connected > 0,
      doneNote: [tally.verified > 0 ? `${tally.verified} connected for real` : null, tally.marked > 0 ? `${tally.marked} marked ready` : null, tally.failing > 0 ? `${tally.failing} failing` : null].filter(Boolean).join(', ') + '.',
      ...(tally.missing > 0 ? { warning: `${tally.missing} ${tally.missing === 1 ? 'app your workflows use is' : 'apps your workflows use are'} not connected yet.` } : {}),
      action: { label: 'Browse integrations', href: tally.missing > 0 ? '/integrations?filter=in-use' : '/integrations' },
    },
    {
      id: 'workflow',
      title: 'Create a workflow',
      why: 'A workflow says what starts a run, which guardrails check it, what the agents do and where the result goes.',
      done: workflows.length > 0,
      doneNote: `${workflows.length} ${workflows.length === 1 ? 'workflow' : 'workflows'} ${account === null ? 'in this browser' : 'in your account'}.`,
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
            connections={tally}
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

          <FadeIn delay={0.16}>
            <ConnectionsCard workflows={workflows} connections={connections} now={now} />
          </FadeIn>
        </>
      )}
    </div>
  );
}
