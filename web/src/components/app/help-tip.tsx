'use client';

import Link from 'next/link';
import { CircleHelp } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useBrand } from '@/hooks/use-brand';
import { explain, type Term } from '@/lib/glossary';
import { cn } from '@/lib/utils';

interface Props {
  /** A glossary term. Its title and explanation are used unless overridden. */
  term?: Term;
  title?: string;
  children?: React.ReactNode;
  /** Show the long explanation instead of the one-liner. */
  detailed?: boolean;
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
  /** Label for screen readers when there is no visible title. */
  label?: string;
}

/**
 * The small "?" next to anything that deserves an explanation. Opens on hover
 * for a quick read and stays open on click, and links to the full guide entry.
 */
export function HelpTip({ term, title, children, detailed = false, side = 'bottom', className, label }: Props) {
  const brand = useBrand();
  const entry = term === undefined ? undefined : explain(term, brand.name);
  const heading = title ?? entry?.title;
  const body = children ?? (detailed ? entry?.long : entry?.short);

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={250}
        aria-label={label ?? `What is ${heading ?? 'this'}?`}
        className={cn(
          'inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
          className,
        )}
      >
        <CircleHelp className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent side={side} className="w-80 gap-1.5 p-3.5">
        {heading === undefined ? null : <p className="text-sm font-medium">{heading}</p>}
        <div className="text-[13px] leading-relaxed text-muted-foreground">{body}</div>
        {term === undefined ? null : (
          <Link href={`/guide#${term}`} className="mt-1 text-xs font-medium text-signal hover:underline">
            Read more in the guide →
          </Link>
        )}
      </PopoverContent>
    </Popover>
  );
}
