import { AppSidebar } from '@/components/app/app-sidebar';
import { AppHeader } from '@/components/app/app-header';
import { DemoBanner } from '@/components/app/demo-banner';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { WorkspaceGate } from '@/components/account/workspace-gate';

export default function AppLayout({ children }: LayoutProps<'/'>) {
  return (
    <SidebarProvider>
      <AppSidebar />
      {/* The builder is a tool, not a page: it takes exactly the window, so its canvas and panels scroll, not the document. */}
      <SidebarInset className="min-w-0 has-data-builder:h-dvh has-data-builder:overflow-hidden">
        <DemoBanner />
        <AppHeader />
        <div className="flex min-h-0 flex-1 flex-col">
          <WorkspaceGate>{children}</WorkspaceGate>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
