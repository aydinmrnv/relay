'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { FolderGit2, LayoutTemplate, Plus } from 'lucide-react';
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
import { useActiveProject, useNeedsInstall, useProjectRuns, useProjectWorkflows, useProjects } from '@/hooks/use-projects';
import { RUNNER_LABEL } from '@/lib/projects';
import { leftSetup } from '@/lib/setup-draft';
import { CONNECTORS, getConnector } from '@/lib/connectors';
import { connectionState } from '@/lib/connectors/connection-state';
import { CREDENTIAL_SPECS } from '@/lib/connectors/credentials';
import { useStudio } from '@/lib/store';
import { validateWorkflow } from '@/lib/workflow/validate';
import { useCompanion } from '@/lib/companion/client';
import { repositoryLabel } from '@/lib/companion/types';
import { useAccount, useCapabilities } from '@/lib/cloud/account';


export default function DashboardPage() {
  const brand = useBrand();
  const now = useNow();
  const create = useCreateWorkflow();
  const runAgain = useRunAgain();
  const router = useRouter();
  // Everything below is the project in view: its workflows, its runs, its spend.
  const projects = useProjects();
  const project = useActiveProject();
  const workflows = useProjectWorkflows();
  const workflowMap = useStudio((state) => state.workflows);
  const runs = useProjectRuns();
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
  const runnerLabel = machine !== null ? (machine.machine ?? 'your computer') : target === 'cloud' ? 'Relay Cloud' : 'your runner';
  const signedIn = useSignedIn();
  const accounts = useCapabilities().enabled;
  const cloudOffered = useCapabilities().cloudHub != null;
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
  // The project the checklist is about: the one in view, or the first when all are shown.
  const setupProject = project ?? projects[0] ?? null;
  const onActions = setupProject === null || setupProject.runner === 'actions';
  const needsInstall = useNeedsInstall(setupProject);
  // A project read off an older workflow was never asked where it runs, so it gets the steps for a machine, as it always had.
  const actionsSteps = onActions && setupProject?.implied !== true;

  // A new account has nothing to look at here yet: setup is where it starts. Only once the account's own
  // workspace has answered, so a copy shown while offline is not mistaken for a new account; and never again in a
  // tab where setup was left, whether or not the server could be told (see `leftSetup`).
  const loaded = useAccount((state) => state.loadError === null);
  const untouched = hydrated && account !== null && loaded && !onboarded && projects.length === 0 && Object.keys(workflowMap).length === 0 && !leftSetup();
  useEffect(() => {
    if (untouched) router.replace('/onboarding');
  }, [untouched, router]);

  const runnerSteps: ChecklistStep[] = actionsSteps
    ? [
        {
          id: 'install',
          title: setupProject === null ? 'Install it in your repository' : `Install it in ${setupProject.repository}`,
          why: 'Commit the workflow file and its rules, add your agents’ sign-ins as repository secrets, and let Actions open pull requests. After that a label on an issue starts a run.',
          done: setupProject !== null && !needsInstall,
          doneNote: setupProject === null ? '' : `Runs happen on ${setupProject.repository}’s own GitHub Actions.`,
          action: setupProject === null ? null : { label: 'Open the install steps', href: '/projects' },
        },
      ]
    : [
        {
          id: 'machine',
          title: setupProject?.runner === 'cloud' ? 'Make your Relay Cloud machine' : 'Connect your computer',
          why:
            setupProject?.runner === 'cloud'
              ? 'A machine Relay makes for you, wakes when you run something and puts to sleep when it is idle. It uses your own Claude and ChatGPT plans.'
              : 'Start relay connect in your checkout and the studio can run a workflow there for real, with the Claude Code and Codex already signed in on your computer.',
          done: machine !== null || cloudChosen,
          doneNote:
            machine !== null
              ? `Connected to ${machine.machine ?? 'your computer'}${repositoryLabel(machine.repository) === null ? '' : `, in ${repositoryLabel(machine.repository)}`}.`
              : 'Sign-ins and runs go to Relay Cloud, which wakes when you need it and sleeps when it is idle.',
          action: setupProject?.runner === 'cloud' ? { label: 'Set up Relay Cloud', href: '/settings#machine' } : { label: 'Connect your computer', href: '/connect' },
          ...(cloudOffered ? { extra: { label: 'Compare the two', href: '/runners' } } : {}),
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
      ];

  const steps: ChecklistStep[] = [
    {
      id: 'project',
      title: 'Connect a repository',
      why: `A project is one repository and where its workflows run. ${brand.name} never asks for access to your code: you commit its files yourself.`,
      done: projects.length > 0,
      doneNote: setupProject === null ? '' : `${setupProject.repository}, on ${RUNNER_LABEL[setupProject.runner]}${projects.length > 1 ? `, and ${projects.length - 1} more` : ''}.`,
      action: { label: 'Set up a project', href: accounts && !onboarded ? '/onboarding' : '/projects/new' },
    },
    {
      id: 'workflow',
      title: 'Create a workflow',
      why: 'A workflow says what starts a run, which guardrails check it, what the agents do and where the result goes.',
      done: workflows.length > 0,
      doneNote: `${workflows.length} ${workflows.length === 1 ? 'workflow' : 'workflows'}${project === null ? '' : ` in ${project.repository}`}.`,
      action: { label: 'New workflow', onClick: () => create.blank(), icon: 'plus' },
    },
    {
      id: 'test',
      title: 'Play a test run',
      why: 'See every step do its job on a sample issue before anything real is wired up. Free, and nothing leaves this browser.',
      done: runs.length > 0,
      doneNote: `${runs.length} ${runs.length === 1 ? 'run' : 'runs'} recorded.`,
      action: firstValid !== undefined ? { label: `Test ${firstValid.name}`, onClick: () => runAgain(firstValid.id, { navigate: true }), icon: 'play' } : { label: 'Open workflows', href: '/workflows' },
    },
    ...runnerSteps,
    {
      id: 'connect',
      title: 'Connect your apps',
      optional: true,
      why: `${CREDENTIAL_SPECS.length} apps connect for real: paste a webhook or an API token and ${brand.name} checks it with the app. The rest can be marked ready until their sign-in is built.`,
      done: connected > 0,
      doneNote: [tally.verified > 0 ? `${tally.verified} connected for real` : null, tally.marked > 0 ? `${tally.marked} marked ready` : null, tally.failing > 0 ? `${tally.failing} failing` : null].filter(Boolean).join(', ') + '.',
      ...(tally.missing > 0 ? { warning: `${tally.missing} ${tally.missing === 1 ? 'app your workflows use is' : 'apps your workflows use are'} not connected yet.` } : {}),
      action: { label: 'Browse integrations', href: tally.missing > 0 ? '/integrations?filter=in-use' : '/integrations' },
    },
  ];
  const setupComplete = steps.every((step) => step.done || step.optional === true);
  const showChecklist = hydrated && !checklistDismissed && !setupComplete;

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <PageHeader
        title={greeting}
        description={
          project === null
            ? projects.length === 0
              ? `${brand.name} builds automations that run on your own GitHub Actions, in your repository. Connect one to start.`
              : `All ${projects.length} of your projects together. Pick one at the top of the sidebar to see it alone.`
            : `${project.repository}, running on ${RUNNER_LABEL[project.runner]}. Design a workflow here, play it as a free test run, then install it in the repository.`
        }
        actions={
          <>
            {projects.length === 0 ? (
              <Button variant="outline" nativeButton={false} render={<Link href="/projects/new" />}>
                <FolderGit2 data-icon="inline-start" /> Connect a repository
              </Button>
            ) : null}
            <Button variant="outline" nativeButton={false} render={<Link href="/templates" />}>
              <LayoutTemplate data-icon="inline-start" /> Templates
            </Button>
            <Button onClick={() => create.blank()}>
              <Plus data-icon="inline-start" /> New workflow
            </Button>
          </>
        }
      />

      {!hydrated || untouched ? null : (
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
            realSpend={week.realSpend}
            // Connected means the app accepted a credential. A marker is a label, counted in the line under the number.
            connected={tally.verified}
            connections={tally}
            catalog={CONNECTORS.filter((connector) => connector.category !== 'core').length}
          />

          <FadeIn delay={0.08} className="grid items-stretch gap-6 lg:grid-cols-3">
            <ActivityChart days={days} className="lg:col-span-2" />
            <SpendCard today={today.total} todayReal={today.real} ceiling={ceiling} rows={spend.rows} other={spend.other} weekTotal={spend.total} weekReal={spend.real} />
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
