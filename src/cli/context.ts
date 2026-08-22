import { createHarnesses } from '../agents/index.ts';
import { configHarnessRegistrations } from '../agents/configHarness.ts';
import type { AgentHarness } from '../agents/types.ts';
import type { IssueProvider } from '../github/types.ts';
import { defaultIssueProvider } from '../issues/registry.ts';
import { discoverRepository, type RepositoryInfo } from '../git/repository.ts';
import { configHarnesses, loadConfig, type AgentProvider, type RelayConfig } from '../storage/config.ts';

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
  // Plus one per harness the repository defined itself, addressable by roles
  // exactly like a shipped CLI.
  for (const registration of configHarnessRegistrations(configHarnesses(config))) {
    harnesses[registration.name] = registration.create({});
  }

  // Built through the provider registry, so a second tracker is a registry row
  // rather than an edit here.
  const issueProvider = defaultIssueProvider({
    cwd: repo.root,
    defaultRepo: repo.owner !== null && repo.name !== null ? { owner: repo.owner, name: repo.name } : null,
  });

  return { repo, config, harnesses, issueProvider };
}
