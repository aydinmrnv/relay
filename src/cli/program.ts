import { Command, Help } from 'commander';

import { AGENT_PROVIDERS, AGENT_REGISTRY } from '../agents/index.ts';
import { DELIVERY_POLICIES } from '../storage/config.ts';
import { deliverCommand } from './commands/deliver.ts';
import { doctorCommand } from './commands/doctor.ts';
import { initCommand } from './commands/init.ts';
import { startCommand } from './commands/start.ts';
import { updateCommand } from './commands/update.ts';
import { resumeCommand, type RunOptions } from './commands/run.ts';
import { homeSession, runSession } from './session.ts';
import {
  diffCommand,
  logsCommand,
  planCommand,
  statusCommand,
  stopCommand,
  watchCommand,
} from './commands/inspect.ts';
import { reportError, theme } from './output.ts';

/** Help text names whichever CLIs are registered, not whichever shipped first. */
const AGENT_LABELS = AGENT_REGISTRY.map((entry) => entry.label).join(', ');

/**
 * Wraps a command so every failure exits with a code and an actionable message
 * instead of an unhandled rejection stack.
 */
function wrap<Args extends unknown[]>(
  handler: (...args: Args) => Promise<number>,
): (...args: Args) => Promise<void> {
  return async (...args: Args): Promise<void> => {
    try {
      process.exitCode = await handler(...args);
    } catch (error) {
      reportError(error);
      process.exitCode = 1;
    }
  };
}

export function defaultHelp(command: Command, width?: number): string {
  const helper = new Help();
  if (width !== undefined) helper.helpWidth = width;
  return helper.formatHelp(command, helper);
}

const HELP_GROUPS = [
  ['Setup', ['start', 'init', 'doctor']],
  ['Run', ['run', 'resume', 'stop']],
  ['Inspect', ['status', 'watch', 'diff', 'plan', 'logs']],
  ['Deliver', ['deliver']],
] as const;

function groupedHelp(command: Command, helper: Help): string {
  if (command.parent !== null) return defaultHelp(command, helper.helpWidth);
  const base = defaultHelp(command, helper.helpWidth);
  const marker = 'Commands:\n';
  const start = base.indexOf(marker);
  if (start < 0) return base;
  const prefix = base.slice(0, start);
  const commands = helper.visibleCommands(command);
  const byName = new Map(commands.map((child) => [child.name(), child]));
  const width = Math.max(...commands.map((child) => helper.subcommandTerm(child).length));
  const sections = HELP_GROUPS.map(([title, names]) => {
    const lines = names.flatMap((name) => {
      const child = byName.get(name);
      return child === undefined
        ? []
        : [`  ${helper.subcommandTerm(child).padEnd(width + 2)}${helper.subcommandDescription(child)}`];
    });
    return `${title}:\n${lines.join('\n')}`;
  });
  return `${prefix}${sections.join('\n\n')}\n`;
}

