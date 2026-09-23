'use client';

import { useEffect, useId, useRef } from 'react';
import { motion } from 'motion/react';
import { useCalmMotion } from '@/components/motion/use-calm-motion';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { scrollToSection, useScrollSpy } from './use-scroll-spy';

export interface SectionLink {
  id: string;
  label: string;
  icon?: LucideIcon;
}

interface Props {
  items: readonly SectionLink[];
  /** The same ids as `items`, as a module-level array, so the scroll spy does not resubscribe on every render. */
  ids: readonly string[];
  title?: string;
  className?: string;
}

/** Where the spy considers a section "reached": below the sticky header and the chip row. */
const SPY_OFFSET = 112;

function useSectionLinks(ids: readonly string[]) {
  const active = useScrollSpy(ids, SPY_OFFSET);
  const reduce = useCalmMotion();
  const onClick = (event: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    // Plain clicks scroll in place; modified clicks (new tab, copy link) keep the browser's behaviour.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    if (scrollToSection(id, !reduce)) event.preventDefault();
  };
  return { active, reduce, onClick };
}

/** "On this page" for wide screens: a sticky list of anchors that highlights the section being read. */
export function SectionNav({ items, ids, title = 'On this page', className }: Props) {
  const { active, reduce, onClick } = useSectionLinks(ids);
  const indicator = useId();

  return (
    <nav aria-label={title} className={cn('sticky top-16 max-h-[calc(100svh-5rem)] overflow-y-auto', className)}>
      <p className="mb-2 px-2.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</p>
      <ul className="grid gap-0.5">
        {items.map((item) => {
          const current = item.id === active;
          const Icon = item.icon;
          return (
            <li key={item.id} className="relative">
              {current ? (
                <motion.span
                  layoutId={`${indicator}-active`}
                  transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 42 }}
                  className="absolute inset-0 rounded-md bg-muted"
                  aria-hidden
                />
              ) : null}
              <a
                href={`#${item.id}`}
                onClick={(event) => onClick(event, item.id)}
                aria-current={current ? 'location' : undefined}
                className={cn(
                  'relative flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
                  current ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {Icon === undefined ? null : <Icon className={cn('size-3.5 shrink-0 transition-colors', current ? 'text-primary' : '')} aria-hidden />}
                <span className="truncate">{item.label}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * The same anchors for narrow screens: a row of chips that sticks under the
 * app header and scrolls sideways. The caller hides it (`lg:hidden`,
 * `xl:hidden`) at the width where its SectionNav appears.
 */
export function SectionChips({ items, ids, title = 'On this page', className }: Props) {
  const { active, reduce, onClick } = useSectionLinks(ids);
  const list = useRef<HTMLUListElement>(null);

  // Keep the current chip in sight. Scrolls only the chip row, never the page,
  // so it cannot interrupt a smooth scroll the reader started.
  useEffect(() => {
    const row = list.current;
    const chip = row?.querySelector<HTMLElement>('[aria-current="location"]');
    if (row == null || chip == null) return;
    const left = chip.offsetLeft;
    if (left < row.scrollLeft || left + chip.offsetWidth > row.scrollLeft + row.clientWidth) {
      row.scrollTo({ left: Math.max(0, left - 16), behavior: reduce ? 'auto' : 'smooth' });
    }
  }, [active, reduce]);

  return (
    <nav
      aria-label={title}
      className={cn(
        'sticky top-12 z-20 -mx-4 border-b bg-background/85 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/70 md:-mx-6 md:px-6',
        className,
      )}
    >
      <ul ref={list} className="relative flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((item) => {
          const current = item.id === active;
          return (
            <li key={item.id} className="shrink-0">
              <a
                href={`#${item.id}`}
                onClick={(event) => onClick(event, item.id)}
                aria-current={current ? 'location' : undefined}
                className={cn(
                  'inline-flex h-7 items-center rounded-full border px-3 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
                  current ? 'border-primary/40 bg-primary/10 font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {item.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
