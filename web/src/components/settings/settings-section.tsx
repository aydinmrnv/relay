'use client';

import type { LucideIcon } from 'lucide-react';
import { HelpTip } from '@/components/app/help-tip';
import { Badge } from '@/components/ui/badge';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import type { Term } from '@/lib/glossary';
import { cn } from '@/lib/utils';

/** Room for the sticky app header (and the chip row on narrow screens) when jumping to an anchor. */
export const ANCHOR_OFFSET = 'scroll-mt-28 lg:scroll-mt-20';

/** One titled group of settings, with an anchor the sub-nav and other pages link to. */
export function SettingsSection({
  id,
  icon: Icon,
  title,
  description,
  term,
  children,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  description: React.ReactNode;
  term?: Term;
  children: React.ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn('grid min-w-0 grid-cols-1 gap-4', ANCHOR_OFFSET)}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted/50 text-muted-foreground">
          <Icon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="flex items-center gap-1.5 text-base font-semibold tracking-tight">
            {title}
            {term === undefined ? null : <HelpTip term={term} detailed />}
          </h2>
          <p className="mt-0.5 text-sm text-pretty text-muted-foreground">{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

/** A setting's name and one line on what it changes, above its control. */
export function SettingBlock({
  id,
  title,
  description,
  htmlFor,
  aside,
  children,
  className,
}: {
  id?: string;
  title: React.ReactNode;
  description: React.ReactNode;
  /** Id of the control, so the title is its label. */
  htmlFor?: string;
  /** Something small shown to the right of the title, such as a status. */
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const Title = htmlFor === undefined ? 'p' : 'label';
  return (
    <div id={id} className={cn('grid grid-cols-1 gap-3 p-4 md:p-5', id === undefined ? undefined : ANCHOR_OFFSET, className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="grid min-w-0 gap-0.5">
          <Title {...(htmlFor === undefined ? {} : { htmlFor })} className="text-sm font-medium">
            {title}
          </Title>
          <p className="text-sm text-pretty text-muted-foreground">{description}</p>
        </div>
        {aside}
      </div>
      {children}
    </div>
  );
}

export interface Choice<T extends string> {
  value: T;
  title: string;
  description: React.ReactNode;
  icon?: LucideIcon;
  badge?: { label: string; tone: 'ok' | 'muted' };
  disabled?: boolean;
  /** A small picture above the title, e.g. a theme swatch. */
  preview?: React.ReactNode;
}

/**
 * A radio group drawn as cards, one sentence each, so every option says what
 * it does before you pick it. Keyboard: arrow keys move between options.
 */
export function ChoiceCards<T extends string>({
  name,
  label,
  value,
  onValueChange,
  options,
  className,
}: {
  name: string;
  /** Accessible name of the group. */
  label: string;
  value: T;
  onValueChange: (value: T) => void;
  options: Array<Choice<T>>;
  className?: string;
}) {
  return (
    <RadioGroup aria-label={label} value={value} onValueChange={(next) => onValueChange(next as T)} className={cn('grid gap-2 sm:grid-cols-3', className)}>
      {options.map((option) => {
        const Icon = option.icon;
        const id = `${name}-${option.value}`;
        return (
          <label
            key={option.value}
            htmlFor={id}
            className={cn(
              'group/choice relative flex flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors has-data-checked:border-primary/60 has-data-checked:bg-primary/[0.04] has-focus-visible:ring-3 has-focus-visible:ring-ring/50 dark:has-data-checked:bg-primary/[0.08]',
              option.disabled === true ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-muted/40',
            )}
          >
            {option.preview}
            <span className={cn('flex items-center gap-2 text-sm font-medium', option.disabled === true ? 'text-muted-foreground' : undefined)}>
              <RadioGroupItem id={id} value={option.value} disabled={option.disabled} />
              {Icon === undefined ? null : <Icon className="size-3.5 text-muted-foreground group-has-data-checked/choice:text-primary" aria-hidden />}
              {option.title}
              {option.badge === undefined ? null : (
                <Badge
                  variant="outline"
                  className={cn('ml-auto h-5 text-[10px]', option.badge.tone === 'ok' ? 'border-success/30 bg-success/10 text-success' : 'text-muted-foreground')}
                >
                  {option.badge.label}
                </Badge>
              )}
            </span>
            <span className="text-xs text-pretty text-muted-foreground">{option.description}</span>
          </label>
        );
      })}
    </RadioGroup>
  );
}
