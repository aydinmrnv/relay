'use client';

import { Trash2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cancelRun } from '@/lib/run-launcher';
import { useStudio } from '@/lib/store';
import type { Run } from '@/lib/workflow/schema';

/**
 * Confirms before a run's record is removed, stopping it first if it is still
 * playing. `run` stays set while the dialog animates closed, so the title does
 * not blank out mid-fade.
 */
export function DeleteRunDialog({
  run,
  open,
  onOpenChange,
  onDeleted,
}: {
  run: Run | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const deleteRun = useStudio((state) => state.deleteRun);
  const stopsReal = run !== undefined && run.source === 'machine' && run.status === 'running';

  const confirm = () => {
    if (run === undefined) return;
    cancelRun(run.id);
    // Tell the caller first: a page showing this run can step away before it vanishes.
    onDeleted?.();
    deleteRun(run.id);
    onOpenChange(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <Trash2 />
          </AlertDialogMedia>
          <AlertDialogTitle>Delete run {run?.shortId}?</AlertDialogTitle>
          <AlertDialogDescription>
            {stopsReal
              ? `This run is still going on ${run.machine?.host ?? 'your runner'}, for real. Deleting it stops it there first, the way Stop does: work so far stays on its branch. Then its timeline, phases and cost are removed.`
              : 'Its timeline, phases and cost are removed. The workflow stays as it is, and you can play it again any time.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={confirm}>
            {stopsReal ? 'Stop and delete' : 'Delete run'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Confirms before the whole history goes. Playing runs are stopped first so nothing re-appears. */
export function ClearRunsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const runs = useStudio((state) => state.runs);
  const clearRuns = useStudio((state) => state.clearRuns);
  const real = runs.filter((run) => run.source === 'machine' && run.status === 'running').length;

  const confirm = () => {
    for (const run of runs) cancelRun(run.id);
    clearRuns();
    onOpenChange(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <Trash2 />
          </AlertDialogMedia>
          <AlertDialogTitle>
            Clear all {runs.length} {runs.length === 1 ? 'run' : 'runs'}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Every run recorded here is removed, including the dashboard&rsquo;s history and spend. Workflows, connections and settings are not touched.
            {real > 0 ? ` ${real === 1 ? 'One run is' : `${real} runs are`} still going for real on a runner, and ${real === 1 ? 'is' : 'are'} stopped first: work so far stays on ${real === 1 ? 'its branch' : 'their branches'}.` : ''}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep history</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={confirm}>
            {real > 0 ? 'Stop and clear' : 'Clear history'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
