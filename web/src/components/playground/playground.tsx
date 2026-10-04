'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { ChevronDown, Plus, ShieldAlert, Video, WandSparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { BrandMark } from '@/components/app/brand-mark';
import { ThemeToggle } from '@/components/app/theme-toggle';
import { Builder } from '@/components/builder/builder';
import { DescribeWorkflowDialog } from '@/components/workflows/describe-workflow';
import { useBrand } from '@/hooks/use-brand';
import { useAccount, useCapabilities } from '@/lib/cloud/account';
import { hostileIssueWorkflow, openPlayground, PLAYGROUND_TEMPLATE, playgroundGate, playgroundTemplate, rememberPlayground, rememberedPlayground, untouchedExample } from '@/lib/playground';
import { useStudio } from '@/lib/store';
import { PLAYGROUND_LINKS, StudioLinksContext } from '@/lib/studio-links';
import { blankWorkflow, TEMPLATES } from '@/lib/workflow/templates';
import type { Workflow } from '@/lib/workflow/schema';

/** Which workflow the playground's canvas has open. The id is also kept in this browser, for the next visit. */
const usePlayground = create<{ workflowId: string | null }>()(() => ({ workflowId: null }));

/**
 * Puts a workflow on the playground's canvas. An example nobody changed makes
 * way for it; anything the visitor edited stays in this browser, under
 * "Yours" in the Start from menu, and is offered to them when they make an
 * account.
 */
function show(workflow: Workflow): void {
  const studio = useStudio.getState();
  const current = usePlayground.getState().workflowId;
  const before = current === null ? undefined : studio.workflows[current];
  if (before !== undefined && before.id !== workflow.id && untouchedExample(before)) studio.deleteWorkflow(before.id);
  // Not `upsertWorkflow`, which stamps a new `updatedAt`: a template just opened is still untouched.
  if (useStudio.getState().workflows[workflow.id] === undefined) useStudio.setState((state) => ({ workflows: { ...state.workflows, [workflow.id]: workflow } }));
  rememberPlayground(workflow.id);
  usePlayground.setState({ workflowId: workflow.id });
}

function useGate() {
  const hydrated = useStudio((state) => state.hydrated);
  const owner = useStudio((state) => state.owner);
  const status = useAccount((state) => state.status);
  return playgroundGate({ hydrated, owner, status });
}

/**
 * What goes around the playground's pages: the links that keep a visitor in
 * it, a header saying what this is, and the wait for the saved store. Someone
 * signed in is sent to the studio, which is the same builder with their own
 * work in it.
 */
