'use client';

import { FadeIn } from '@/components/motion/fade-in';
import { HelpTip } from '@/components/app/help-tip';
import type { Term } from '@/lib/glossary';
import { cn } from '@/lib/utils';

interface Props {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Glossary term explained by the "?" next to the title. */
  term?: Term;
  actions?: React.ReactNode;
  className?: string;
}

/** Title, one line on what the page is for, and the page's primary actions. */
export function PageHeader({ title, description, term, actions, className }: Props) {
  return (
    <FadeIn className={cn('flex flex-wrap items-end justify-between gap-x-6 gap-y-3', className)}>
      <div className="min-w-0 max-w-2xl">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          {title}
          {term === undefined ? null : <HelpTip term={term} detailed className="mt-0.5" />}
        </h1>
        {description === undefined ? null : <p className="mt-1 text-sm text-pretty text-muted-foreground">{description}</p>}
      </div>
      {actions === undefined ? null : <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </FadeIn>
  );
}
