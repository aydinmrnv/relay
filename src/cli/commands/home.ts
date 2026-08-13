import { access } from 'node:fs/promises';

import { discoverRepository } from '../../git/repository.ts';
import { configPath, loadConfig, type RelayConfig } from '../../storage/config.ts';
import { listRuns } from '../../storage/runs.ts';
import { isTerminal } from '../../workflow/phases.ts';
import type { RunState } from '../../workflow/state.ts';
import { formatDuration } from '../../util/text.ts';
import { isRelayError } from '../../util/errors.ts';
import {
  banner,
  box,
  changeCount,
  command,
  dim,
  facts,
  gridLines,
  out,
  warning,
} from '../output.ts';
import { landingOf, phaseTag, runDuration } from './inspect.ts';

export interface RunHomeView {
  state: RunState;
  unlanded: boolean;
}

export function chooseNextCommand(configured: boolean, runs: readonly RunHomeView[]): string {
  if (!configured) return 'relay start';
  const live = runs.find(({ state }) => !isTerminal(state.phase));
  if (live !== undefined) return `relay watch ${live.state.runId}`;
  if (runs[0]?.unlanded === true) return `relay deliver ${runs[0].state.runId}`;
  return 'relay run <issue>';
}

async function configExists(root: string): Promise<boolean> {
  try {
    await access(configPath(root));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function configLines(config: RelayConfig, configured: boolean): string[] {
  return gridLines(
    [{ header: '' }, { header: '' }],
    [
      ['State', configured ? 'configured' : 'not configured'],
      ['Planner', config.agents.planner],
      ['Plan reviewer', config.agents.planReviewer],
      ['Implementer', config.agents.implementer],
      ['Code reviewer', config.agents.codeReviewer],
      ['Delivery', config.workflow.deliver],
      ['Tests', config.tests.command?.join(' ') ?? 'auto-detected per run'],
    ],
  );
}

export async function homeCommand(): Promise<number> {
  let repo;
  try {
    repo = await discoverRepository(process.cwd());
  } catch (error) {
    if (!isRelayError(error) || error.code !== 'NOT_A_REPOSITORY') throw error;
    out('Relay coordinates your coding agents to plan, review, implement and deliver GitHub issues.');
    out('Run it inside the repository you want Relay to work on.');
    command('relay start');
    return 0;
  }

  const configured = await configExists(repo.root);
  const config = await loadConfig(repo.root);
  const states = (await listRuns(repo.root)).slice(0, 3);
  const runs: RunHomeView[] = await Promise.all(
    states.map(async (state) => ({ state, unlanded: (await landingOf(repo.root, state)) === 'unlanded' })),
  );
  const repository = repo.owner !== null && repo.name !== null ? `${repo.owner}/${repo.name}` : repo.root;
  const runLines = runs.length === 0
    ? [dim('No runs yet')]
    : runs.flatMap(({ state, unlanded }) => [
        facts([
          state.runId,
          phaseTag(state),
          formatDuration(runDuration(state)),
          state.diff !== undefined && changeCount(state.diff.additions, state.diff.deletions),
          unlanded && warning('unlanded'),
        ]),
      ]);

  banner(repository);
  box({
    title: repository,
    badge: configured ? 'configured' : 'not configured',
    body: [
      ...configLines(config, configured),
      '',
      dim('Recent runs'),
      ...runLines,
    ],
    footer: [`Next  ${chooseNextCommand(configured, runs)}`],
  });
  return 0;
}
