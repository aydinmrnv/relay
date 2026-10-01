'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { inspectImport } from '@/lib/import-plan';
import { useStudio, type ClashChoice, type ImportPlan } from '@/lib/store';

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Importing a file, the same way from Settings and from the workflows page:
 * read it, check it, and — when it would touch workflows that are already
 * here — say exactly what it holds and ask before changing anything. An
 * import only ever adds runs and workflows; nothing already here is removed.
 */
export function useImportFlow(onImported?: () => void) {
  const applyImport = useStudio((state) => state.applyImport);
  const [asking, setAsking] = useState<{ plan: ImportPlan; file: string } | null>(null);

  const finish = (plan: ImportPlan, clashes: ClashChoice, file: string) => {
    const message = applyImport(plan, clashes);
    setAsking(null);
    toast.success(message, { description: plan.rejected > 0 ? `From ${file}. ${plural(plan.rejected, 'item')} in it could not be read and ${plan.rejected === 1 ? 'was' : 'were'} left out.` : `From ${file}.` });
    onImported?.();
  };

  const importFile = async (file: File | undefined) => {
    if (file === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      toast.error(`${file.name} is not valid JSON.`, { description: 'Choose a file exported from this studio or from Export in the builder.' });
      return;
    }
    const result = await inspectImport(parsed);
    if (!result.ok) {
      toast.error(result.message, { description: `Nothing was changed. ${file.name} was not imported.` });
      return;
    }
    // A single workflow that is already here comes in as a copy, as it always has. A whole export asks.
    if (result.plan.clashes.length === 0) finish(result.plan, 'skip', file.name);
    else if (result.plan.kind === 'workflow') finish(result.plan, 'copy', file.name);
    else setAsking({ plan: result.plan, file: file.name });
  };

  const plan = asking?.plan;
  const dialog = (
    <AlertDialog open={asking !== null} onOpenChange={(open) => (open ? undefined : setAsking(null))}>
      <AlertDialogContent className="data-[size=default]:sm:max-w-md">
        {plan === undefined || asking === null ? null : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {plural(plan.clashes.length, 'workflow')} in this file {plan.clashes.length === 1 ? 'is' : 'are'} already here
              </AlertDialogTitle>
              <AlertDialogDescription render={<div />} className="grid gap-2 text-left">
                <p>
                  <span className="font-mono text-xs">{asking.file}</span> holds {plural(plan.workflows.length, 'workflow')}
                  {plan.newRuns > 0 ? ` and ${plural(plan.newRuns, 'run')} you do not have` : ''}.
                </p>
                <ul className="grid gap-1 pl-4 [&>li]:list-disc">
                  <li>{plural(plan.workflows.length - plan.clashes.length, 'workflow')} would be added.</li>
                  <li>
                    {plural(plan.clashes.length, 'workflow')} {plan.clashes.length === 1 ? 'has' : 'have'} the same id as one of yours. Replacing {plan.clashes.length === 1 ? 'it' : 'them'} overwrites your current
                    version{plan.clashes.length === 1 ? '' : 's'}.
                  </li>
                  <li>Your runs and your other workflows stay as they are.</li>
                </ul>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="flex-wrap">
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <Button variant="outline" onClick={() => finish(plan, 'copy', asking.file)}>
                Keep both
              </Button>
              <Button variant="destructive" onClick={() => finish(plan, 'replace', asking.file)}>
                Replace mine
              </Button>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );

  return { importFile, dialog };
}
