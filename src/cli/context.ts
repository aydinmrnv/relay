import { createHarnesses } from '../agents/index.ts';
import type { AgentHarness } from '../agents/types.ts';
import { GitHubIssueProvider } from '../github/provider.ts';
import type { IssueProvider } from '../github/types.ts';
import { discoverRepository, type RepositoryInfo } from '../git/repository.ts';
import { loadConfig, type AgentProvider, type RelayConfig } from '../storage/config.ts';

export interface CliContext {
  repo: RepositoryInfo;
  config: RelayConfig;
  harnesses: Record<AgentProvider, AgentHarness>;
  issueProvider: IssueProvider;
}

/** Builds everything a command needs from the current working directory. */
export async function createCliContext(cwd: string = process.cwd()): Promise<CliContext> {
  const repo = await discoverRepository(cwd);
  const config = await loadConfig(repo.root);

  // One harness per registered provider: nothing here names a CLI.
  const harnesses = createHarnesses(config.models);

  const issueProvider = new GitHubIssueProvider({
    cwd: repo.root,
    defaultRepo: repo.owner !== null && repo.name !== null ? { owner: repo.owner, name: repo.name } : null,
  });

  return { repo, config, harnesses, issueProvider };
}
