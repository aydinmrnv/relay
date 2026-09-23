import { cn } from '@/lib/utils';
import type { RunPhase } from '@/lib/workflow/schema';
import { formatMs, usd } from '@/lib/workflow/simulate';

export function PhaseList({ phases }: { phases: RunPhase[] }) {
  if (phases.length === 0) return null;
  const total = phases.reduce((sum, phase) => sum + phase.ms, 0);
  return (
    <ul className="flex flex-col gap-3">
      {phases.map((phase, index) => {
        const share = total === 0 ? 0 : Math.round((phase.ms / total) * 100);
        return (
          <li key={`${phase.phase}-${index}`} className="grid gap-1">
            <div className="flex items-center justify-between text-sm">
              <span className={cn('font-medium', phase.status === 'failed' ? 'text-red-600 dark:text-red-400' : '')}>
                {phase.label}
                {phase.agent !== undefined ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">{phase.agent}</span> : null}
              </span>
              <span className="tabular-nums text-xs text-muted-foreground">
                {formatMs(phase.ms)}
                {phase.costUsd !== undefined && phase.costUsd > 0 ? ` · ${usd(phase.costUsd)}` : ''}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={share} aria-valuemin={0} aria-valuemax={100}>
              <div className={cn('h-full rounded-full transition-all', phase.status === 'failed' ? 'bg-red-500' : 'bg-primary')} style={{ width: `${Math.max(2, share)}%` }} />
            </div>
          </li>
        );
      })}
      <li className="flex items-center justify-between border-t pt-2 text-xs text-muted-foreground">
        <span>Total</span>
        <span className="tabular-nums">
          {formatMs(total)} · {usd(phases.reduce((sum, phase) => sum + (phase.costUsd ?? 0), 0))}
        </span>
      </li>
    </ul>
  );
}
