import Link from 'next/link';
import { Compass } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <main className="bg-grid flex min-h-dvh flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <span className="flex size-12 items-center justify-center rounded-2xl border bg-card text-primary shadow-xs">
        <Compass className="size-6" />
      </span>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Nothing lives at this address</h1>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">The link may be old, or the page was never here. Everything you build is in the studio.</p>
      </div>
      <div className="flex gap-2">
        <Button nativeButton={false} render={<Link href="/dashboard" />}>
          Open the studio
        </Button>
        <Button variant="outline" nativeButton={false} render={<Link href="/guide" />}>
          Read the guide
        </Button>
      </div>
    </main>
  );
}
