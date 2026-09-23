'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, BookTemplate, Cable, LayoutDashboard, Play, Settings, Workflow } from 'lucide-react';
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
import { Badge } from '@/components/ui/badge';
import { useBrand } from '@/hooks/use-brand';
import { useStudio } from '@/lib/store';
import { CATALOG_STATS } from '@/lib/connectors';
import { BrandMark } from './brand-mark';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/workflows', label: 'Workflows', icon: Workflow },
  { href: '/runs', label: 'Runs', icon: Play },
  { href: '/integrations', label: 'Integrations', icon: Cable },
  { href: '/templates', label: 'Templates', icon: BookTemplate },
] as const;

export function AppSidebar() {
  const pathname = usePathname();
  const brand = useBrand();
  const workflows = useStudio((state) => Object.keys(state.workflows).length);
  const running = useStudio((state) => state.runs.filter((run) => run.status === 'running').length);
  const connected = useStudio((state) => Object.keys(state.connections).length);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link href="/dashboard" />} tooltip={brand.name}>
              <BrandMark className="size-8" />
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate font-semibold">{brand.name}</span>
                <span className="truncate text-xs text-muted-foreground">Workflow studio · prototype</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Build</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                const badge = item.href === '/workflows' ? workflows : item.href === '/runs' ? running : item.href === '/integrations' ? connected : 0;
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton isActive={active} tooltip={item.label} render={<Link href={item.href} />}>
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                    {badge > 0 ? <SidebarMenuBadge>{badge}</SidebarMenuBadge> : null}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Catalog</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton tooltip="Connectors" render={<Link href="/integrations" />}>
                  <Activity />
                  <span>{CATALOG_STATS.connectors} connectors</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton tooltip="Triggers and actions" render={<Link href="/integrations" />}>
                  <Cable />
                  <span>
                    {CATALOG_STATS.triggers} triggers · {CATALOG_STATS.actions} actions
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={pathname.startsWith('/settings')} tooltip="Settings" render={<Link href="/settings" />}>
              <Settings />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem className="px-2 pb-1 group-data-[collapsible=icon]:hidden">
            <Badge variant="outline" className="w-full justify-center text-[10px] text-muted-foreground">
              Local only · nothing is hosted · $0
            </Badge>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
