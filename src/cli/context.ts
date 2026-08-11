import { ClaudeHarness } from '../agents/claude.ts';
import { CodexHarness } from '../agents/codex.ts';
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

  const harnesses: Record<AgentProvider, AgentHarness> = {
    claude: new ClaudeHarness(
      config.models.claude === undefined ? {} : { defaultModel: config.models.claude },
    ),
    codex: new CodexHarness(
      config.models.codex === undefined ? {} : { defaultModel: config.models.codex },
    ),
  };

  const issueProvider = new GitHubIssueProvider({
    cwd: repo.root,
    defaultRepo: repo.owner !== null && repo.name !== null ? { owner: repo.owner, name: repo.name } : null,
  });

  return { repo, config, harnesses, issueProvider };
}
