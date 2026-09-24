import { AppSidebar } from '@/components/app/app-sidebar';
import { AppHeader } from '@/components/app/app-header';
import { DemoBanner } from '@/components/app/demo-banner';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { WorkspaceGate } from '@/components/account/workspace-gate';

export default function AppLayout({ children }: LayoutProps<'/'>) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <DemoBanner />
        <AppHeader />
        <div className="flex min-h-0 flex-1 flex-col">
          <WorkspaceGate>{children}</WorkspaceGate>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
