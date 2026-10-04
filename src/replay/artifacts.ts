import { readdir } from 'node:fs/promises';

import { readJsonFile } from '../storage/atomic.ts';
import type { RunStore } from '../storage/runs.ts';
import type { RunState } from '../workflow/state.ts';

/**
 * What a finished run left on disk beside its state, read back for the things
 * that are made from it: a recording, and the receipts in a pull request.
 */

/** Every patch the run captured, in the order it captured them: the implementation, then each revision. */
export async function readRunPatches(store: RunStore): Promise<Array<{ label: string; patch: string }>> {
  let names: string[];
  try {
    names = await readdir(store.path('patches'));
  } catch {
    return [];
  }
  const order = (label: string): number => (label === 'implementation' ? 0 : Number.parseInt(/^revision-round-(\d+)$/.exec(label)?.[1] ?? '9999', 10));
  const patches: Array<{ label: string; patch: string }> = [];
  for (const name of names.filter((entry) => entry.endsWith('.patch'))) {
    const patch = await store.readArtifact(`patches/${name}`);
    if (patch !== undefined) patches.push({ label: name.slice(0, -'.patch'.length), patch });
  }
  return patches.sort((a, b) => order(a.label) - order(b.label) || a.label.localeCompare(b.label));
}

/** Whether each plan revision rewrote the plan, from the discussion file the round left. */
export async function readPlanRevisions(store: RunStore, state: RunState): Promise<Record<number, boolean>> {
  const revised: Record<number, boolean> = {};
  for (const review of state.reviews) {
    if (review.kind !== 'plan') continue;
    const discussion = await readJsonFile<{ planRevised?: unknown }>(store.path('discussion', `plan-round-${review.round}.json`)).catch(() => undefined);
    if (typeof discussion?.planRevised === 'boolean') revised[review.round] = discussion.planRevised;
  }
  return revised;
}
