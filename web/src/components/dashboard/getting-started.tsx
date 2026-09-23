'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { useCalmMotion } from '@/components/motion/use-calm-motion';
import { ArrowRight, Check, Play, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useStudio } from '@/lib/store';
import { cn } from '@/lib/utils';

export interface ChecklistStep {
  id: string;
  title: string;
  /** Why the step matters, in one sentence. */
  why: string;
  done: boolean;
  /** Replaces `why` once the step is done, e.g. who is signed in. */
  doneNote?: string;
  /** Shown under `why` while the step is open, when something stands in its way. */
  warning?: string;
  optional?: boolean;
  action: { label: string; href: string } | { label: string; onClick: () => void; icon?: 'play' | 'plus' } | null;
}

/**
 * The first-week checklist. Each step says why it matters and does the thing
 * (or takes you exactly where it is done); steps tick themselves off from the
 * store, and the card goes away on its own once every required step is done.
 */
export function GettingStarted({ steps, className }: { steps: ChecklistStep[]; className?: string }) {
  const reduce = useCalmMotion();
  const dismissChecklist = useStudio((state) => state.dismissChecklist);
  const required = steps.filter((step) => step.optional !== true);
  const done = required.filter((step) => step.done).length;
  const next = steps.find((step) => !step.done && step.optional !== true);

  const dismiss = () => {
    dismissChecklist(true);
    toast('Getting started is hidden', { description: 'Every step stays reachable from Settings, Integrations and the builder.', action: { label: 'Undo', onClick: () => dismissChecklist(false) } });
  };

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Get set up</CardTitle>
        <CardDescription>
          {done} of {required.length} done{next !== undefined ? ` · next: ${next.title.toLowerCase()}` : ''}
        </CardDescription>
        <CardAction>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Hide getting started" onClick={dismiss} className="text-muted-foreground" />}>
              <X />
            </TooltipTrigger>
            <TooltipContent>Hide this checklist</TooltipContent>
          </Tooltip>
        </CardAction>
        {/* Segmented progress: one segment per required step, filled in order of completion. */}
        <div className="col-span-full mt-2 flex gap-1" role="progressbar" aria-label="Setup progress" aria-valuenow={done} aria-valuemin={0} aria-valuemax={required.length}>
          {required.map((step, index) => (
            <span key={step.id} className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
              <motion.span
                className="block h-full rounded-full bg-success"
                initial={reduce ? false : { width: 0 }}
                animate={{ width: index < done ? '100%' : '0%' }}
                transition={{ duration: 0.4, delay: reduce ? 0 : index * 0.05 }}
              />
            </span>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {steps.map((step, index) => (
            <li
              key={step.id}
              className={cn(
                'flex gap-3 rounded-lg border p-3 transition-colors',
                step.done ? 'border-transparent bg-muted/40' : step === next ? 'border-primary/30 bg-primary/[0.03]' : 'border-border',
              )}
            >
              <span
                className={cn(
                  'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                  step.done ? 'bg-success text-white' : step === next ? 'bg-primary text-primary-foreground' : 'border text-muted-foreground',
                )}
                aria-hidden
              >
                {step.done ? <Check className="size-3" strokeWidth={3} /> : index + 1}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className={cn('flex items-center gap-2 text-sm font-medium', step.done && 'text-muted-foreground')}>
                  <span className="sr-only">{step.done ? 'Done: ' : 'To do: '}</span>
                  {step.title}
                  {step.optional === true ? (
                    <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal text-muted-foreground">
                      optional
                    </Badge>
                  ) : null}
                </p>
                <p className="text-xs text-pretty text-muted-foreground">{step.done && step.doneNote !== undefined ? step.doneNote : step.why}</p>
                {!step.done && step.warning !== undefined ? <p className="text-xs text-pretty text-amber-700 dark:text-warning">{step.warning}</p> : null}
                {!step.done && step.action !== null ? <StepAction action={step.action} primary={step === next} /> : null}
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function StepAction({ action, primary }: { action: NonNullable<ChecklistStep['action']>; primary: boolean }) {
  const variant = primary ? 'default' : 'outline';
  if ('href' in action) {
    return (
      <Button size="xs" variant={variant} className="mt-1 w-fit" nativeButton={false} render={<Link href={action.href} />}>
        {action.label} <ArrowRight data-icon="inline-end" />
      </Button>
    );
  }
  return (
    <Button size="xs" variant={variant} className="mt-1 w-fit" onClick={action.onClick}>
      {action.icon === 'play' ? <Play data-icon="inline-start" /> : action.icon === 'plus' ? <Plus data-icon="inline-start" /> : null}
      {action.label}
    </Button>
  );
}
