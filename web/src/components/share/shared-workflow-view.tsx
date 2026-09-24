'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { nanoid } from 'nanoid';
import { toast } from 'sonner';
import { ArrowRight, Bot, Eye, GitFork, Link2, Loader2, Plug, Shuffle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { BrandMark } from '@/components/app/brand-mark';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { GraphView } from '@/components/templates/graph-view';
import { branchParent, StepItem } from '@/components/templates/template-preview';
import { useBrand } from '@/hooks/use-brand';
import { useAccount, useWorkspaceReady } from '@/lib/cloud/account';
import { getConnector } from '@/lib/connectors';
import { AGENT_OPTIONS } from '@/lib/connectors/catalog/core';
import { timeAgo } from '@/lib/format';
import { useStudio } from '@/lib/store';
import { describeWorkflow } from '@/lib/workflow/describe';
import type { Workflow } from '@/lib/workflow/schema';

export interface SharedWorkflow {
  slug: string;
  authorName: string;
  views: number;
  remixes: number;
  createdAt: string;
  updatedAt: string;
  workflow: Workflow;
}

export function SharedWorkflowView({ share }: { share: SharedWorkflow }) {
  const brand = useBrand();
  const router = useRouter();
  const ready = useWorkspaceReady();
  const signedIn = useAccount((state) => state.status === 'signed-in');
  const repository = useStudio((state) => state.settings.defaultRepository);
  const [busy, setBusy] = useState(false);
  const { workflow } = share;
  const description = useMemo(() => describeWorkflow(workflow), [workflow]);
  const connectors = useMemo(() => [...new Set(workflow.nodes.map((node) => node.data.typeId.split('.')[0] ?? ''))].map((id) => getConnector(id)).filter((connector) => connector !== undefined), [workflow]);

  const remix = async () => {
    setBusy(true);
    const now = new Date().toISOString();
    const copy: Workflow = {
      ...workflow,
      id: `wf_${nanoid(10)}`,
      name: workflow.name,
      description: workflow.description.trim().length > 0 ? workflow.description : `Remixed from ${share.authorName}’s shared workflow.`,
      nodes: workflow.nodes.map((node) => ({ ...node, data: { ...node.data, config: { ...node.data.config } } })),
      edges: workflow.edges.map((edge) => ({ ...edge })),
      enabled: false,
      createdAt: now,
      updatedAt: now,
      repository,
      templateId: undefined,
      demo: undefined,
      exportedAt: undefined,
    };
    useStudio.getState().upsertWorkflow(copy);
    void fetch(`/api/share/${share.slug}/remix`, { method: 'POST' }).catch(() => undefined);
    toast.success(`Remixed “${workflow.name}”`, { description: signedIn ? 'It is in your account. Change anything; the original stays as it is.' : 'It is in this browser. Create an account to keep it everywhere.' });
    router.push(`/workflows/${copy.id}`);
  };

  const copyLink = async () => {
    await navigator.clipboard.writeText(window.location.href);
    toast.success('Link copied');
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
        <div className="container flex h-14 items-center gap-3">
          <Link href="/" className="mr-auto flex items-center gap-2 font-semibold tracking-tight">
            <BrandMark className="size-7" />
            {brand.name}
          </Link>
          {signedIn ? null : (
            <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/sign-up" />}>
              Create an account
            </Button>
          )}
          <Button size="sm" variant="outline" nativeButton={false} render={<Link href="/dashboard" />}>
            Open the studio
          </Button>
        </div>
      </header>

      <main className="container flex flex-1 flex-col gap-8 py-10">
        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="gap-1">
              <GitFork className="size-3" aria-hidden /> Shared workflow
            </Badge>
            <div className="flex items-center gap-1">
              {connectors.map((connector) => (
                <span key={connector.id} title={connector.name}>
                  <ConnectorIcon connector={connector} size={13} />
                </span>
              ))}
            </div>
          </div>
          <h1 className="max-w-3xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{workflow.name}</h1>
          {workflow.description.trim().length > 0 ? <p className="max-w-3xl text-pretty text-muted-foreground">{workflow.description}</p> : null}
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <span>
              by <span className="font-medium text-foreground">{share.authorName}</span>
            </span>
            <span suppressHydrationWarning>updated {timeAgo(share.updatedAt)}</span>
            <span className="inline-flex items-center gap-1">
              <Eye className="size-3.5" aria-hidden /> {share.views + 1}
            </span>
            <span className="inline-flex items-center gap-1">
              <Shuffle className="size-3.5" aria-hidden /> {share.remixes} {share.remixes === 1 ? 'remix' : 'remixes'}
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="lg" onClick={() => void remix()} disabled={!ready || busy}>
              {busy || !ready ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Shuffle data-icon="inline-start" />}
              Remix into my studio
            </Button>
            <Button size="lg" variant="outline" onClick={() => void copyLink()}>
              <Link2 data-icon="inline-start" /> Copy link
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Remixing makes your own copy, paused, with your repository. Secrets, links, addresses and people’s logins were removed from this public copy.</p>
        </section>

        <GraphView workflow={workflow} className="h-72 shrink-0 rounded-2xl border sm:h-[28rem]" />

        <div className="grid gap-10 md:grid-cols-[minmax(0,1fr)_18rem]">
          <section>
            <h2 className="text-sm font-semibold">Step by step</h2>
            <ol className="mt-3 flex flex-col">
              {description.steps.map((step, index) => (
                <StepItem key={step.nodeId} step={step} index={index} from={branchParent(workflow, description.steps, index)} last={index === description.steps.length - 1} />
              ))}
            </ol>
          </section>
          <aside className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Plug className="size-3.5" aria-hidden /> Apps it uses
              </p>
              {description.apps.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">Only built-in nodes.</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {description.apps.map((id) => {
                    const connector = getConnector(id);
                    return connector === undefined ? null : (
                      <li key={id} className="flex items-center gap-2 text-[13px]">
                        <ConnectorIcon connector={connector} size={12} />
                        <span className="font-medium">{connector.name}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            {description.agents.length === 0 ? null : (
              <div className="flex flex-col gap-2">
                <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Bot className="size-3.5" aria-hidden /> Coding agents
                </p>
                <ul className="flex flex-col gap-1.5 text-[13px] font-medium">
                  {description.agents.map((id) => (
                    <li key={id}>{AGENT_OPTIONS.find((option) => option.value === id)?.label ?? id}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="rounded-xl border bg-muted/40 p-4 text-sm">
              <p className="font-medium">What is {brand.name}?</p>
              <p className="mt-1 text-muted-foreground">A workflow builder for coding agents: tickets in, reviewed pull requests out. Claude Code and Codex plan, review each other and ship behind your guardrails.</p>
              <Button variant="link" className="mt-1 h-auto px-0" nativeButton={false} render={<Link href="/" />}>
                Learn more <ArrowRight data-icon="inline-end" />
              </Button>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
