'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { ArrowRight, LayoutDashboard, LogOut, Menu, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { BrandMark } from '@/components/app/brand-mark';
import { ThemeToggle } from '@/components/app/theme-toggle';
import { LiquidGlass } from '@/components/glass/liquid-glass';
import { useScrollSpy } from '@/components/guide/use-scroll-spy';
import { useBrand } from '@/hooks/use-brand';
import { useAccount, useCapabilities } from '@/lib/cloud/account';
import { UserAvatar } from '@/components/account/user-avatar';
import { useSignOut } from '@/components/account/account-menu';
import type { AccountUser } from '@/lib/cloud/types';
import { cn } from '@/lib/utils';
import { AppMark, REPO_URL, SECTIONS, useCalmMotion, useStudioEntry } from './primitives';

// Every section on the page, in the order it is on the page: the hero first,
// so nothing is marked while the reader is still above them all, and
// "features", which has no link of its own, so that reading it does not leave
// the link before it lit.
const SPY = ['top', 'how', 'builder', 'features', 'different', 'integrations', 'pricing', 'faq'];
const NONE: string[] = [];
// A wide bar: a flat, frosted middle, with the bend kept to the rim as in Apple's bars.
const HEADER_OPTICS = { strength: 0.02, depth: 0.3, curvature: 0.04, bend: 0.85, bendWidth: 0.26, frost: 14 };

/**
 * The site's navigation: a capsule of liquid glass floating over the page,
 * bending whatever scrolls beneath it.
 * `overlay` lets the section under it (the landing page's hero, and its
 * glow) start at the top of the window, behind the glass.
 */
