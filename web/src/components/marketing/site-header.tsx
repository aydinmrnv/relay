'use client';

import Link from 'next/link';
import { ArrowRight, Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { BrandMark } from '@/components/app/brand-mark';
import { useBrand } from '@/hooks/use-brand';
import { useAccount, useCapabilities } from '@/lib/cloud/account';
import { UserAvatar } from '@/components/account/user-avatar';
import { AppMark, REPO_URL, SECTIONS } from './primitives';

export function SiteHeader() {
  const brand = useBrand();
  const status = useAccount((state) => state.status);
  const user = useAccount((state) => state.user);
  const accounts = useCapabilities().enabled;
  const signedIn = status === 'signed-in' && user !== null;

  return (
    <header className="sticky top-0 z-40 border-b bg-background/75 backdrop-blur-md supports-[backdrop-filter]:bg-background/60">
      <div className="container max-w-6xl flex h-16 items-center gap-4">
        <Link
          href="/"
          className="mr-auto flex items-center gap-2 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50 lg:mr-0"
        >
          <BrandMark className="size-7" />
          <span className="font-semibold tracking-tight">{brand.name}</span>
          <Badge variant="secondary" className="hidden sm:inline-flex">
            beta
          </Badge>
        </Link>

        <nav aria-label="Sections" className="mx-auto hidden items-center gap-0.5 lg:flex">
          {SECTIONS.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {section.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon"
            className="hidden sm:inline-flex"
            aria-label={`The ${brand.name} CLI on GitHub`}
            title={`The ${brand.name} CLI on GitHub`}
            nativeButton={false}
            render={<a href={REPO_URL} target="_blank" rel="noreferrer" />}
          >
            <AppMark connector="github" size={16} />
          </Button>
          {signedIn ? (
            <Button size="sm" className="h-8 gap-2 px-2.5" nativeButton={false} render={<Link href="/dashboard" />}>
              <UserAvatar user={user} size="sm" className="size-5" />
              Open your studio
            </Button>
          ) : accounts ? (
            <>
              <Button size="sm" variant="ghost" className="hidden h-8 px-3 sm:inline-flex" nativeButton={false} render={<Link href="/sign-in" />}>
                Sign in
              </Button>
              <Button size="sm" className="h-8 px-3" nativeButton={false} render={<Link href="/sign-up" />}>
                Get started
                <ArrowRight data-icon="inline-end" />
              </Button>
            </>
          ) : (
            <Button size="sm" className="h-8 px-3" nativeButton={false} render={<Link href="/dashboard" />}>
              Open the studio
              <ArrowRight data-icon="inline-end" />
            </Button>
          )}
          <Sheet>
            <SheetTrigger render={<Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open the section menu" />}>
              <Menu />
            </SheetTrigger>
            <SheetContent side="right" className="w-72">
              <SheetHeader>
                <SheetTitle>{brand.name}</SheetTitle>
                <SheetDescription>Jump to a section, or open the studio.</SheetDescription>
              </SheetHeader>
              <nav aria-label="Sections" className="flex flex-col px-2">
                {SECTIONS.map((section) => (
                  <SheetClose
                    key={section.id}
                    nativeButton={false}
                    render={<a href={`#${section.id}`} />}
                    className="rounded-md px-3 py-2.5 text-sm font-medium hover:bg-muted"
                  >
                    {section.label}
                  </SheetClose>
                ))}
              </nav>
              <div className="mt-auto flex flex-col gap-2 border-t p-4">
                {accounts && !signedIn ? (
                  <>
                    <Button nativeButton={false} render={<Link href="/sign-up" />}>
                      Create a free account
                      <ArrowRight data-icon="inline-end" />
                    </Button>
                    <Button variant="outline" nativeButton={false} render={<Link href="/sign-in" />}>
                      Sign in
                    </Button>
                  </>
                ) : null}
                <Button variant={accounts && !signedIn ? 'ghost' : 'default'} nativeButton={false} render={<Link href="/dashboard" />}>
                  {signedIn ? 'Open your studio' : accounts ? 'Try it without an account' : 'Open the studio'}
                  <ArrowRight data-icon="inline-end" />
                </Button>
                <Button variant="outline" nativeButton={false} render={<a href={REPO_URL} target="_blank" rel="noreferrer" />}>
                  <AppMark connector="github" size={14} />
                  The CLI on GitHub
                </Button>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
