/**
 * The companion protocol, as the studio sees it: what `relay connect` answers
 * on 127.0.0.1. Mirrors `src/studio/protocol.ts` in the engine; the agent
 * shapes are the ones in `@/lib/agents/types`, which both sides share.
 */

export const DEFAULT_COMPANION_PORT = 4477;

export type CompanionCapability = 'agents' | 'runs' | 'install';

export interface CompanionRepository {
  root: string;
  owner: string | null;
  name: string | null;
  defaultBranch: string;
}

export interface HelloResponse {
  product: 'relay';
  protocol: number;
  authorized: boolean;
  version?: string;
  machine?: string;
  platform?: string;
  repository?: CompanionRepository | null;
  capabilities?: CompanionCapability[];
  startedAt?: string;
}

export type RunTask = { kind: 'issue'; ref: string } | { kind: 'prompt'; text: string };

export interface CompanionRunView {
  id: string;
  workflow: { id: string; name: string };
  task: RunTask;
  status: 'running' | 'exited';
  runId: string | null;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export type RunStreamRecord =
  | { seq: number; type: 'engine'; data: Record<string, unknown> }
  | { seq: number; type: 'exit'; code: number | null; error: string | null }
  | { seq: number; type: 'ping' };

export interface InstallResponse {
  root: string;
  files: Array<{ path: string; status: 'created' | 'updated' | 'unchanged' }>;
}

/** `owner/name` when the repository has a GitHub remote, else the folder name. */
export function repositoryLabel(repository: CompanionRepository | null | undefined): string | null {
  if (repository === null || repository === undefined) return null;
  if (repository.owner !== null && repository.name !== null) return `${repository.owner}/${repository.name}`;
  return repository.root.split(/[\\/]/).filter(Boolean).pop() ?? repository.root;
}
