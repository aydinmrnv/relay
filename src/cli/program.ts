import { Command, Help, Option } from 'commander';

import { AGENT_PROVIDERS, AGENT_REGISTRY } from '../agents/index.ts';
import { DELIVERY_POLICIES, REVIEW_LEVELS } from '../storage/config.ts';
import { deliverCommand } from './commands/deliver.ts';
import { chatgptLoginCommand, chatgptLogoutCommand, chatgptStatusCommand, type ChatgptLoginOptions } from './commands/chatgpt.ts';
import { doctorCommand } from './commands/doctor.ts';
import { notifyCommand } from './commands/notify.ts';
import { collect, evalCommand } from './commands/eval.ts';
import { EVAL_COMPARISON_NAMES, EVAL_CONFIG_NAMES } from '../eval/configs.ts';
import { DEFAULT_COMPANION_PORT } from '../studio/protocol.ts';
import { DEFAULT_WEBHOOK_PORT } from '../graph/serve.ts';
import { connectCommand } from './commands/connect.ts';
import { hubServeCommand, hubTokenCommand } from './commands/hub.ts';
import { initCommand } from './commands/init.ts';
import { serveCommand } from './commands/serve.ts';
import {
  workflowApprovalsCommand,
  workflowCheckCommand,
  workflowDecideCommand,
  workflowRunCommand,
  workflowServeCommand,
  type WorkflowRunOptions,
  type WorkflowServeOptions,
} from './commands/workflow.ts';
import { startCommand } from './commands/start.ts';
import { updateCommand } from './commands/update.ts';
import { resumeCommand, runDetachedChild, type RunOptions } from './commands/run.ts';
import { homeCommand } from './commands/home.ts';
import { statsCommand } from './commands/stats.ts';
import { recordingCommand } from './commands/recording.ts';
import { cleanCommand } from './commands/clean.ts';
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
import { emitJsonLine, enterJsonMode, errorToJson, jsonMode } from './json.ts';
import { completionCommand, COMPLETION_HELP } from './commands/completion.ts';
import { completeCommand } from './completion/complete.ts';
import { formatCommandDoc, helpRow, visibleCommands } from './help/commandDoc.ts';
import { closestMatch } from '../util/text.ts';

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
 * The name a document says it came from. Commander passes the Command itself
 * as the last argument; the root's handler answers for the home screen.
 */
function commandNameOf(args: readonly unknown[]): string {
  const command = args.at(-1);
  if (!(command instanceof Command)) return 'relay';
  return command.parent === null ? 'home' : command.name();
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
      const code = exitCodeFor(error);
      // Commander has already printed its own message and its own help.
      if (!isCommanderError(error)) {
        reportError(error);
        // The prose above went to stderr. Whatever is parsing stdout gets the
        // same failure as a document, rather than an empty stream.
        if (jsonMode()) emitJsonLine(commandNameOf(args), errorToJson(error, code));
      }
      process.exitCode = code;
    }
  };
}

export function defaultHelp(command: Command, width?: number): string {
  const helper = new Help();
  if (width !== undefined) helper.helpWidth = width;
  return helper.formatHelp(command, helper);
}

const HELP_GROUPS = [
  ['Studio', ['connect']],
  ['Cloud', ['hub']],
  ['Setup', ['start', 'init', 'doctor', 'chatgpt', 'notify']],
  ['Run', ['run', 'resume', 'stop']],
  ['Workflows', ['workflow']],
  ['Unattended', ['serve']],
  ['Inspect', ['status', 'watch', 'diff', 'plan', 'logs', 'stats', 'recording']],
  ['Deliver', ['deliver']],
  ['Measure', ['eval']],
  ['Maintain', ['clean']],
  ['Shell', ['completion']],
] as const;

