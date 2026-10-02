'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { BrandMark } from '@/components/app/brand-mark';
import { ThemeToggle } from '@/components/app/theme-toggle';
import { useStudioEntry } from '@/components/marketing/primitives';
import { useBrand } from '@/hooks/use-brand';

/** What goes around a recording: the site's name, the way to more recordings, and the way into the builder. */
export function ReplayFrame({ children }: { children: React.ReactNode }) {
  const brand = useBrand();
  const entry = useStudioEntry();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
        <div className="container flex h-14 items-center gap-3">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <BrandMark className="size-7" />
            {brand.name}
          </Link>
          <Link href="/r" className="mr-auto text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            Recordings
          </Link>
          <ThemeToggle className="size-8" />
          <Button size="sm" variant="outline" nativeButton={false} render={<Link href={entry.builder} />}>
            {entry.signedIn ? 'Open the builder' : 'Open the playground'}
          </Button>
        </div>
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
