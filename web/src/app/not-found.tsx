import Link from 'next/link';
import { Compass } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SiteFooter } from '@/components/marketing/closing';
import { SiteHeader } from '@/components/marketing/site-header';

/**
 * Anyone can land here: a mistyped address, an old link, a shared workflow
 * its author has since unpublished. So it is a page of the site, with the
 * site's way home, and assumes nothing about being signed in.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main className="bg-grid flex flex-1 flex-col items-center justify-center gap-4 p-6 py-24 text-center">
        <span className="flex size-12 items-center justify-center rounded-2xl border bg-card text-primary shadow-xs">
          <Compass className="size-6" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Nothing lives at this address</h1>
          <p className="mt-1 max-w-md text-sm text-pretty text-muted-foreground">
            The link may be old, or the page was never here. If it was a shared workflow, its author has unpublished it.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button nativeButton={false} render={<Link href="/" />}>
            Back to the site
          </Button>
          <Button variant="outline" nativeButton={false} render={<Link href="/guide" />}>
            Read the guide
          </Button>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
