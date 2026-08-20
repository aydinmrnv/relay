import { Command, Help } from 'commander';

import { AGENT_PROVIDERS, AGENT_REGISTRY } from '../agents/index.ts';
import { DELIVERY_POLICIES } from '../storage/config.ts';
import { deliverCommand } from './commands/deliver.ts';
import { doctorCommand } from './commands/doctor.ts';
import { collect, evalCommand } from './commands/eval.ts';
import { EVAL_COMPARISON_NAMES, EVAL_CONFIG_NAMES } from '../eval/configs.ts';
import { initCommand } from './commands/init.ts';
import { startCommand } from './commands/start.ts';
import { updateCommand } from './commands/update.ts';
import { resumeCommand, type RunOptions } from './commands/run.ts';
import { homeCommand } from './commands/home.ts';
import { statsCommand } from './commands/stats.ts';
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
import { EXIT, exitCodeFor, isCommanderError } from './exit.ts';
import { enterJsonMode } from './json.ts';
import { completionCommand, COMPLETION_HELP } from './commands/completion.ts';
import { completeCommand } from './completion/complete.ts';
import { formatCommandDoc } from './help/commandDoc.ts';

/** Help text names whichever CLIs are registered, not whichever shipped first. */
const AGENT_LABELS = AGENT_REGISTRY.map((entry) => entry.label).join(', ');

/** The description every `--json` flag carries, so they all read identically. */
const JSON_FLAG = 'print machine-readable JSON on stdout and nothing else';

/**
 * Commander hands an action handler the parsed options as a plain object, after
 * the declared arguments and before the Command itself. Finding it by shape
 * rather than by position lets `wrap` stay one function across commands that
 * take no argument, one, or two.
 */
function optionsOf(args: readonly unknown[]): { json?: unknown } | undefined {
  return args.find(
    (arg): arg is { json?: unknown } =>
      typeof arg === 'object' && arg !== null && Object.getPrototypeOf(arg) === Object.prototype,
  );
}

/**
 * Wraps a command so every failure exits with a code from the published table
 * and an actionable message, instead of an unhandled rejection stack.
 *
 * `--json` is claimed here rather than inside each command: the promise is
 * about the whole invocation, including the lines a command prints before it
 * reaches the code that knows the flag exists.
 */