export function PlaygroundFrame({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const gate = useGate();
  useEffect(() => {
    if (gate === 'account') router.replace('/dashboard');
  }, [gate, router]);
  return (
    <StudioLinksContext value={PLAYGROUND_LINKS}>
      {/* The builder is a tool, not a page: it takes exactly the window, so its canvas and panels scroll, not the document. */}
      <div className="flex min-h-dvh min-w-0 flex-col has-data-builder:h-dvh has-data-builder:overflow-hidden">
        <PlaygroundHeader />
        <div className="flex min-h-0 flex-1 flex-col" aria-busy={gate !== 'open'}>
          {gate === 'open' ? children : null}
        </div>
      </div>
    </StudioLinksContext>
  );
}

function PlaygroundHeader() {
  const brand = useBrand();
  const pathname = usePathname();
  const accounts = useCapabilities().enabled;
  return (
    <header className="flex h-12 shrink-0 items-center gap-2.5 border-b bg-background px-3">
      <Link href="/" className="flex shrink-0 items-center gap-2 font-semibold tracking-tight">
        <BrandMark className="size-6" />
        <span className="hidden sm:inline">{brand.name}</span>
      </Link>
      <Badge variant="secondary">Playground</Badge>
      <p className="hidden min-w-0 truncate text-xs text-muted-foreground lg:block">No account needed. Your work stays in this browser, and test runs are simulated: nothing is called or billed. Export it, and the relay CLI runs the same workflow for real.</p>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {/* Test runs here are simulated; this is where to see what a real one did. */}
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/r" />} className="hidden md:inline-flex">
          <Video data-icon="inline-start" /> Watch a real run
        </Button>
        {pathname === '/play' ? <StartFrom /> : null}
        <ThemeToggle className="size-8" />
        {accounts ? (
          <Button size="sm" nativeButton={false} render={<Link href="/sign-in" />} title="An account keeps your workflows in any browser, and adds share links, version history and real runs.">
            <span className="sm:hidden">Sign up</span>
            <span className="hidden sm:inline">Create a free account</span>
          </Button>
        ) : null}
      </div>
    </header>
  );
}

/** Another starting point for the canvas: a sentence, a template, a blank canvas, or something made here earlier. */
function StartFrom() {
  const brand = useBrand();
  const [describeOpen, setDescribeOpen] = useState(false);
  const current = usePlayground((state) => state.workflowId);
  const workflows = useStudio((state) => state.workflows);
  const yours = Object.values(workflows)
    .filter((workflow) => workflow.id !== current && !untouchedExample(workflow))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 6);
  const template = (id: string) => {
    const workflow = playgroundTemplate(id, brand);
    if (workflow !== undefined) show(workflow);
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
          Start from <ChevronDown data-icon="inline-end" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => setDescribeOpen(true)}>
              <WandSparkles /> A sentence: describe it
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => show(blankWorkflow(brand))}>
              <Plus /> A blank canvas
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                const workflow = hostileIssueWorkflow(brand);
                if (workflow !== undefined) show(workflow);
              }}
            >
              <ShieldAlert /> A hostile issue: try to get it past the screen
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Templates</DropdownMenuLabel>
            {TEMPLATES.map((meta) => (
              <DropdownMenuItem key={meta.id} onClick={() => template(meta.id)} title={meta.when}>
                <span className="truncate">{meta.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          {yours.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>Yours, in this browser</DropdownMenuLabel>
                {yours.map((workflow) => (
                  <DropdownMenuItem key={workflow.id} onClick={() => show(workflow)}>
                    <span className="truncate">{workflow.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <DescribeWorkflowDialog open={describeOpen} onOpenChange={setDescribeOpen} onCreate={show} />
    </>
  );
}

/**
 * The builder, open on the workflow this browser had last, or on the starting
 * template for a first visit. `?template=<id>` starts from that template and
 * `?open=<id>` opens a workflow already here, which is how a run's page gets
 * back to the workflow it ran.
 */
export function Playground() {
  const brand = useBrand();
  const disabled = useAccount((state) => state.status === 'disabled');
  const workflowId = usePlayground((state) => state.workflowId);
  const exists = useStudio((state) => workflowId !== null && state.workflows[workflowId] !== undefined);

  useEffect(() => {
    const studio = useStudio.getState();
    const query = new URLSearchParams(window.location.search);
    const asked = query.get('open');
    const template = query.get('template');
    if (asked !== null || template !== null) window.history.replaceState(null, '', '/play');
    const fromTemplate = template === null ? undefined : playgroundTemplate(template, brand);
    if (fromTemplate !== undefined) {
      show(fromTemplate);
      return;
    }
    const remembered = asked !== null && studio.workflows[asked] !== undefined ? asked : rememberedPlayground();
    // With accounts off nothing is synced, so a store that still names an account is this browser's own.
    const opening = openPlayground({ owner: disabled ? null : studio.owner, workflows: studio.workflows }, remembered, brand);
    if (opening !== null) show(opening.workflow);
    // Once, when the page opens: the frame only renders it for a browser the playground may use.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Deleted from under the canvas (another tab cleared this browser's data): start again rather than show nothing.
  useEffect(() => {
    if (workflowId === null || exists) return;
    const workflow = playgroundTemplate(PLAYGROUND_TEMPLATE, brand);
    if (workflow !== undefined) show(workflow);
  }, [workflowId, exists, brand]);

  if (workflowId === null || !exists) return null;
  return <Builder key={workflowId} workflowId={workflowId} />;
}
