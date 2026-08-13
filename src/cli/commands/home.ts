import { access } from 'node:fs/promises';

import type { Landing } from '../../git/commit.ts';
import { discoverRepository } from '../../git/repository.ts';
import { configPath, loadConfig, type RelayConfig } from '../../storage/config.ts';
import { listRuns } from '../../storage/runs.ts';
import { isTerminal } from '../../workflow/phases.ts';
import type { RunState } from '../../workflow/state.ts';
import { formatDuration } from '../../util/text.ts';
import { isRelayError } from '../../util/errors.ts';
import { EXIT } from '../exit.ts';
import { configToJson, type HomeJson } from '../homeJson.ts';
import { emitJson } from '../json.ts';
import { runToJson } from '../runJson.ts';
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
  /** Verified against git, so the screen and the JSON agree on where work is. */
  landing: Landing;
}

export function chooseNextCommand(configured: boolean, runs: readonly RunHomeView[]): string {
  if (!configured) return 'relay start';
  const live = runs.find(({ state }) => !isTerminal(state.phase));
  if (live !== undefined) return `relay watch ${live.state.runId}`;
  if (runs[0]?.landing === 'unlanded') return `relay deliver ${runs[0].state.runId}`;
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

export interface HomeOptions {
  json?: boolean;
}

export async function homeCommand(options: HomeOptions = {}): Promise<number> {
  let repo;
  try {
    repo = await discoverRepository(process.cwd());
  } catch (error) {
    if (!isRelayError(error) || error.code !== 'NOT_A_REPOSITORY') throw error;
    // Outside a repository the screen is an invitation, not a report — and a
    // caller asking for JSON gets the same answer as any unmet precondition,
    // because that is exactly what this is.
    if (options.json === true) throw error;
    out('Relay coordinates your coding agents to plan, review, implement and deliver GitHub issues.');
    out('Run it inside the repository you want Relay to work on.');
    command('relay start');
    return EXIT.success;
  }

  const configured = await configExists(repo.root);
  const config = await loadConfig(repo.root);
  const states = (await listRuns(repo.root)).slice(0, 3);
  const runs: RunHomeView[] = await Promise.all(
    states.map(async (state) => ({ state, landing: await landingOf(repo.root, state) })),
  );
  const slug = repo.owner !== null && repo.name !== null ? `${repo.owner}/${repo.name}` : null;

  if (options.json === true) {
    const payload: HomeJson = {
      repository: {
        root: repo.root,
        owner: repo.owner,
        name: repo.name,
        slug,
        defaultBranch: repo.defaultBranch,
      },
      configured,
      config: configToJson(config),
      runs: runs.map(({ state, landing }) => runToJson(state, { landing })),
      next: chooseNextCommand(configured, runs),
    };
    emitJson('home', payload);
    return EXIT.success;
  }

  const repository = slug ?? repo.root;
  const runLines = runs.length === 0
    ? [dim('No runs yet')]
    : runs.flatMap(({ state, landing }) => [
        facts([
          state.runId,
          phaseTag(state),
          formatDuration(runDuration(state)),
          state.diff !== undefined && changeCount(state.diff.additions, state.diff.deletions),
          landing === 'unlanded' && warning('unlanded'),
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
  return EXIT.success;
}