function wrap<Args extends unknown[]>(
  handler: (...args: Args) => Promise<number>,
): (...args: Args) => Promise<void> {
  return async (...args: Args): Promise<void> => {
    if (optionsOf(args)?.json === true) enterJsonMode();
    try {
      process.exitCode = await handler(...args);
    } catch (error) {
      // Commander has already printed its own message and its own help.
      if (!isCommanderError(error)) reportError(error);
      process.exitCode = exitCodeFor(error);
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
  ['Inspect', ['status', 'watch', 'diff', 'plan', 'logs', 'stats']],
  ['Deliver', ['deliver']],
  ['Measure', ['eval']],
  ['Shell', ['completion']],
] as const;

function groupedHelp(command: Command, helper: Help): string {
  if (command.parent !== null) return formatCommandDoc(command);
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
    .option('--json', JSON_FLAG)
    .showHelpAfterError();

  program.configureHelp({ formatHelp: groupedHelp });

  // The root and every subcommand declare their own `--json`, and by default
  // Commander resolves a repeated flag against the parent — which would silently
  // hand `relay status --json` to the home screen's option and leave `status`
  // printing its human table. Positional parsing puts each option where it was
  // typed: before the subcommand it is the program's, after it the subcommand's.
  program.enablePositionalOptions();

  // Commander exits the process itself, with 1 for every kind of usage error.
  // Taking that over is what lets a caller tell "you typed it wrong" (2) from
  // "Relay could not do it" (1) — and the setting is inherited by every
  // subcommand declared below, so a bad flag anywhere lands in the same place.
  program.exitOverride();

  // `--update` is an option rather than a command because it is about Relay
  // itself and not about a run: it is the one thing here that needs no
  // repository, no config and no agents.
  //
  // Hanging it off the root means the root now has an action handler, and
  // Commander stops reporting unknown commands once anything is hooked up
  // there. Both of the behaviours it was doing for us are restored below, so a
  // bare `relay` still prints help and a typo is still a typo.
  program.action(
    wrap(async (options: { update?: boolean; json?: boolean }, command: Command): Promise<number> => {
      const [unrecognized] = command.args;
      if (unrecognized !== undefined) {
        command.error(`error: unknown command '${unrecognized}'`, { code: 'commander.unknownCommand' });
      }
      if (options.update === true) return updateCommand();
      // `--json` is a request for the home screen's facts, so it answers with
      // them wherever it runs — behind a pipe it no longer means "print help".
      // It never opens a session: the next question is for a person, and
      // whatever is parsing this is not one.
      if (options.json === true) return homeCommand({ json: true });
      if (theme().interactive) return homeSession();
      process.stderr.write(defaultHelp(command, process.stderr.isTTY ? process.stderr.columns : undefined));
      return EXIT.error;
    }),
  );

  program
    .command('start')
    .description(`guided setup: ${AGENT_LABELS}, GitHub, config, and a first run you understand`)
    .option('--check', 'report what is missing and exit, without prompting or signing in')
    .option('--tour', 'replay the explanation of what a run does')
    .option('--dry-run', 'walk the whole pipeline without calling a single agent')
    .option('--json', `${JSON_FLAG} (implies --check: a guided walkthrough has no JSON form)`)
    .action(wrap(startCommand));

  program
    .command('init')
    .description('set up .relay/config.json in the current repository')
    .option('-f, --force', 'overwrite an existing config')
    .option('-y, --yes', 'skip the guided setup and write the detected defaults')
    .option('--json', `${JSON_FLAG} (implies --yes)`)
    .action(wrap(initCommand));

  program
    .command('doctor')
    .description(`check that git, gh, ${AGENT_LABELS} and the repo are installed and authenticated`)
    .option('--json', JSON_FLAG)
    .action(wrap(doctorCommand));

  program
    .command('run')
    .argument('[issue]', 'issue number, owner/repo#number, issue URL, or a path to a markdown file')
    .description('run the full workflow for an issue, a spec file or a prompt, deliver the result, and wait for the next issue')
    .option('--prompt <text>', 'work from a description instead of a tracker issue')
    .option('--editor', 'write the task in $EDITOR, the way `git commit` does')
    .option('--label <name>', 'filter issues by label (repeatable)', collect, [])
    .option('--assignee <login>', 'filter issues by assignee')
    .option('--mine', 'filter issues assigned to you')
    .option('--limit <n>', 'maximum issues to list')
    .option('-y, --yes', 'run an explicitly named closed issue without prompting')
    .option('-v, --verbose', 'stream raw agent events')
    .option('-b, --base <branch>', 'branch to base the worktree on')
    .option('--planner <agent>', `agent that plans and reviews code (${AGENT_PROVIDERS.join('|')})`)
    .option('--implementer <agent>', `agent that implements and reviews the plan (${AGENT_PROVIDERS.join('|')})`)
    .option('--max-plan-rounds <n>', 'maximum plan review rounds')
    .option('--max-code-rounds <n>', 'maximum code review rounds')
    .option('--max-cost <usd>', 'stop the run at the first phase boundary past this many dollars')
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
    .option('--json', `${JSON_FLAG} — one object per line as phases complete, then a summary`)
    .action(wrap(runSession));

  program
    .command('resume')
    .argument('<run-id>', 'run id, short id, or "latest"')
    .description('continue an interrupted or failed run')
    .option('-v, --verbose', 'stream raw agent events')
    .option('--max-cost <usd>', 'stop the run at the first phase boundary past this many dollars')
    .option('--commit', 'deliver no further than a commit on the run branch')
    .option('--push', 'push the run branch')
    .option('--pr', 'push and open a pull request')
    .option('-m, --merge', 'push, open and merge a pull request')
    .option('--merge-method <method>', 'merge method (squash|merge|rebase)')
    .option('--deliver <policy>', `how far to deliver the work (${DELIVERY_POLICIES.join('|')})`)
    .option('--no-offer-merge', 'finish without asking whether to merge')
    .option('--tuff', 'write the pull request and commits with typos, like a human')
    .option('--json', `${JSON_FLAG} — one object per line as phases complete, then a summary`)
    .action(wrap(resumeCommand));

  program
    .command('deliver')
    .argument('[run-id]', 'run id, short id, or "latest"', 'latest')
    .description('run a finished run\'s delivery again: commit, push, pull request, merge')
    .option('--to <policy>', `how far to take it (${DELIVERY_POLICIES.join('|')})`)
    .option('--json', JSON_FLAG)
    .action(wrap(deliverCommand));

  program
    .command('status')
    .argument('[run-id]', 'run id, short id, or "latest"')
    .description('list runs, or show one run\'s summary')
    .option('--json', JSON_FLAG)
    .action(wrap(statusCommand));

  program
    .command('watch')
    .argument('[run-id]', 'run id, short id, or "latest"', 'latest')
    .description('follow a run\'s events as they happen')
    .option('-i, --interval <ms>', 'poll interval in milliseconds', '1000')
    .option('--json', `${JSON_FLAG} — one object per line, as each event arrives`)
    .action(wrap(watchCommand));

  program
    .command('diff')
    .argument('[run-id]', 'run id, short id, or "latest"', 'latest')
    .description('show the git diff produced by a run')
    .option('-s, --stat', 'show a file summary instead of the full patch')
    .option('--json', JSON_FLAG)
    .action(wrap(diffCommand));

  program
    .command('plan')
    .argument('[run-id]', 'run id, short id, or "latest"', 'latest')
    .description('print a run\'s approved plan')
    .option('--json', JSON_FLAG)
    .action(wrap(planCommand));

  program
    .command('logs')
    .argument('[run-id]', 'run id, short id, or "latest"', 'latest')
    .description('print a run\'s event log')
    .option('-n, --limit <n>', 'number of events to show', '80')
    .option('-a, --all', 'show every event')
    .option('--json', JSON_FLAG)
    .action(wrap(logsCommand));

  program
    .command('stats')
    .description('what this repository\'s runs have cost, taken, and caught')
    .option('--json', JSON_FLAG)
    .action(wrap(statsCommand));

  program
    .command('eval')
    .description('measure whether cross-model review actually produces better changes')
    .option('--config <name...>', `configuration(s) to run (${EVAL_CONFIG_NAMES.join('|')})`, collect)
    .option('--compare <name...>', `run the arms of a comparison (${EVAL_COMPARISON_NAMES.join('|')})`, collect)
    .option('--fixture <id...>', 'run only these fixtures', collect)
    .option('-n, --repeat <n>', 'runs per fixture per configuration', '3')
    .option('--concurrency <n>', 'runs in flight at once (above 1, wall-clock is contended)', '1')
    .option('--agents <a,b>', 'the two agents to compare, e.g. claude,codex')
    .option('--fixtures <dir>', 'fixture directory to use instead of the shipped set')
    .option('--out <dir>', 'where results are written')
    .option('--check-fixtures', 'verify every fixture against its base commit and exit — costs nothing')
    .option('--report', 'regenerate the results table from recorded sessions and exit')
    .option('--dry-run', 'print the plan and the cost estimate, and run nothing')
    .option('-y, --yes', 'do not ask before spending')
    .option('--keep', 'leave scratch repositories and worktrees behind for inspection')
    .option('-v, --verbose', 'forward each run\'s own notes')
    .option('--json', JSON_FLAG)
    .action(wrap(evalCommand));

  program
    .command('stop')
    .argument('[run-id]', 'run id, short id, or "latest"', 'latest')
    .description('cancel a running workflow')
    .option('--json', JSON_FLAG)
    .action(wrap(stopCommand));

  program
    .command('completion <shell>')
    .description('print a shell completion script')
    .addHelpText('after', `\n${COMPLETION_HELP}\n`)
    .action(async (shell: string) => {
      try {
        process.exitCode = await completionCommand(program, shell);
      } catch (error) {
        if (!isCommanderError(error)) reportError(error);
        process.exitCode = exitCodeFor(error);
      }
    });

  program
    .command('__complete', { hidden: true })
    .allowUnknownOption(true)
    .passThroughOptions()
    .argument('[words...]')
    .action(async (words: string[] | undefined) => completeCommand(program, words ?? []));

  return program;
}

export type { RunOptions };
