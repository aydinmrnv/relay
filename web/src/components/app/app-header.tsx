'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useTheme } from 'next-themes';
import { Moon, Plus, Search, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { useStudio, useWorkflows } from '@/lib/store';
import { CONNECTORS } from '@/lib/connectors';
import { ConnectorIcon } from '@/components/connectors/connector-icon';
import { blankWorkflow } from '@/lib/workflow/templates';
import { useBrand } from '@/hooks/use-brand';

const TITLES: Record<string, string> = {
  dashboard: 'Dashboard',
  workflows: 'Workflows',
  runs: 'Runs',
  integrations: 'Integrations',
  templates: 'Templates',
  settings: 'Settings',
};

export function AppHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const brand = useBrand();
  const { resolvedTheme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const workflows = useWorkflows();
  const upsertWorkflow = useStudio((state) => state.upsertWorkflow);
  const repository = useStudio((state) => state.settings.defaultRepository);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
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
    if (section === 'runs' && detail !== undefined) return `Run ${detail.slice(-6)}`;
    return undefined;
  }, [section, detail, workflows]);

  const newWorkflow = () => {
    const workflow = blankWorkflow(brand, repository);
    upsertWorkflow(workflow);
    router.push(`/workflows/${workflow.id}`);
  };

  const popular = CONNECTORS.filter((connector) => connector.popular).slice(0, 8);

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 h-4" />
      <Breadcrumb>
        <BreadcrumbList>
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
              <BreadcrumbItem>
                <BreadcrumbPage className="max-w-56 truncate">{detailLabel}</BreadcrumbPage>
              </BreadcrumbItem>
            </>
          )}
        </BreadcrumbList>
      </Breadcrumb>
      <div className="ml-auto flex items-center gap-1.5">
        <Button variant="outline" size="sm" className="hidden gap-2 text-muted-foreground sm:inline-flex" onClick={() => setOpen(true)}>
          <Search className="size-3.5" />
          <span>Search</span>
          <Kbd>⌘K</Kbd>
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Toggle theme" onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}>
          <Sun className="hidden dark:block" />
          <Moon className="dark:hidden" />
        </Button>
        <Button size="sm" onClick={newWorkflow}>
          <Plus data-icon="inline-start" />
          New workflow
        </Button>
      </div>

      <CommandDialog open={open} onOpenChange={setOpen} title="Search" description="Jump to a workflow, a run, or a connector.">
        <CommandInput placeholder="Workflows, runs, connectors…" />
        <CommandList>
          <CommandEmpty>Nothing matches.</CommandEmpty>
          <CommandGroup heading="Actions">
            <CommandItem
              onSelect={() => {
                setOpen(false);
                newWorkflow();
              }}
            >
              <Plus /> New workflow
            </CommandItem>
            {(['dashboard', 'workflows', 'runs', 'integrations', 'templates', 'settings'] as const).map((page) => (
              <CommandItem
                key={page}
                onSelect={() => {
                  setOpen(false);
                  router.push(`/${page}`);
                }}
              >
                Go to {TITLES[page]}
              </CommandItem>
            ))}
          </CommandGroup>
          {workflows.length > 0 ? (
            <CommandGroup heading="Workflows">
              {workflows.slice(0, 8).map((workflow) => (
                <CommandItem
                  key={workflow.id}
                  value={`workflow ${workflow.name}`}
                  onSelect={() => {
                    setOpen(false);
                    router.push(`/workflows/${workflow.id}`);
                  }}
                >
                  {workflow.name}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          <CommandGroup heading="Connectors">
            {popular.map((connector) => (
              <CommandItem
                key={connector.id}
                value={`connector ${connector.name} ${(connector.tags ?? []).join(' ')}`}
                onSelect={() => {
                  setOpen(false);
                  router.push(`/integrations?q=${encodeURIComponent(connector.name)}`);
                }}
              >
                <ConnectorIcon connector={connector} size={14} variant="mark" />
                {connector.name}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </header>
  );
}
