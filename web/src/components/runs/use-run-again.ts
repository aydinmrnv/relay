'use client';

import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { launchRun } from '@/lib/run-launcher';
import { useStudio } from '@/lib/store';
import { validateWorkflow } from '@/lib/workflow/validate';

interface Options {
  /** Replay this trigger payload instead of a fresh sample. */
  payload?: Record<string, unknown>;
  /** Open the new run's page as soon as it exists, instead of offering a link. */
  navigate?: boolean;
}

/**
 * Starts a test run of a saved workflow from anywhere outside the builder.
 * It applies the builder's rule — a workflow with validation errors does not
 * run — and says so with a way to fix it, rather than failing quietly.
 */
export function useRunAgain() {
  const router = useRouter();

  return (workflowId: string, options: Options = {}) => {
    const workflow = useStudio.getState().workflows[workflowId];
    if (workflow === undefined) {
      toast.error('That workflow no longer exists', { description: 'The run keeps its record, but there is nothing left to play.' });
      return;
    }
    const validation = validateWorkflow(workflow);
    if (!validation.ok) {
      const first = validation.issues.find((issue) => issue.level === 'error');
      toast.error(`${workflow.name} has ${validation.errors} ${validation.errors === 1 ? 'problem' : 'problems'} to fix first`, {
        description: first?.message,
        action: { label: 'Open workflow', onClick: () => router.push(`/workflows/${workflow.id}`) },
      });
      return;
    }

    let announced = false;
    launchRun(workflow, {
      ...(options.payload === undefined ? {} : { payload: options.payload }),
      onEvent: (_event, live) => {
        if (announced) return;
        announced = true;
        if (options.navigate === true) {
          router.push(`/runs/${live.id}`);
          return;
        }
        toast.success('Test run started', {
          description: `${workflow.name} is playing in this browser. Nothing is called or billed.`,
          action: { label: 'Watch', onClick: () => router.push(`/runs/${live.id}`) },
        });
      },
    }).catch((error: unknown) => {
      toast.error('The test run stopped unexpectedly', { description: error instanceof Error ? error.message : String(error) });
    });
  };
}