function groupedHelp(command: Command, helper: Help): string {
  const helpWidth = helper.helpWidth ?? 80;
  if (command.parent !== null) return formatCommandDoc(command, helpWidth);
  const base = defaultHelp(command, helpWidth);
  const marker = 'Commands:\n';
  const start = base.indexOf(marker);
  if (start < 0) return base;
  const prefix = base.slice(0, start);
  const commands = helper.visibleCommands(command);
  const byName = new Map(commands.map((child) => [child.name(), child]));
  const width = Math.max(...commands.map((child) => helper.subcommandTerm(child).length));
  // A group whose every command is hidden has nothing to head, so it is left
  // out rather than printed as a title over an empty list.
  const sections = HELP_GROUPS.flatMap(([title, names]) => {
    const lines = names.flatMap((name) => {
      const child = byName.get(name);
      return child === undefined
        ? []
        : [helpRow(helper.subcommandTerm(child), helper.subcommandDescription(child), width, helpWidth)];
    });
    return lines.length === 0 ? [] : [`${title}:\n${lines.join('\n')}`];
  });
  return `${prefix}${sections.join('\n\n')}\n`;
}

/**
 * `--tuff`: kept working, and kept out of the help, the man page and the
 * completions. It is a flag for somebody who already knows it is there.
 */
function tuffOption(description: string): Option {
  return new Option('--tuff', description).hideHelp();
}

