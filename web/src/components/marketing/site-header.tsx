'use client';

import Link from 'next/link';
import { ArrowRight, Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { BrandMark } from '@/components/app/brand-mark';
import { useBrand } from '@/hooks/use-brand';
import { AppMark, REPO_URL, SECTIONS } from './primitives';

export function SiteHeader() {
  const brand = useBrand();

  return (
    <header className="sticky top-0 z-40 border-b bg-background/75 backdrop-blur-md supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-14 items-center gap-3">
        <Link href="/" className="mr-auto flex items-center gap-2 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50 lg:mr-0">
          <BrandMark className="size-7" />
          <span className="font-semibold tracking-tight">{brand.name}</span>
          <Badge variant="secondary" className="hidden sm:inline-flex">
            prototype
          </Badge>
        </Link>

        <nav aria-label="Sections" className="mx-auto hidden items-center gap-1 lg:flex">
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
            aria-label={`The ${brand.name} CLI on GitHub`}
            title={`The ${brand.name} CLI on GitHub`}
            nativeButton={false}
            render={<a href={REPO_URL} target="_blank" rel="noreferrer" />}
          >
            <AppMark connector="github" size={16} />
          </Button>
          <Button size="sm" className="h-8 px-3" nativeButton={false} render={<Link href="/dashboard" />}>
            Open the studio
            <ArrowRight data-icon="inline-end" />
          </Button>
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
                <Button nativeButton={false} render={<Link href="/dashboard" />}>
                  Open the studio
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
