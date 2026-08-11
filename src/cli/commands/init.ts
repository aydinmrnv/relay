import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ClaudeHarness } from '../../agents/claude.ts';
import { CodexHarness } from '../../agents/codex.ts';
import { discoverRepository } from '../../git/repository.ts';
import { DEFAULT_CONFIG, configPath, loadConfig, writeConfig } from '../../storage/config.ts';
import { discoverTestCommand } from '../../testing/discovery.ts';
import { dim, heading, out, success, warning } from '../output.ts';

const GITIGNORE_ENTRY = '.relay/runs/';

/**
 * Writes `.relay/config.json` and reports what Relay detected. Never overwrites
 * an existing config without `--force`: it may contain deliberate role choices.
 */
export async function initCommand(options: { force?: boolean }): Promise<number> {
  const repo = await discoverRepository(process.cwd());
  const path = configPath(repo.root);

  const existing = await loadConfig(repo.root);
  const alreadyConfigured = (await readFileOrUndefined(path)) !== undefined;

  if (alreadyConfigured && options.force !== true) {
    out(warning(`${path} already exists.`));
    out(dim('Re-run with --force to overwrite it.'));
    out();
    printConfig(existing);
    return 0;
  }

  await writeConfig(repo.root, alreadyConfigured ? existing : DEFAULT_CONFIG);
  await ensureGitignore(repo.root);

  heading('Relay initialized');
  out();
  out(`  Config      ${path}`);
  out(`  Repository  ${repo.owner !== null && repo.name !== null ? `${repo.owner}/${repo.name}` : repo.root}`);
  out(`  Base branch ${repo.defaultBranch}`);

  const discovery = await discoverTestCommand(repo.root, null);
  out(`  Tests       ${discovery.found ? discovery.command.command.join(' ') : dim(`none detected (${discovery.reason})`)}`);

  const claude = await new ClaudeHarness().checkAvailability();
  const codex = await new CodexHarness().checkAvailability();
  out(`  Claude Code ${claude.available ? claude.detail : warning(claude.detail)}`);
  out(`  Codex       ${codex.available ? codex.detail : warning(codex.detail)}`);

  out();
  if (!claude.available || !codex.available) {
    out(warning('Some agents are unavailable. Run `relay doctor` for details.'));
  } else {
    out(success('Ready. Run `relay run <issue-number>` to start.'));
  }
  return 0;
}

function printConfig(config: ReturnType<typeof structuredClone<typeof DEFAULT_CONFIG>>): void {
  out(`  planner        ${config.agents.planner}`);
  out(`  plan reviewer  ${config.agents.planReviewer}`);
  out(`  implementer    ${config.agents.implementer}`);
  out(`  code reviewer  ${config.agents.codeReviewer}`);
  out(`  plan rounds    ${config.workflow.maxPlanReviewRounds}`);
  out(`  code rounds    ${config.workflow.maxCodeReviewRounds}`);
}

/**
 * Run state is machine-local and can be large, so it is kept out of git.
 * The config itself is intentionally committable.
 */
async function ensureGitignore(repoRoot: string): Promise<void> {
  const path = join(repoRoot, '.gitignore');
  const current = (await readFileOrUndefined(path)) ?? '';
  if (current.split('\n').some((line) => line.trim() === GITIGNORE_ENTRY)) return;

  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  await writeFile(path, `${current}${separator}\n# Relay run state (machine-local)\n${GITIGNORE_ENTRY}\n`, 'utf8');
  out(dim(`  Added ${GITIGNORE_ENTRY} to .gitignore`));
}

async function readFileOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}
