'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useTheme } from 'next-themes';
import { BookOpen, ChevronDown, CircleHelp, FilePlus2, Keyboard, LayoutTemplate, Moon, Play, Plus, Search, Sparkles, Workflow as WorkflowIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Kbd } from '@/components/ui/kbd';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { StatusBadge } from '@/components/app/status-badge';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { useStudio, useWorkflows } from '@/lib/store';
import { CONNECTORS } from '@/lib/connectors';
import { TEMPLATES } from '@/lib/workflow/templates';
import { isTypingTarget } from '@/lib/shortcuts';
import { useCreateWorkflow } from '@/hooks/use-create-workflow';
import { SwitchMode } from '@/components/watermelon/switch-mode';
import { ShortcutsDialog } from './shortcuts-dialog';

const TITLES: Record<string, string> = {
  dashboard: 'Dashboard',
  workflows: 'Workflows',
  runs: 'Runs',
  integrations: 'Integrations',
  templates: 'Templates',
  settings: 'Settings',
  guide: 'Guide',
};

const PAGES = ['dashboard', 'workflows', 'templates', 'runs', 'integrations', 'guide', 'settings'] as const;

export function AppHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const workflows = useWorkflows();
  const runs = useStudio((state) => state.runs);
  const markTourSeen = useStudio((state) => state.markTourSeen);
  const create = useCreateWorkflow();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen((value) => !value);
        return;
      }
      if (event.key === '?' && !event.metaKey && !event.ctrlKey && !isTypingTarget(event.target)) {
        event.preventDefault();
        setShortcutsOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const segments = pathname.split('/').filter(Boolean);
  const section = segments[0] ?? 'dashboard';
  const detail = segments[1];
  const detailLabel = useMemo(() => {
    if (section === 'workflows' && detail !== undefined) return workflows.find((workflow) => workflow.id === detail)?.name ?? 'Workflow';
    if (section === 'runs' && detail !== undefined) {
      const run = runs.find((candidate) => candidate.id === detail);
      return run === undefined ? 'Run' : `${run.workflowName} · ${run.shortId}`;
    }
    return undefined;
  }, [section, detail, workflows, runs]);

  const go = (href: string) => {
    setSearchOpen(false);
    router.push(href);
  };

  const replayTour = () => {
    markTourSeen('builder', false);
    const first = workflows[0];
    router.push(first === undefined ? '/workflows' : `/workflows/${first.id}`);
  };

  return (
    <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/65">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 h-4 data-vertical:self-center" />
      <Breadcrumb className="min-w-0">
        <BreadcrumbList className="flex-nowrap">
          <BreadcrumbItem>
            {detailLabel === undefined ? (
              <BreadcrumbPage>{TITLES[section] ?? section}</BreadcrumbPage>
            ) : (
              <BreadcrumbLink render={<Link href={`/${section}`} />}>{TITLES[section] ?? section}</BreadcrumbLink>
            )}
          </BreadcrumbItem>
          {detailLabel === undefined ? null : (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem className="min-w-0">
                <BreadcrumbPage className="max-w-72 truncate">{detailLabel}</BreadcrumbPage>
              </BreadcrumbItem>
            </>
          )}
        </BreadcrumbList>
      </Breadcrumb>

      <div className="ml-auto flex items-center gap-1.5">
        <Button variant="outline" size="sm" className="hidden w-52 justify-start gap-2 text-muted-foreground md:inline-flex" onClick={() => setSearchOpen(true)}>
          <Search className="size-3.5" />
          <span className="flex-1 text-left">Search…</span>
          <Kbd>⌘K</Kbd>
        </Button>
        <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Search" onClick={() => setSearchOpen(true)}>
          <Search />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Help" />}>
            <CircleHelp />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Help</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => router.push('/guide')}>
                <BookOpen /> How the studio works
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShortcutsOpen(true)}>
                <Keyboard /> Keyboard shortcuts
                <Kbd className="ml-auto">?</Kbd>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={replayTour}>
                <Sparkles /> Replay the builder tour
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => router.push('/guide#real-vs-simulated')}>
                <CircleHelp /> What is real and what is simulated
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <SwitchMode width={46} height={24} darkColor="#15131c" lightColor="#ffffff" knobDarkColor="#2b2838" knobLightColor="#f4f3f8" borderDarkColor="#3d3a4a" borderLightColor="#dddbe6" />

        <ButtonGroup>
          <Button size="sm" onClick={() => create.blank()}>
            <Plus data-icon="inline-start" />
            <span className="hidden sm:inline">New workflow</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="icon-sm" aria-label="More ways to create a workflow" className="border-l border-primary-foreground/20" />}>
              <ChevronDown />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Create a workflow</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => create.blank()}>
                  <FilePlus2 /> Blank canvas
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => router.push('/templates')}>
                  <LayoutTemplate /> Browse templates…
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>Quick start</DropdownMenuLabel>
                {TEMPLATES.slice(0, 3).map((template) => (
                  <DropdownMenuItem key={template.id} onClick={() => create.fromTemplate(template.id)}>
                    <WorkflowIcon /> {template.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </ButtonGroup>
      </div>

      <CommandDialog open={searchOpen} onOpenChange={setSearchOpen} title="Search" description="Jump to a workflow, a run, an app or a page.">
        <CommandInput placeholder="Search workflows, runs, apps, pages…" />
        <CommandList className="max-h-[420px]">
          <CommandEmpty>Nothing matches.</CommandEmpty>
          <CommandGroup heading="Actions">
            <CommandItem
              value="new blank workflow create"
              onSelect={() => {
                setSearchOpen(false);
                create.blank();
              }}
            >
              <Plus /> New blank workflow
            </CommandItem>
            <CommandItem value="shortcuts keyboard help" onSelect={() => { setSearchOpen(false); setShortcutsOpen(true); }}>
              <Keyboard /> Keyboard shortcuts
              <CommandShortcut>?</CommandShortcut>
            </CommandItem>
            <CommandItem value="toggle theme dark light" onSelect={() => { setSearchOpen(false); setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'); }}>
              <Moon /> Toggle dark mode
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading="Pages">
            {PAGES.map((page) => (
              <CommandItem key={page} value={`page ${TITLES[page]}`} onSelect={() => go(`/${page}`)}>
                Go to {TITLES[page]}
              </CommandItem>
            ))}
          </CommandGroup>
          {workflows.length > 0 ? (
            <CommandGroup heading="Workflows">
              {workflows.map((workflow) => (
                <CommandItem key={workflow.id} value={`workflow ${workflow.name} ${workflow.id}`} onSelect={() => go(`/workflows/${workflow.id}`)}>
                  <WorkflowIcon /> {workflow.name}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {runs.length > 0 ? (
            <CommandGroup heading="Recent runs">
              {runs.slice(0, 8).map((run) => (
                <CommandItem key={run.id} value={`run ${run.shortId} ${run.workflowName} ${String(run.trigger.payload['title'] ?? '')}`} onSelect={() => go(`/runs/${run.id}`)}>
                  <Play /> <span className="truncate">{run.workflowName}</span>
                  <span className="font-mono text-xs text-muted-foreground">{run.shortId}</span>
                  <StatusBadge status={run.status} className="ml-auto h-4.5 text-[10px]" />
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          <CommandGroup heading="Templates">
            {TEMPLATES.map((template) => (
              <CommandItem key={template.id} value={`template ${template.name} ${template.tags.join(' ')}`} onSelect={() => { setSearchOpen(false); create.fromTemplate(template.id); }}>
                <LayoutTemplate /> Use “{template.name}”
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Apps">
            {CONNECTORS.filter((connector) => connector.category !== 'core').map((connector) => (
              <CommandItem key={connector.id} value={`app ${connector.name} ${(connector.tags ?? []).join(' ')}`} onSelect={() => go(`/integrations?app=${encodeURIComponent(connector.id)}`)}>
                <ConnectorIcon connector={connector} size={14} variant="mark" />
                {connector.name}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </header>
  );
}
