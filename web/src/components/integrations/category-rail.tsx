'use client';

import { motion } from 'motion/react';
import { Blocks, LayoutGrid, Plug, Star, type LucideIcon } from 'lucide-react';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { connectorsByCategory, type Connector, type ConnectorCategory } from '@/lib/connectors';
import { cn } from '@/lib/utils';

export type Filter = 'all' | 'popular' | 'connected' | ConnectorCategory;

interface FilterDef {
  key: Filter;
  label: string;
  icon?: LucideIcon;
}

export const SHORTCUT_FILTERS: FilterDef[] = [
  { key: 'all', label: 'All apps', icon: LayoutGrid },
  { key: 'popular', label: 'Popular', icon: Star },
  { key: 'connected', label: 'Connected', icon: Plug },
];

/** Built-in nodes first (they are what every workflow is made of), then vendor categories in catalog order. */
export const CATEGORY_FILTERS: FilterDef[] = [
  { key: 'core', label: 'Built in', icon: Blocks },
  ...connectorsByCategory()
    .filter((group) => group.category !== 'core')
    .map((group) => ({ key: group.category, label: group.label })),
];

const ALL_FILTERS = [...SHORTCUT_FILTERS, ...CATEGORY_FILTERS];

export function filterLabel(filter: Filter): string {
  return ALL_FILTERS.find((entry) => entry.key === filter)?.label ?? 'All apps';
}

export function inFilter(connector: Connector, filter: Filter, isConnected: (id: string) => boolean): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'popular':
      return connector.popular === true;
    case 'connected':
      return isConnected(connector.id);
    default:
      return connector.category === filter;
  }
}

interface Props {
  value: Filter;
  onChange: (filter: Filter) => void;
  /** Matches per filter for the current search, so empty categories can be dimmed. */
  counts: Record<string, number>;
}

/** The left-hand list on wide screens. Counts follow the search box. */
export function CategoryRail({ value, onChange, counts }: Props) {
  return (
    <nav aria-label="Filter apps" className="flex flex-col gap-4 text-sm">
      <RailGroup items={SHORTCUT_FILTERS} value={value} onChange={onChange} counts={counts} />
      <div className="flex flex-col gap-1">
        <p className="px-2.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Categories</p>
        <RailGroup items={CATEGORY_FILTERS} value={value} onChange={onChange} counts={counts} />
      </div>
    </nav>
  );
}

function RailGroup({ items, value, onChange, counts }: { items: FilterDef[]; value: Filter; onChange: (filter: Filter) => void; counts: Record<string, number> }) {
  return (
    <ul className="flex flex-col gap-px">
      {items.map((item) => {
        const active = item.key === value;
        const count = counts[item.key] ?? 0;
        const Icon = item.icon;
        return (
          <li key={item.key}>
            <button
              type="button"
              aria-current={active ? 'true' : undefined}
              onClick={() => onChange(item.key)}
              className={cn(
                'relative flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
                active ? 'font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                count === 0 && !active ? 'opacity-50' : '',
              )}
            >
              {active ? <motion.span layoutId="integrations-rail-active" className="absolute inset-0 rounded-md bg-muted" transition={{ type: 'spring', bounce: 0.15, duration: 0.35 }} /> : null}
              {Icon === undefined ? null : <Icon className="relative size-3.5 shrink-0" aria-hidden />}
              <span className="relative min-w-0 flex-1 truncate">{item.label}</span>
              <span className="relative text-xs text-muted-foreground tabular-nums">{count}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The same choice as a dropdown, for narrow screens where the rail is hidden. */
export function CategorySelect({ value, onChange, counts, className }: Props & { className?: string }) {
  const items = ALL_FILTERS.map((item) => ({ value: item.key, label: `${item.label} (${counts[item.key] ?? 0})` }));
  return (
    <Select value={value} onValueChange={(next) => onChange((next ?? 'all') as Filter)} items={items}>
      <SelectTrigger className={cn('h-9', className)} aria-label="Category">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {SHORTCUT_FILTERS.map((item) => (
            <SelectItem key={item.key} value={item.key}>
              {item.label} <span className="text-muted-foreground tabular-nums">{counts[item.key] ?? 0}</span>
            </SelectItem>
          ))}
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>Categories</SelectLabel>
          {CATEGORY_FILTERS.map((item) => (
            <SelectItem key={item.key} value={item.key}>
              {item.label} <span className="text-muted-foreground tabular-nums">{counts[item.key] ?? 0}</span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