export function buildProgram(version: string): Command {
  const program = new Command();

  program
    .name('relay')
    .description(
      `Coordinate locally installed coding agents (${AGENT_LABELS}) to plan, review, implement\n` +
        'and critique work on an issue, a spec file or a prompt, inside an isolated git worktree.',
    )
    .version(version)
    .option('--update', 'update Relay itself to the latest version')
    .showHelpAfterError();

  program.configureHelp({ formatHelp: groupedHelp });

  // `--update` is an option rather than a command because it is about Relay
  // itself and not about a run: it is the one thing here that needs no
  // repository, no config and no agents.
  //
  // Hanging it off the root means the root now has an action handler, and
  // Commander stops reporting unknown commands once anything is hooked up
  // there. Both of the behaviours it was doing for us are restored below, so a
  // bare `relay` still prints help and a typo is still a typo.
  program.action(
    wrap(async (options: { update?: boolean }, command: Command): Promise<number> => {
      const [unrecognized] = command.args;
      if (unrecognized !== undefined) {
        command.error(`error: unknown command '${unrecognized}'`, { code: 'commander.unknownCommand' });
      }
      if (options.update === true) return updateCommand();
      if (theme().interactive) return homeSession();
      process.stderr.write(defaultHelp(command, process.stderr.isTTY ? process.stderr.columns : undefined));
      return 1;
    }),
  );

  program
    .command('start')
    .description(`guided setup: ${AGENT_LABELS}, GitHub, config, and a first run you understand`)
    .option('--check', 'report what is missing and exit, without prompting or signing in')
    .option('--tour', 'replay the explanation of what a run does')
    .option('--dry-run', 'walk the whole pipeline without calling a single agent')
    .action(wrap(startCommand));

  program
    .command('init')
    .description('set up .relay/config.json in the current repository')
    .option('-f, --force', 'overwrite an existing config')
    .option('-y, --yes', 'skip the guided setup and write the detected defaults')
    .action(wrap(initCommand));

  program
    .command('doctor')
    .description(`check that git, gh, ${AGENT_LABELS} and the repo are installed and authenticated`)
    .action(wrap(doctorCommand));

  program
    .command('run')
    .argument('[issue]', 'issue number, owner/repo#number, issue URL, or a path to a markdown file')
    .description('run the full workflow for an issue, a spec file or a prompt, deliver the result, and wait for the next issue')
    .option('--prompt <text>', 'work from a description instead of a tracker issue')
    .option('--editor', 'write the task in $EDITOR, the way `git commit` does')
    .option('-v, --verbose', 'stream raw agent events')
    .option('-b, --base <branch>', 'branch to base the worktree on')
    .option('--planner <agent>', `agent that plans and reviews code (${AGENT_PROVIDERS.join('|')})`)
    .option('--implementer <agent>', `agent that implements and reviews the plan (${AGENT_PROVIDERS.join('|')})`)
    .option('--max-plan-rounds <n>', 'maximum plan review rounds')
    .option('--max-code-rounds <n>', 'maximum code review rounds')
    .option('-f, --fast', 'one agent plans and implements: no plan review, no code review')
    .option('--no-prime', 'do not let reviewers read the repository ahead of their turn')
    .option('--no-parallel-tests', 'run the test suite after the code review instead of during it')
    .option('--no-tests', 'skip the test phase')
    .option('--commit', 'deliver no further than a commit on the run branch')
    .option('--push', 'push the run branch')
    .option('--pr', 'push and open a pull request')
    .option('-m, --merge', 'push, open and merge a pull request')
    .option('--merge-method <method>', 'merge method (squash|merge|rebase)')
    .option('--deliver <policy>', `how far to deliver the work (${DELIVERY_POLICIES.join('|')})`)
    .option('--no-offer-merge', 'finish without asking whether to merge')
    .option('--tuff', 'write the pull request, commits and code comments with typos, like a human')
    .action(wrap(runSession));

  program
    .command('resume')
    .argument('<run-id>', 'run id, short id, or "latest"')
    .description('continue an interrupted or failed run')
    .option('-v, --verbose', 'stream raw agent events')
    .option('--commit', 'deliver no further than a commit on the run branch')
    .option('--push', 'push the run branch')
    .option('--pr', 'push and open a pull request')
    .option('-m, --merge', 'push, open and merge a pull request')
    .option('--merge-method <method>', 'merge method (squash|merge|rebase)')
    .option('--deliver <policy>', `how far to deliver the work (${DELIVERY_POLICIES.join('|')})`)
    .option('--no-offer-merge', 'finish without asking whether to merge')
    .option('--tuff', 'write the pull request and commits with typos, like a human')
    .action(wrap(resumeCommand));

  program
    .command('deliver')
    .argument('[run-id]', 'run id, short id, or "latest"', 'latest')
    .description('run a finished run\'s delivery again: commit, push, pull request, merge')
    .option('--to <policy>', `how far to take it (${DELIVERY_POLICIES.join('|')})`)
    .action(wrap(deliverCommand));

  program
    .command('status')
    .argument('[run-id]', 'run id, short id, or "latest"')
    .description('list runs, or show one run\'s summary')
    .option('--json', 'print machine-readable JSON instead of the formatted table')
    .action(wrap(statusCommand));

  program
    .command('watch')
    .argument('[run-id]', 'run id, short id, or "latest"', 'latest')
    .description('follow a run\'s events as they happen')
    .option('-i, --interval <ms>', 'poll interval in milliseconds', '1000')
    .action(wrap(watchCommand));

  program
    .command('diff')
    .argument('[run-id]', 'run id, short id, or "latest"', 'latest')
    .description('show the git diff produced by a run')
    .option('-s, --stat', 'show a file summary instead of the full patch')
    .action(wrap(diffCommand));

  program
    .command('plan')
    .argument('[run-id]', 'run id, short id, or "latest"', 'latest')
    .description('print a run\'s approved plan')
    .action(wrap(planCommand));

  program
    .command('logs')
    .argument('[run-id]', 'run id, short id, or "latest"', 'latest')
    .description('print a run\'s event log')
    .option('-n, --limit <n>', 'number of events to show', '80')
    .option('-a, --all', 'show every event')
    .action(wrap(logsCommand));

  program
    .command('stop')
    .argument('[run-id]', 'run id, short id, or "latest"', 'latest')
    .description('cancel a running workflow')
    .action(wrap(stopCommand));

  return program;
}

export type { RunOptions };
