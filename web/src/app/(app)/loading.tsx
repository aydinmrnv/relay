import { Skeleton } from '@/components/ui/skeleton';

/** While a studio page is on its way: the shape of a page, so the frame does not jump when it lands. */
export default function StudioLoading() {
  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6" aria-busy="true" aria-label="Loading">
      <div className="grid gap-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <Skeleton className="h-28 w-full rounded-xl" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}
