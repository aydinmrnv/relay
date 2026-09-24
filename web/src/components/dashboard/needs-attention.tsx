'use client';

import Link from 'next/link';
import { ChevronRight, CircleCheck, OctagonAlert, ShieldAlert, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AttentionItem } from './derive';

const LIMIT = 6;

/** Failed and refused runs from the last week, and workflows that would not pass validation, each one click from the fix. */
export function NeedsAttention({ items, now, className }: { items: AttentionItem[]; now: number; className?: string }) {
  const failed = items.filter((item) => item.kind === 'run' && item.status === 'failed').length;
  const refused = items.filter((item) => item.kind === 'run' && item.status === 'refused').length;
  const shown = items.slice(0, LIMIT);

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Needs attention</CardTitle>
        <CardDescription>
          {items.length === 0 ? 'Nothing is waiting on you.' : 'Failed or refused runs from the last 7 days, and workflows with errors.'}
        </CardDescription>
        {failed + refused > 0 ? (
          <CardAction>
            <Button variant="ghost" size="sm" nativeButton={false} render={<Link href={`/runs?status=${failed > 0 ? 'failed' : 'refused'}`} />}>
              {failed > 0 ? 'Failed' : 'Refused'} runs <ChevronRight data-icon="inline-end" />
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        {items.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center">
            <CircleCheck className="size-5 text-success" />
            <p className="text-sm font-medium">All clear</p>
            <p className="max-w-64 text-xs text-muted-foreground">No failed or refused runs this week, and every workflow validates.</p>
          </div>
        ) : (
          <ul className="-mx-2 flex flex-col">
            {shown.map((item) => (
              <li key={`${item.kind}-${item.id}`}>
                <Link href={item.href} className="group flex items-start gap-3 rounded-lg px-2 py-2.5 outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50">
                  <ItemIcon item={item} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="truncate text-sm font-medium">{item.title}</p>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {item.kind === 'run' ? timeAgo(item.at, now) : `${item.errors} ${item.errors === 1 ? 'error' : 'errors'}`}
                      </span>
                    </div>
                    <p className="line-clamp-2 text-xs text-pretty text-muted-foreground">{item.reason}</p>
                  </div>
                  <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" aria-hidden />
                  <span className="sr-only">{item.kind === 'run' ? `Open run ${item.shortId}` : 'Fix it in the builder'}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {items.length > LIMIT ? <p className="mt-2 text-xs text-muted-foreground">and {items.length - LIMIT} more</p> : null}
      </CardContent>
    </Card>
  );
}

function ItemIcon({ item }: { item: AttentionItem }) {
  const cls = 'mt-0.5 size-4 shrink-0';
  if (item.kind === 'workflow') return <OctagonAlert className={cn(cls, 'text-destructive')} aria-label="Validation errors" />;
  return item.status === 'failed' ? <XCircle className={cn(cls, 'text-destructive')} aria-label="Failed" /> : <ShieldAlert className={cn(cls, 'text-amber-600 dark:text-warning')} aria-label="Refused" />;
}
