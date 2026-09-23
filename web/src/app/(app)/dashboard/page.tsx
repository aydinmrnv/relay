'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import { useNow } from '@/hooks/use-now';
import { ArrowRight, Cable, CircleDollarSign, Play, Workflow } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { OnboardingChecklist } from '@/components/watermelon/onboarding-checklist';
import { CreditUsageCard } from '@/components/watermelon/credit-usage-card';
import { StatusBadge } from '@/components/app/status-badge';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { useBrand } from '@/hooks/use-brand';
import { useSignedIn } from '@/hooks/use-agent-accounts';
import { useStudio, useWorkflows } from '@/lib/store';
import { getConnector } from '@/lib/connectors';
import { formatDuration, formatUsd, timeAgo } from '@/lib/format';

export default function DashboardPage() {
  const brand = useBrand();
  const router = useRouter();
  const now = useNow();
  const workflows = useWorkflows();
  const runs = useStudio((state) => state.runs);
  const connections = useStudio((state) => state.connections);
  const hydrated = useStudio((state) => state.hydrated);
  const signedIn = useSignedIn();

  const stats = useMemo(() => {
    const week = now - 7 * 86_400_000;
    const recent = runs.filter((run) => new Date(run.startedAt).getTime() > week);
    const finished = recent.filter((run) => run.status !== 'running');
    const succeeded = finished.filter((run) => run.status === 'succeeded').length;
    const spend = recent.reduce((sum, run) => sum + run.costUsd, 0);
    return {
      workflows: workflows.length,
      enabled: workflows.filter((workflow) => workflow.enabled).length,
      runs: recent.length,
      successRate: finished.length === 0 ? null : Math.round((succeeded / finished.length) * 100),
      spend,
      connections: Object.keys(connections).length,
    };
  }, [runs, workflows, connections, now]);

  const budget = 40;
  const usedPercent = Math.min(100, Math.round((stats.spend / budget) * 100));
  const history = runs.slice(0, 6).map((run) => ({
    date: new Date(run.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    model: run.workflowName,
    credits: run.phases.length === 0 ? '—' : `${run.phases.length} phases`,
    cost: formatUsd(run.costUsd),
  }));

  const steps = [
    { id: 1, title: 'Sign in to Claude Code or Codex with your subscription', isCompleted: signedIn.claude === true || signedIn.codex === true },
    { id: 2, title: 'Connect an app', isCompleted: stats.connections > 0 },
    { id: 3, title: 'Create or pick a workflow', isCompleted: stats.workflows > 0 },
    { id: 4, title: 'Run a simulated test', isCompleted: runs.length > 0 },
    { id: 5, title: 'Export config + Actions workflow', isCompleted: false },
    { id: 6, title: `Rename ${brand.name} if you want`, isCompleted: brand.name !== 'Relay' },
  ];

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Good to see you</h1>
          <p className="text-sm text-muted-foreground">{brand.tagline}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" nativeButton={false} render={<Link href="/templates" />}>
            Templates
          </Button>
          <Button nativeButton={false} render={<Link href="/workflows" />}>
            Workflows <ArrowRight data-icon="inline-end" />
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={<Workflow className="size-4" />} label="Workflows" value={String(stats.workflows)} hint={`${stats.enabled} enabled`} />
        <Stat icon={<Play className="size-4" />} label="Runs this week" value={String(stats.runs)} hint={stats.successRate === null ? 'no finished runs yet' : `${stats.successRate}% succeeded`} />
        <Stat icon={<CircleDollarSign className="size-4" />} label="Simulated usage" value={formatUsd(stats.spend)} hint="what the CLIs would report; on a subscription it counts against your plan" />
        <Stat icon={<Cable className="size-4" />} label="Connected apps" value={String(stats.connections)} hint="mocked locally" />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Recent runs</CardTitle>
            <CardDescription>Simulated end to end. The phases, costs and refusals are what the real pipeline would report.</CardDescription>
          </CardHeader>
          <CardContent>
            {!hydrated ? null : runs.length === 0 ? (
              <Empty className="py-10">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Play />
                  </EmptyMedia>
                  <EmptyTitle>No runs yet</EmptyTitle>
                  <EmptyDescription>Open a workflow and press Test run.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Run</TableHead>
                    <TableHead>Workflow</TableHead>
                    <TableHead>Trigger</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="text-right">Duration</TableHead>
                    <TableHead className="text-right">When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.slice(0, 8).map((run) => {
                    const connector = getConnector(run.trigger.connectorId);
                    return (
                      <TableRow key={run.id} className="cursor-pointer" onClick={() => router.push(`/runs/${run.id}`)}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <StatusBadge status={run.status} />
                            <span className="font-mono text-xs text-muted-foreground">{run.shortId}</span>
                          </div>
                        </TableCell>
                        <TableCell className="max-w-56 truncate font-medium">{run.workflowName}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2 text-sm">
                            {connector === undefined ? null : <ConnectorIcon connector={connector} size={14} variant="mark" />}
                            <span className="truncate text-muted-foreground">{String(run.trigger.payload['title'] ?? run.trigger.label)}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatUsd(run.costUsd)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{formatDuration(run.startedAt, run.finishedAt)}</TableCell>
                        <TableCell className="text-right text-muted-foreground">{timeAgo(run.startedAt)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <div className="-mx-4 -my-10 sm:-mx-6 sm:-my-10">
            <OnboardingChecklist title="Getting started" steps={steps} />
          </div>
          <div className="flex justify-center">
            <CreditUsageCard
              usedCreditsPercent={usedPercent}
              totalCreditsLabel={`${formatUsd(budget)} daily ceiling`}
              creditsUsedLabel={formatUsd(stats.spend)}
              creditsLeftLabel={formatUsd(Math.max(0, budget - stats.spend))}
              usageHistory={history}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint: string }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription className="flex items-center gap-2">
          {icon}
          {label}
        </CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">{hint}</CardContent>
    </Card>
  );
}
