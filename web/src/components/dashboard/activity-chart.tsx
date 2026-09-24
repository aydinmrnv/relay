'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Bar, BarChart, CartesianGrid, Rectangle, XAxis, YAxis, type BarShapeProps } from 'recharts';
import { BarChart3, Play, Table2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { HelpTip } from '@/components/app/help-tip';
import { cn } from '@/lib/utils';
import { OUTCOMES, type DayBucket, type Outcome } from './derive';

/**
 * Outcomes are states, not identities, so they wear the status tokens rather
 * than the categorical chart colours. The stack order keeps green and red
 * apart (success, warning, destructive, neutral): checked with the dataviz
 * validator, green↔red is the pair that collapses under deuteranopia. The 2px
 * gaps, the legend, the tooltip and the table view carry identity for anyone
 * the colours fail.
 */
const CONFIG = {
  succeeded: { label: 'Succeeded', color: 'var(--success)' },
  refused: { label: 'Refused', color: 'var(--warning)' },
  failed: { label: 'Failed', color: 'var(--destructive)' },
  cancelled: { label: 'Cancelled', color: 'var(--muted-foreground)' },
} satisfies ChartConfig;

const GAP = 2;

/** One stacked segment: a surface gap below it, rounded only where the bar ends, and the day's total above the top one. */
function segment(key: Outcome) {
  function Segment(props: BarShapeProps) {
    const datum = props.payload as DayBucket;
    const present = OUTCOMES.filter((outcome) => datum[outcome] > 0);
    if (datum[key] === 0 || props.height <= 0) return <g />;
    const isTop = present.at(-1) === key;
    const isBottom = present[0] === key;
    const height = isBottom ? props.height : Math.max(0, props.height - GAP);
    return (
      <g>
        <Rectangle x={props.x} y={props.y} width={props.width} height={height} fill={props.fill} radius={isTop ? [4, 4, 0, 0] : 0} />
        {isTop ? (
          <text x={props.x + props.width / 2} y={props.y - 6} textAnchor="middle" className="fill-muted-foreground text-[10px] tabular-nums">
            {datum.total}
          </text>
        ) : null}
      </g>
    );
  }
  return Segment;
}

const SHAPES: Record<Outcome, (props: BarShapeProps) => React.ReactElement> = {
  succeeded: segment('succeeded'),
  refused: segment('refused'),
  failed: segment('failed'),
  cancelled: segment('cancelled'),
};

export function ActivityChart({ days, className }: { days: DayBucket[]; className?: string }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const total = days.reduce((sum, day) => sum + day.total, 0);
  const succeeded = days.reduce((sum, day) => sum + day.succeeded, 0);
  // Whole-number ticks on a clean step, so the axis never reads 0, 2, 4, 5.
  const max = Math.max(0, ...days.map((day) => day.total));
  const step = max <= 5 ? 1 : max <= 10 ? 2 : Math.ceil(max / 5 / 5) * 5;
  const top = Math.max(2, Math.ceil(max / step) * step);
  const ticks = Array.from({ length: top / step + 1 }, (_, index) => index * step);

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          Activity <HelpTip term="run" />
        </CardTitle>
        <CardDescription>
          {total === 0
            ? 'Finished test runs per day, by outcome, over the last 14 days.'
            : `${total} finished ${total === 1 ? 'run' : 'runs'} in 14 days · ${Math.round((succeeded / total) * 100)}% succeeded`}
        </CardDescription>
        {total > 0 ? (
          <CardAction>
            <ToggleGroup
              value={[view]}
              onValueChange={(next: string[]) => {
                if (next[0] === 'chart' || next[0] === 'table') setView(next[0]);
              }}
              variant="outline"
              size="sm"
              spacing={0}
              aria-label="Show as"
            >
              <ToggleGroupItem value="chart" aria-label="Show as chart">
                <BarChart3 />
              </ToggleGroupItem>
              <ToggleGroupItem value="table" aria-label="Show as table">
                <Table2 />
              </ToggleGroupItem>
            </ToggleGroup>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        {total === 0 ? (
          <Empty className="border py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BarChart3 />
              </EmptyMedia>
              <EmptyTitle>No finished runs in the last two weeks</EmptyTitle>
              <EmptyDescription>Play a workflow and its outcome lands here, one bar per day. Test runs are free and stay in this browser.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/runs" />}>
                <Play data-icon="inline-start" /> Test a workflow
              </Button>
            </EmptyContent>
          </Empty>
        ) : view === 'chart' ? (
          <ChartContainer config={CONFIG} className="aspect-auto h-64 w-full" initialDimension={{ width: 640, height: 256 }}>
            <BarChart data={days} margin={{ top: 18, right: 4, bottom: 0, left: -12 }} barCategoryGap="28%" accessibilityLayer>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={12} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={36} domain={[0, top]} ticks={ticks} />
              <ChartTooltip
                cursor={{ radius: 6 }}
                content={<ChartTooltipContent indicator="line" labelFormatter={(_value, payload) => (payload[0]?.payload as DayBucket | undefined)?.long ?? ''} />}
              />
              {/* Legend in stack order, bottom segment first, instead of recharts' alphabetical default. */}
              <ChartLegend content={<ChartLegendContent />} itemSorter={null} />
              {OUTCOMES.map((outcome) => (
                <Bar key={outcome} dataKey={outcome} stackId="runs" fill={`var(--color-${outcome})`} maxBarSize={24} shape={SHAPES[outcome]} isAnimationActive={false} />
              ))}
            </BarChart>
          </ChartContainer>
        ) : (
          <div className="max-h-64 overflow-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-3">Day</TableHead>
                  {OUTCOMES.map((outcome) => (
                    <TableHead key={outcome} className="text-right">
                      {CONFIG[outcome].label}
                    </TableHead>
                  ))}
                  <TableHead className="pr-3 text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...days].reverse().map((day) => (
                  <TableRow key={day.key} className={cn(day.total === 0 && 'text-muted-foreground')}>
                    <TableCell className="pl-3">{day.long}</TableCell>
                    {OUTCOMES.map((outcome) => (
                      <TableCell key={outcome} className="text-right tabular-nums">
                        {day[outcome] === 0 ? '—' : day[outcome]}
                      </TableCell>
                    ))}
                    <TableCell className="pr-3 text-right font-medium tabular-nums">{day.total}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
