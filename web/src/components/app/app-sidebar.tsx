'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'motion/react';
import { BookOpen, Cable, LayoutDashboard, LayoutTemplate, Play, Settings, Loader2, Workflow } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';
import { useBrand } from '@/hooks/use-brand';
import { useAgentsStore } from '@/hooks/use-agent-accounts';
import { useCompanion } from '@/lib/companion/client';
import { cloudStatusText } from '@/components/companion/cloud-card';
import { useStudio } from '@/lib/store';
import { AGENT_IDS, AGENT_META } from '@/lib/agents/types';
import { cn } from '@/lib/utils';
import { BrandMark } from './brand-mark';
import { AccountMenu } from '@/components/account/account-menu';

interface NavItem {
  href: string;
  label: string;
  icon: typeof Workflow;
  /** Shown as the tooltip when the sidebar is collapsed, and to screen readers. */
  hint: string;
}

const GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: 'Build',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, hint: 'Overview: recent runs, spend and what to do next' },
      { href: '/workflows', label: 'Workflows', icon: Workflow, hint: 'Your workflows, and the canvas to edit them' },
      { href: '/templates', label: 'Templates', icon: LayoutTemplate, hint: 'Ready-made workflows to start from' },
    ],
  },
  {
    label: 'Operate',
    items: [
      { href: '/runs', label: 'Runs', icon: Play, hint: 'Every test run, with its timeline and cost' },
      { href: '/integrations', label: 'Integrations', icon: Cable, hint: 'Apps your workflows can listen to and act on' },
    ],
  },
  {
    label: 'Learn',
    items: [{ href: '/guide', label: 'Guide', icon: BookOpen, hint: 'How the studio works, and what every part does' }],
  },
];

export function AppSidebar() {
  const pathname = usePathname();
  const brand = useBrand();
  const workflows = useStudio((state) => Object.keys(state.workflows).length);
  const running = useStudio((state) => state.runs.filter((run) => run.status === 'running').length);
  const connected = useStudio((state) => Object.keys(state.connections).length);

  const badgeFor = (href: string): React.ReactNode => {
    if (href === '/workflows' && workflows > 0) return workflows;
    if (href === '/integrations' && connected > 0) return connected;
    if (href === '/runs' && running > 0) {
      return (
        <span className="flex items-center gap-1 text-signal" title={`${running} running`}>
          <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
          {running}
        </span>
      );
    }
    return null;
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link href="/" />} tooltip={`${brand.name} home`}>
              <BrandMark className="size-8" />
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate font-semibold tracking-tight">{brand.name}</span>
                <span className="truncate text-xs text-muted-foreground">Workflow studio</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {GROUPS.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                  const badge = badgeFor(item.href);
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        isActive={active}
                        tooltip={item.hint}
                        render={<Link href={item.href} />}
                        className="relative data-active:bg-transparent data-active:font-medium"
                      >
                        {active ? (
                          <motion.span
                            layoutId="sidebar-active"
                            className="absolute inset-0 rounded-md bg-sidebar-accent shadow-xs ring-1 ring-sidebar-border"
                            transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                          />
                        ) : null}
                        <item.icon className="relative" />
                        <span className="relative">{item.label}</span>
                      </SidebarMenuButton>
                      {badge === null ? null : <SidebarMenuBadge>{badge}</SidebarMenuBadge>}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <AgentsFooter />
        <AccountMenu />
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={pathname.startsWith('/settings')}
              tooltip="Settings: product name, sign-ins, execution, your data"
              render={<Link href="/settings" />}
            >
              <Settings />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/** The paired machine, and which coding agents are signed in there: the things a real run cannot do without. */
function AgentsFooter() {
  const bridge = useAgentsStore((state) => state.bridge);
  const status = useAgentsStore((state) => state.status);
  const companion = useCompanion((state) => state.status);
  const host = useCompanion((state) => state.hello?.machine);
  const cloud = useCompanion((state) => (state.target === 'cloud' ? state.cloud : undefined));
  return (
    <Link
      href={companion === 'connected' ? '/settings#agents' : cloud !== undefined ? '/settings#machine' : '/connect'}
      className="mx-1 flex flex-col gap-1.5 rounded-lg border bg-background/60 p-2.5 text-xs transition-colors hover:bg-background group-data-[collapsible=icon]:hidden"
    >
      <span className="flex items-center gap-1.5 font-medium text-foreground">
        <span className="truncate">{companion === 'connected' ? (host ?? 'Your machine') : cloud !== undefined ? 'Relay Cloud' : 'No machine connected'}</span>
      </span>
      {bridge === 'unavailable' ? (
        <span className="text-muted-foreground">
          {cloud !== undefined
            ? `${cloudStatusText(companion, cloud)}. It wakes when you run something.`
            : companion === 'unreachable'
              ? 'Start relay connect again to run for real.'
              : 'Run relay connect to sign in agents and run workflows for real.'}
        </span>
      ) : (
        AGENT_IDS.map((id) => {
          const account = status?.agents[id];
          const state = account === undefined ? 'checking' : account.loggedIn ? 'signed in' : account.installed ? 'not signed in' : 'not installed';
          return (
            <span key={id} className="flex items-center gap-2 text-muted-foreground">
              <span className="text-foreground">{AGENT_META[id].name}</span>
              {/* Only the state that needs doing something about gets colour. */}
              <span className={cn('ml-auto', account?.installed === true && !account.loggedIn && 'text-amber-700 dark:text-warning')}>{state}</span>
            </span>
          );
        })
      )}
    </Link>
  );
}
