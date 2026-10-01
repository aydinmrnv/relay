'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { RotateCw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SUPPORT_EMAIL } from '@/lib/links';
import { resetLocalData } from '@/lib/store';

/**
 * What a page shows when it threw while drawing, instead of the framework's
 * blank "This page couldn't load". It says what happened in plain words,
 * offers to try again, and — because a damaged copy of the studio's data in
 * this browser is the one cause a reload cannot fix — offers to clear that.
 */
export function ErrorScreen({ error, retry, studio = false }: { error: Error & { digest?: string }; retry: () => void; /** Inside the studio, where a link back to the dashboard makes sense. */ studio?: boolean }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="flex max-w-md flex-col items-center gap-3 text-center" role="alert">
        <span className="flex size-11 items-center justify-center rounded-xl border bg-card text-destructive">
          <TriangleAlert className="size-5" aria-hidden />
        </span>
        <h1 className="text-xl font-semibold tracking-tight">This page hit an error</h1>
        <p className="text-sm text-pretty text-muted-foreground">
          Something went wrong while drawing it. Your saved work is not affected. Trying again usually does it; if it keeps happening, tell us at{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="font-medium text-foreground underline underline-offset-4">
            {SUPPORT_EMAIL}
          </a>
          {error.digest === undefined ? '' : ` and mention ${error.digest}`}.
        </p>
        <div className="mt-1 flex flex-wrap justify-center gap-2">
          <Button onClick={() => retry()}>
            <RotateCw data-icon="inline-start" /> Try again
          </Button>
          <Button variant="outline" nativeButton={false} render={<Link href={studio ? '/dashboard' : '/'} />}>
            {studio ? 'Go to the dashboard' : 'Back to the site'}
          </Button>
        </div>
        {studio ? (
          <button type="button" onClick={resetLocalData} className="mt-2 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">
            Still broken after a reload? Reset what this browser saved (your account is not touched)
          </button>
        ) : null}
      </div>
    </div>
  );
}
