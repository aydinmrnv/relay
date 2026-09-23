import { AppSidebar } from '@/components/app/app-sidebar';
import { AppHeader } from '@/components/app/app-header';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';

export default function AppLayout({ children }: LayoutProps<'/'>) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <AppHeader />
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
