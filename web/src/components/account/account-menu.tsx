'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useClerk } from '@clerk/nextjs';
import { ChevronsUpDown, CloudUpload, LogIn, LogOut, Rocket, Settings, UserPlus, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { useAccount } from '@/lib/cloud/account';
import { signOut } from '@/lib/cloud/sync';
import { UserAvatar } from './user-avatar';
import { PROFILE_APPEARANCE } from './account-settings';

/**
 * The bottom of the sidebar: who is signed in, with their account menu — or,
 * for a guest, what an account would give them and the way to make one.
 */
export function AccountMenu() {
  const status = useAccount((state) => state.status);
  const user = useAccount((state) => state.user);

  if (status === 'disabled' || status === 'unknown') return null;

  if (status !== 'signed-in' || user === null) {
    if (status === 'loading') return null;
    return (
      <div className="mx-1 flex flex-col gap-2 rounded-lg border border-dashed bg-background/60 p-2.5 text-xs group-data-[collapsible=icon]:hidden">
        <span className="flex items-center gap-1.5 font-medium text-foreground">
          <CloudUpload className="size-3.5 text-primary" aria-hidden /> Guest mode
        </span>
        <span className="text-muted-foreground">Your work lives in this browser. An account keeps it everywhere, with sharing and history.</span>
        <div className="flex gap-1.5">
          <Button size="xs" className="flex-1" nativeButton={false} render={<Link href="/sign-up" />}>
            <UserPlus data-icon="inline-start" /> Sign up
          </Button>
          <Button size="xs" variant="outline" className="flex-1" nativeButton={false} render={<Link href="/sign-in" />}>
            <LogIn data-icon="inline-start" /> Sign in
          </Button>
        </div>
      </div>
    );
  }

  return <SignedInMenu />;
}

/** Only ever rendered signed in, which means inside Clerk's provider. */
function SignedInMenu() {
  const router = useRouter();
  const clerk = useClerk();
  const { isMobile } = useSidebar();
  const user = useAccount((state) => state.user)!;
  const onboarded = useAccount((state) => state.onboardedAt !== null);

  const leave = async () => {
    if (!(await signOut(() => clerk.signOut()))) return;
    toast.success('Signed out', { description: 'Your workflows are safe in your account.' });
    router.push('/');
  };

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuButton size="lg" className="data-popup-open:bg-sidebar-accent" tooltip={user.name} />}>
            <UserAvatar user={user} size="sm" className="size-7" />
            <span className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{user.name}</span>
              <span className="truncate text-xs text-muted-foreground">{user.email}</span>
            </span>
            <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side={isMobile ? 'bottom' : 'right'} align="end" className="w-60">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="flex items-center gap-2 py-1.5">
                <UserAvatar user={user} size="sm" />
                <span className="grid min-w-0 text-left leading-tight">
                  <span className="truncate font-medium text-foreground">{user.name}</span>
                  <span className="truncate text-xs">{user.email}</span>
                </span>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {onboarded ? null : (
                <DropdownMenuItem render={<Link href="/onboarding" />}>
                  <Rocket /> Finish setting up
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => clerk.openUserProfile({ appearance: PROFILE_APPEARANCE })}>
                <UserRound /> Manage account
              </DropdownMenuItem>
              <DropdownMenuItem render={<Link href="/settings" />}>
                <Settings /> Settings
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void leave()}>
              <LogOut /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