export function SiteHeader({ overlay = false }: { overlay?: boolean }) {
  const brand = useBrand();
  const status = useAccount((state) => state.status);
  const user = useAccount((state) => state.user);
  const accounts = useCapabilities().enabled;
  const signedIn = status === 'signed-in' && user !== null;
  const entry = useStudioEntry();
  // Only the landing page has the sections; elsewhere the links lead back to it.
  const current = useScrollSpy(overlay ? SPY : NONE);
  const calm = useCalmMotion();

  return (
    <header className={cn('pointer-events-none sticky top-0 z-40 px-3 pt-3', overlay && '-mb-17')}>
      <LiquidGlass optics={HEADER_OPTICS} className="pointer-events-auto mx-auto h-14 max-w-6xl rounded-full" style={{ display: 'block' }}>
        <div className="flex h-full items-center gap-3 pr-2 pl-4 text-foreground">
          <Link
            href="/"
            className="mr-auto flex items-center gap-2 rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50 lg:mr-0"
          >
            <BrandMark className="size-6" />
            <span className="font-semibold tracking-tight">{brand.name}</span>
            <Badge variant="secondary" className="hidden bg-foreground/[0.07] sm:inline-flex">
              beta
            </Badge>
          </Link>

          <nav aria-label="Sections" className="mx-auto hidden lg:block">
            <ul className="flex items-center gap-7">
              {SECTIONS.map((section) => {
                const active = current === section.id;
                return (
                  <li key={section.id} className="relative py-1">
                    <a
                      href={`/#${section.id}`}
                      aria-current={active ? 'location' : undefined}
                      className={cn(
                        'rounded-sm px-0.5 text-sm transition-colors duration-300 outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                        active ? 'text-foreground' : 'text-foreground/60 hover:text-foreground',
                      )}
                    >
                      {section.label}
                    </a>
                    {active ? (
                      <motion.span
                        layoutId="site-header-underline"
                        className="absolute right-0 -bottom-0.5 left-0 h-[1.5px] rounded-full bg-foreground"
                        transition={calm ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 30 }}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="flex items-center gap-1.5">
            <ThemeToggle className="hidden size-10 hover:bg-foreground/[0.07] sm:inline-flex dark:hover:bg-foreground/[0.07]" />
            <Button
              variant="ghost"
              size="icon"
              className="hidden size-10 rounded-full hover:bg-foreground/[0.07] sm:inline-flex dark:hover:bg-foreground/[0.07]"
              aria-label={`The ${brand.name} CLI on GitHub`}
              title={`The ${brand.name} CLI on GitHub`}
              nativeButton={false}
              render={<a href={REPO_URL} target="_blank" rel="noreferrer" />}
            >
              <AppMark connector="github" size={16} />
            </Button>
            {signedIn ? (
              <>
                <Button className="h-10 rounded-full pr-3.5 pl-4" nativeButton={false} render={<Link href="/dashboard" />}>
                  {entry.label}
                  <ArrowRight data-icon="inline-end" />
                </Button>
                <SiteAccountMenu user={user} />
              </>
            ) : accounts ? (
              <>
                <Button
                  variant="ghost"
                  className="hidden h-10 rounded-full border border-foreground/25 px-4 hover:border-foreground/50 hover:bg-foreground/[0.05] sm:inline-flex dark:hover:bg-foreground/[0.05]"
                  nativeButton={false}
                  render={<Link href="/sign-in" />}
                >
                  Sign in
                </Button>
                <Button className="h-10 rounded-full pr-3.5 pl-4" nativeButton={false} render={<Link href={entry.href} />}>
                  {entry.label}
                  <ArrowRight data-icon="inline-end" />
                </Button>
              </>
            ) : (
              <Button className="h-10 rounded-full pr-3.5 pl-4" nativeButton={false} render={<Link href={entry.href} />}>
                {entry.label}
                <ArrowRight data-icon="inline-end" />
              </Button>
            )}
            <Sheet>
              <SheetTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-10 rounded-full hover:bg-foreground/[0.07] lg:hidden dark:hover:bg-foreground/[0.07]"
                    aria-label="Open the section menu"
                  />
                }
              >
                <Menu />
              </SheetTrigger>
              <SheetContent side="right" className="w-72">
                <SheetHeader>
                  <SheetTitle>{brand.name}</SheetTitle>
                  <SheetDescription>Jump to a section, or get started.</SheetDescription>
                </SheetHeader>
                <div className="flex items-center justify-between px-5 pb-2 text-sm text-muted-foreground">
                  Theme
                  <ThemeToggle className="size-9" />
                </div>
                <nav aria-label="Sections" className="flex flex-col px-2">
                  {SECTIONS.map((section) => (
                    <SheetClose
                      key={section.id}
                      nativeButton={false}
                      render={<a href={`/#${section.id}`} />}
                      className="rounded-md px-3 py-2.5 text-sm font-medium hover:bg-muted"
                    >
                      {section.label}
                    </SheetClose>
                  ))}
                </nav>
                <div className="mt-auto flex flex-col gap-2 border-t p-4">
                  <Button nativeButton={false} render={<Link href={entry.href} />}>
                    {entry.label}
                    <ArrowRight data-icon="inline-end" />
                  </Button>
                  {accounts && !signedIn ? (
                    <Button variant="outline" nativeButton={false} render={<Link href="/sign-in" />}>
                      Sign in
                    </Button>
                  ) : null}
                  {signedIn ? <SheetSignOut /> : null}
                  <Button variant="outline" nativeButton={false} render={<a href={REPO_URL} target="_blank" rel="noreferrer" />}>
                    <AppMark connector="github" size={14} />
                    The CLI on GitHub
                  </Button>
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </LiquidGlass>
    </header>
  );
}

/** Who is signed in, with the way to the studio and out of the account. Only rendered signed in. */
function SiteAccountMenu({ user }: { user: AccountUser }) {
  const leave = useSignOut();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon" className="hidden size-10 rounded-full hover:bg-foreground/[0.07] sm:inline-flex dark:hover:bg-foreground/[0.07]" aria-label="Your account" />}
      >
        <UserAvatar user={user} size="sm" className="size-7" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
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
          <DropdownMenuItem render={<Link href="/dashboard" />}>
            <LayoutDashboard /> Dashboard
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
  );
}

function SheetSignOut() {
  const leave = useSignOut();
  return (
    <SheetClose render={<Button variant="outline" />} onClick={() => void leave()}>
      <LogOut data-icon="inline-start" /> Sign out
    </SheetClose>
  );
}
