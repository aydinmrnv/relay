import { Loader2 } from 'lucide-react';

export default function Loading() {
  return (
    <div className="flex min-h-[50dvh] flex-1 items-center justify-center" aria-busy="true" aria-label="Loading">
      <Loader2 className="size-5 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
    </div>
  );
}
