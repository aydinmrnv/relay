'use client';

import { usePathname } from 'next/navigation';
import { AppSidebar } from '@/components/app/app-sidebar';
import { AppHeader } from '@/components/app/app-header';
import { DemoBanner } from '@/components/app/demo-banner';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { WorkspaceGate } from '@/components/account/workspace-gate';
import { SiteFooter } from '@/components/marketing/closing';
import { SiteHeader } from '@/components/marketing/site-header';
import { useAccount, useCapabilities } from '@/lib/cloud/account';
import { isStudioPath } from '@/lib/studio-routes';

/**
 * What goes around a page under `(app)`.
 *
 * The studio's screens get the studio: sidebar, header, and the gate that
 * waits for the workspace. The two public pages that live here as well, the
 * guide and "Where agents run", get the studio around them only for someone
 * who is in it. To a signed-out visitor they are pages of the site, with the
 * site's header and footer: a sidebar of nine links that all bounce to
 * sign-in is not navigation.
 *
 * The server does not know who is signed in, so it renders the public pages
 * as the site sees them; someone signed in who opens one directly sees it
 * change to the studio once their account is known.
 */
export function AppFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const signedIn = useAccount((state) => state.status === 'signed-in');
  const guests = useCapabilities().guests;
  if (!isStudioPath(pathname) && !signedIn && !guests) {
    return (
      <div className="flex min-h-full flex-1 flex-col">
        <SiteHeader />
        <main className="flex flex-1 flex-col pt-4">{children}</main>
        <SiteFooter />
      </div>
    );
  }
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
