import { access } from 'node:fs/promises';

import type { Landing } from '../../git/commit.ts';
import { discoverRepository } from '../../git/repository.ts';
import { configPath, loadConfig, type RelayConfig } from '../../storage/config.ts';
import { describeReview, reviewLevelName } from '../../reviews/level.ts';
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
import { applyOverrides, type RunOptions } from './run.ts';
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

/**
 * The panel's rows, for the config as written and as this session has it.
 *
 * A `/review light` at the prompt changes what the next run does but not what
 * the file says, and a screen that kept showing the file would be describing a
 * run that is not going to happen. So the effective value is the one shown, and
 * the ones the session moved say so.
 */
function configLines(base: RelayConfig, effective: RelayConfig, configured: boolean): string[] {
  const row = (label: string, value: string, base: string): readonly string[] => [
    label,
    value === base ? value : `${value}  ${dim('· this session')}`,
  ];

  return gridLines(
    [{ header: '' }, { header: '' }],
    [
      ['State', configured ? 'configured' : 'not configured'],
      row('Planner', effective.agents.planner, base.agents.planner),
      row('Plan reviewer', effective.agents.planReviewer, base.agents.planReviewer),
      row('Implementer', effective.agents.implementer, base.agents.implementer),
      row('Code reviewer', effective.agents.codeReviewer, base.agents.codeReviewer),
      // The level and what it means, on one line: the name alone is a word
      // nobody can act on, and the numbers alone are four facts to hold.
      row(
        'Review',
        `${reviewLevelName(effective.workflow)}  ${dim(describeReview(effective.workflow))}`,
        `${reviewLevelName(base.workflow)}  ${dim(describeReview(base.workflow))}`,
      ),
      row('Delivery', effective.workflow.deliver, base.workflow.deliver),
      ['Tests', base.tests.command?.join(' ') ?? 'auto-detected per run'],
    ],
  );
}

export interface HomeOptions {
  json?: boolean;
  /**
   * Flags a `/command` set for this session. The screen shows the config as it
   * would apply to the next run, and marks whatever the session moved.
   */
  session?: RunOptions;
}

export interface HomeScreen {
  /**
   * Whether a run can start from here: a configured repository. Everything
   * else — no repository, no config — has already been told what to do instead,
   * and asking it for an issue number on top of that would be noise.
   */
  ready: boolean;
}

/**
 * `relay --json`: the screen's facts as one document, and nothing after it. A
 * session asks for the next issue, and whatever is parsing this is not there to
 * answer.
 */
export async function homeCommand(options: HomeOptions = {}): Promise<number> {
  await showHome(options);
  return EXIT.success;
}

/** Draws the home screen, and reports whether the next issue can start here. */
export async function showHome(options: HomeOptions = {}): Promise<HomeScreen> {
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
    return { ready: false };
  }

  const configured = await configExists(repo.root);
  const config = await loadConfig(repo.root);
  // What a run would do with the session's flags, and what it would do without
  // them — compared against each other rather than against the file, so a
  // delivery ceiling the config implies is not mistaken for a session override.
  // Silently, because `relay run` is where these same flags are announced as a
  // change being made; here they are only being shown.
  const base = options.session === undefined ? config : applyOverrides(config, {}, { announce: false });
  const effective =
    options.session === undefined ? config : applyOverrides(config, options.session, { announce: false });
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
      config: configToJson(effective),
      runs: runs.map(({ state, landing }) => runToJson(state, { landing })),
      next: chooseNextCommand(configured, runs),
    };
    emitJson('home', payload);
    return { ready: configured };
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
      ...configLines(base, effective, configured),
      '',
      dim('Recent runs'),
      ...runLines,
    ],
    footer: [`Next  ${chooseNextCommand(configured, runs)}`],
  });
  return { ready: configured };
}