export function buildProgram(version: string): Command {
  const program = new Command();

  program
    .name('relay')
    // One paragraph with no line breaks of its own: Commander wraps it to the
    // terminal, and text that arrives already wrapped for one width is ragged
    // at every other.
    .description(
      `The workflow studio's companion on this machine. \`relay connect\` lets the studio sign in ` +
        `the coding agents here (${AGENT_LABELS}), run its workflows for real in this repository and ` +
        'install their exports; every other command is the engine behind the Agent pipeline node — ' +
        'plan, review, implement and critique an issue, a spec file or a prompt in an isolated worktree.',
    )
    .version(version)
    .option('--update', 'update Relay itself to the latest version')
    .option('--json', JSON_FLAG)
    // A mistyped command gets the line that says what is wrong and where the
    // list is — not the list itself, which is fifty lines pushing the one
    // useful sentence off the top of the terminal.
    .showHelpAfterError('(run with --help for usage)');

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
        const near = closestMatch(unrecognized, visibleCommands(command).map((child) => child.name()));
        command.error(
          `error: unknown command '${unrecognized}'${near === undefined ? '' : `\n(Did you mean ${near}?)`}`,
          { code: 'commander.unknownCommand' },
        );
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

  // First in the help because it is how the studio and this machine meet:
  // everything the studio does for real — sign-ins, runs, installing an export
  // — goes through the server this starts.
  program
    .command('connect')
    .description('pair this machine with the workflow studio: agent sign-in, real runs, installing exports')
    .option('-p, --port <n>', `port on 127.0.0.1 to listen on (default ${DEFAULT_COMPANION_PORT}, or RELAY_COMPANION_PORT)`)
    .option('--studio <url>', 'the studio to pair with (default the hosted studio, or RELAY_STUDIO_URL)')
    .option('--allow-origin <origin>', 'another studio origin allowed to connect (repeatable)', collect, [])
    .option('--open', 'open the pairing page even when not at a terminal')
    .option('--no-open', 'never open a browser; print the pairing link instead')
    .option('--new-token', 'replace this machine\'s secret; every start already has a pairing token of its own')
    .option('--env-file <path>', 'read the credentials a workflow\'s app steps need (SLACK_WEBHOOK_URL, …) from a file of NAME=value lines')
    .option('--hub <url>', 'run as a Relay Cloud runner: dial out to this hub instead of listening (or RELAY_HUB_URL)')
    .option('--token-from <source>', 'with --hub, where the runner token is: env (RELAY_RUNNER_TOKEN), stdin, file:<path>, or azure')
    .option('--json', `${JSON_FLAG} — one object per line: listening, then each event`)
    .action(wrap(connectCommand));

  // The server side of Relay Cloud. People never run this; whoever hosts the
  // hub does, and each runner machine it makes runs `connect --hub`. So it is
  // hidden from the help, the man page and the first word of a completion —
  // `relay hub --help` and `relay hub <TAB>` still answer whoever does need it.
  const hub = program
    .command('hub', { hidden: true })
    .description('run the Relay Cloud hub: one machine per person, reached through here');
  hub
    .command('serve')
    .description('serve the hub, configured by RELAY_HUB_* and RELAY_CLOUD_* variables (docs/design/relay-cloud-runners.md)')
    .option('--json', `${JSON_FLAG} — one log object per line`)
    .action(wrap(hubServeCommand));
  hub
    .command('token')
    .description('mint a runner token for a machine you start yourself (needs RELAY_HUB_SECRET)')
    .requiredOption('--user <id>', 'the Clerk user id the runner serves')
    .requiredOption('--runner <name>', 'a name for the machine, e.g. my-server')
    .action(wrap(hubTokenCommand));

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

  // Not `codex login`, which signs the Codex CLI in. This signs Relay in, and
  // it is the only sign-in Relay holds itself — see src/auth/chatgpt.ts.
  const chatgpt = program.command('chatgpt').description('Sign in with ChatGPT: Codex turns in Relay use your ChatGPT plan, with no `codex login`');
  chatgpt
    .command('login')
    .description('continue with ChatGPT in your browser, and let Relay use your ChatGPT plan for Codex')
    .option('--new', 'add another ChatGPT account or workspace instead of signing back in to the saved one')
    .option('--no-open', 'never open a browser; print the sign-in link instead')
    .option('--json', JSON_FLAG)
    .action(wrap((options: ChatgptLoginOptions) => chatgptLoginCommand(options)));
  chatgpt
    .command('status')
    .description('say whether Relay is signed in with ChatGPT, and what Codex turns are billed to')
    .option('--json', JSON_FLAG)
    .action(wrap((options: { json?: boolean }) => chatgptStatusCommand(options)));
  chatgpt
    .command('logout')
    .description('end the ChatGPT session at OpenAI and forget its tokens; Codex goes back to its own sign-in')
    .option('--json', JSON_FLAG)
    .action(wrap((options: { json?: boolean }) => chatgptLogoutCommand(options)));

  program
    .command('notify')
    .argument('[run]', 'a run id, short id or `latest` to re-send; omit to send a test')
    .description('send a finished run\'s notification now, to test the webhook, desktop and command channels')
    .option('--json', JSON_FLAG)
    .action(wrap(notifyCommand));

  program
    .command('run')
    .argument('[issue...]', 'issue numbers, owner/repo#number, issue URLs, or paths to markdown files')
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
    .option('-r, --review <level>', `how hard the agents look (${REVIEW_LEVELS.join('|')})`)
    .option('--max-plan-rounds <n>', 'maximum plan review rounds')
    .option('--max-code-rounds <n>', 'maximum code review rounds')
    .option('--max-cost <usd>', 'stop the run at the first phase boundary past this many dollars')
    .option('-f, --fast', 'shorthand for --review none: one agent plans and implements, unreviewed')
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
    .option('--allow-secret <path>', 'publish a file the secret scan flagged (repeatable)', collect, [])
    .addOption(tuffOption('write the pull request, commits and code comments with typos, like a human'))
    .option('--json', `${JSON_FLAG} — one object per line as phases complete, then a summary`)
    .option('--detach', 'start the run in the background and return immediately')
    .action(wrap(runSession));

  // `__` marks a command Relay spawns for itself: hidden from `--help`, and
  // skipped by the help, man page and completion generators alike.
  program.command('__run-detached <run-id>', { hidden: true }).action(wrap(runDetachedChild));

  // Grouped apart from `run` in the help, because it is a different promise:
  // everything else here starts when a person types it, and this one starts
  // when somebody else labels an issue. The guardrails that makes acceptable
  // are config, not flags — see `unattended` in .relay/config.json.
  program
    .command('serve')
    .description('watch the tracker and start a run per labelled issue, inside a budget and an allowlist')
    .option('--once', 'make one pass over the tracker and exit, instead of polling')
    .option('--issue <ref>', 'consider only this issue (implies --once) — what the GitHub Action passes')
    .option('--label <name>', 'trigger label to watch for, overriding workflow.triggerLabel')
    .option('-i, --interval <seconds>', 'seconds between polls, overriding unattended.pollSeconds')
    .option('--limit <n>', 'issues to look at per pass')
    .option('--dry-run', 'decide everything, start nothing, and move no labels')
    .option('-v, --verbose', 'log every pass, not only what changed')
    .option('--json', `${JSON_FLAG} — one object per line as it decides, then a summary`)
    .action(wrap(serveCommand));

  // A workflow drawn in the studio, run as drawn: the guardrails, the logic,
  // the pipeline and the steps after it. `relay run` is the pipeline alone.
  const workflow = program.command('workflow').description('run a workflow from the studio as it was drawn: its guardrails, logic, pipeline and the steps after it');
  workflow
    .command('run')
    .argument('[workflow]', 'a name under .relay/workflows/, or a file; omit when the repository has one')
    .argument('[issue]', 'the issue to work on: a number, a URL, or a Linear key')
    .description('run the whole workflow once, for an issue, a description or an event')
    .option('-p, --prompt <text>', 'describe the change instead of naming an issue')
    .option('--event <file>', 'a JSON event, as a webhook would deliver it: the guardrails decide, as for a real one')
    .option('--dry-run', 'decide every guardrail and condition, and start, post and publish nothing')
    .option('--env-file <path>', 'read the credentials the app steps need from a file of NAME=value lines')
    .option('-v, --verbose', 'print each step\'s detail, and the run\'s own notes')
    .option('--json', `${JSON_FLAG} — one object per line as each step finishes`)
    .action(wrap((ref: string | undefined, issue: string | undefined, options: WorkflowRunOptions) => workflowRunCommand(ref, issue, options)));
  workflow
    .command('serve')
    .argument('[workflow]', 'a name under .relay/workflows/, or a file; omit when the repository has one')
    .description('keep the workflow\'s trigger: listen for its webhook, its schedule or its label, and run it each time')
    .option('--port <n>', `port the incoming webhook listens on (default ${DEFAULT_WEBHOOK_PORT})`)
    .option('--host <address>', 'address to listen on; anything but this machine needs RELAY_WEBHOOK_SECRET', '127.0.0.1')
    .option('-i, --interval <seconds>', 'seconds between looks at the tracker, for a label trigger')
    .option('--once', 'run the first event and exit')
    .option('--dry-run', 'decide every guardrail and condition, and start, post and publish nothing')
    .option('--env-file <path>', 'read the credentials the app steps need from a file of NAME=value lines')
    .option('-v, --verbose', 'print each step\'s detail, and the run\'s own notes')
    .option('--json', `${JSON_FLAG} — one object per line`)
    .action(wrap((ref: string | undefined, options: WorkflowServeOptions) => workflowServeCommand(ref, options)));
  workflow
    .command('check')
    .argument('[workflow]', 'a name under .relay/workflows/, or a file; omit when the repository has one')
    .description('say what each step needs, and which steps Relay cannot perform yet')
    .option('--env-file <path>', 'count the variables in this file as set')
    .option('--json', JSON_FLAG)
    .action(wrap((ref: string | undefined, options: { envFile?: string; json?: boolean }) => workflowCheckCommand(ref, options)));
  workflow
    .command('approvals')
    .description('list the approvals a workflow is waiting on')
    .option('-a, --all', 'include the ones already answered or out of time')
    .option('--json', JSON_FLAG)
    .action(wrap((options: { all?: boolean; json?: boolean }) => workflowApprovalsCommand(options)));
  workflow
    .command('approve')
    .argument('<id>', 'the approval, as `relay workflow approvals` lists it')
    .description('answer yes to a Human approval step, and let the run carry on')
    .option('--as <login>', 'who is answering, when the step names its approvers')
    .option('--json', JSON_FLAG)
    .action(wrap((id: string, options: { as?: string; json?: boolean }) => workflowDecideCommand(true, id, options)));
  workflow
    .command('reject')
    .argument('<id>', 'the approval, as `relay workflow approvals` lists it')
    .description('answer no to a Human approval step: the run takes its Rejected path')
    .option('--as <login>', 'who is answering, when the step names its approvers')
    .option('--json', JSON_FLAG)
    .action(wrap((id: string, options: { as?: string; json?: boolean }) => workflowDecideCommand(false, id, options)));

  program
    .command('clean')
    .description('remove finished run worktrees (dry run by default)')
    .option('--all', 'consider every finished run, not only merged runs')
    .option('--older-than <days>', 'only consider runs older than this many days')
    .option('--force', 'permit removal of unlanded or unverifiable work')
    .option('-y, --yes', 'perform removals')
    .option('--json', JSON_FLAG)
    .action(wrap(cleanCommand));

  program
    .command('resume')
    .argument('<run-id>', 'run id, short id, or "latest"')
    .description('continue an interrupted or failed run')
    .option('-v, --verbose', 'stream raw agent events')
    .option('-r, --review <level>', `how hard the agents look from here on (${REVIEW_LEVELS.join('|')})`)
    .option('--max-cost <usd>', 'stop the run at the first phase boundary past this many dollars')
    .option('--commit', 'deliver no further than a commit on the run branch')
    .option('--push', 'push the run branch')
    .option('--pr', 'push and open a pull request')
    .option('-m, --merge', 'push, open and merge a pull request')
    .option('--merge-method <method>', 'merge method (squash|merge|rebase)')
    .option('--deliver <policy>', `how far to deliver the work (${DELIVERY_POLICIES.join('|')})`)
    .option('--no-offer-merge', 'finish without asking whether to merge')
    .option('--allow-secret <path>', 'publish a file the secret scan flagged (repeatable)', collect, [])
    .addOption(tuffOption('write the pull request and commits with typos, like a human'))
    .option('--json', `${JSON_FLAG} — one object per line as phases complete, then a summary`)
    .action(wrap(resumeCommand));

  program
    .command('deliver')
    .argument('[run-id]', 'run id, short id, or "latest"', 'latest')
    .description('run a finished run\'s delivery again: commit, push, pull request, merge')
    .option('--to <policy>', `how far to take it (${DELIVERY_POLICIES.join('|')})`)
    .option('--allow-secret <path>', 'publish a file the secret scan flagged (repeatable)', collect, [])
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
    .command('recording')
    .argument('[run-id]', 'run id, short id, or "latest"', 'latest')
    .description('write a finished run to one file the studio can play back')
    .option('-o, --out <file>', 'where to write it (default: relay-run-<short id>.json)')
    .option('--no-patches', 'leave the diffs out: the receipts still say what changed, without the code')
    .option('--json', JSON_FLAG)
    .action(wrap(recordingCommand));

  program
    .command('stats')
    .description('what this repository\'s runs have cost, taken, and caught')
    .option('--json', JSON_FLAG)
    .action(wrap(statsCommand));

  program
    .command('eval')
    .description('measure whether cross-model review actually produces better changes')
    // Listed with commas rather than bars: seven names joined by `|` are one
    // unbreakable word, and no terminal is wide enough to wrap around it.
    .option('--config <name...>', `configuration(s) to run: ${EVAL_CONFIG_NAMES.join(', ')}`, collect)
    .option('--compare <name...>', `run the arms of a comparison: ${EVAL_COMPARISON_NAMES.join(', ')}`, collect)
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
