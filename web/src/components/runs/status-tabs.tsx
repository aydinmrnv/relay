'use client';

import { motion } from 'motion/react';
import { useCalmMotion } from '@/components/motion/use-calm-motion';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

export type StatusFilter = 'all' | 'running' | 'succeeded' | 'failed' | 'refused' | 'cancelled';

export const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'failed', label: 'Failed' },
  { value: 'refused', label: 'Refused' },
  { value: 'cancelled', label: 'Cancelled' },
];

export function isStatusFilter(value: unknown): value is StatusFilter {
  return STATUS_FILTERS.some((filter) => filter.value === value);
}

/** Status tabs with a count on each; the highlight slides to the selected one. */
export function StatusTabs({ value, counts, onChange, className }: { value: StatusFilter; counts: Record<StatusFilter, number>; onChange: (value: StatusFilter) => void; className?: string }) {
  const reduce = useCalmMotion();
  return (
    <Tabs value={value} onValueChange={(next) => isStatusFilter(next) && onChange(next)} className={cn('min-w-0', className)}>
      <div className="-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
        <TabsList aria-label="Filter runs by status" className="h-9">
          {STATUS_FILTERS.map((filter) => {
            const active = filter.value === value;
            const count = counts[filter.value];
            return (
              <TabsTrigger
                key={filter.value}
                value={filter.value}
                className="relative px-2.5 data-active:bg-transparent data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-transparent group-data-[variant=default]/tabs-list:data-active:shadow-none"
              >
                {active ? (
                  <motion.span
                    layoutId="runs-status-tab"
                    className="absolute inset-0 rounded-md bg-background shadow-sm ring-1 ring-foreground/5 dark:bg-input/40"
                    transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 36 }}
                  />
                ) : null}
                <span className="relative z-10 flex items-center gap-1.5">
                  {filter.label}
                  <span className={cn('rounded-full px-1.5 text-[11px] font-medium tabular-nums', active ? 'bg-muted text-foreground' : 'text-muted-foreground')}>{count}</span>
                </span>
              </TabsTrigger>
            );
          })}
        </TabsList>
      </div>
    </Tabs>
  );
}
