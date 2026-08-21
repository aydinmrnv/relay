import { AGENT_PROVIDERS } from '../../agents/index.ts';
import { listLocalBranches } from '../../git/repository.ts';
import { DELIVERY_POLICIES, MERGE_METHODS, REVIEW_LEVELS } from '../../storage/config.ts';
import { listRuns } from '../../storage/runs.ts';

export const agentNames = (): string[] => [...AGENT_PROVIDERS];
export const deliveryPolicies = (): string[] => [...DELIVERY_POLICIES];
export const mergeMethods = (): string[] => [...MERGE_METHODS];
export const reviewLevels = (): string[] => [...REVIEW_LEVELS];

export async function runRefs(root: string): Promise<string[]> {
  const runs = await listRuns(root);
  return ['latest', ...runs.flatMap((run) => [run.runId, run.shortId])];
}

export async function localBranches(
  root: string,
  options: { signal: AbortSignal; timeoutMs: number },
): Promise<string[]> {
  return listLocalBranches(root, options);
}
