import { readFile } from 'node:fs/promises';

import {
  delegateLogin,
  describeCommand,
  probeAuth,
  type AuthState,
  type AuthSupport,
} from '../../auth/delegated.ts';
import { discoverRepository, type RepositoryInfo } from '../../git/repository.ts';
import { workspacesRoot } from '../../git/worktree.ts';
import {
  ISSUE_TRACKER_REGISTRY,
  issueTrackerRegistration,
  type IssueTrackerRegistration,
} from '../../issues/registry.ts';
import { resolveExecutable } from '../../process/runner.ts';
import { configPath, loadConfig, type RelayConfig } from '../../storage/config.ts';
import { RelayError } from '../../util/errors.ts';
import { Prompter, isPromptCancelled, type Choice, type PromptSession } from '../../ui/prompt.ts';
import { agentChecks, authStateCheck, type AgentCheck, type Check } from '../checks.ts';
import { checksToJson } from '../doctorJson.ts';
import { EXIT } from '../exit.ts';
import { emitJson } from '../json.ts';
import { ensureRelayIgnored, loadOnboarding, saveOnboarding } from '../onboarding.ts';
import {
  banner,
  bold,
  command,
  dim,
  fail,
  failure,
  heading,
  hint,
  ok,
  out,
  rows,
  section,
  success,
  warn,
  warning,
} from '../output.ts';
import { runSession, validateIssueRef } from '../session.ts';
import { initCommand, type InitOptions } from './init.ts';
import { statusMark } from './doctor.ts';
import type { RunOptions } from './run.ts';

export interface StartOptions {
  /** Report what is missing and exit, without prompting or signing anything in. */
  check?: boolean;
  /** Replay the explanation of what a run does. */
  tour?: boolean;
  /** Walk the whole pipeline without calling a single agent. */
  dryRun?: boolean;
  /**
   * Report readiness as JSON. Implies `--check`: a guided walkthrough is a
   * conversation, and there is no JSON document that is a conversation.
   */
  json?: boolean;
}

/**
 * Everything `start` touches outside itself. Injected so the flow — which
 * questions, in what order, and what it does with the answers — is testable
 * without a TTY, without spawning `gh auth login`, and without spending a token.
 */
export interface StartDeps {
  prompter: PromptSession;
  checkAgents: () => Promise<AgentCheck[]>;
  /** Sign-in state, asked of the vendor's own CLI. */
  authState: (support: AuthSupport, cwd: string) => Promise<AuthState>;
  /** Hands the terminal to the vendor's own login command. */
  login: (support: AuthSupport, cwd: string) => Promise<boolean>;
  installed: (binary: string) => Promise<boolean>;
  providerCheck: (
    registration: IssueTrackerRegistration,
    cwd: string,
  ) => Promise<{ available: boolean; detail: string; hint?: string }>;
  init: (options: InitOptions) => Promise<number>;
  run: (issueRef: string, options: RunOptions) => Promise<number>;
  now: () => Date;
}

/**
 * One command from a fresh clone to a first run.
 *
 * The hard rule this flow is built around: Relay has no API keys, reads no
 * credentials and never sees a token. Every sign-in step below delegates to the
 * vendor's own login command with the terminal handed over, then re-asks that
 * vendor whether it worked. There is no path here that prompts for a secret,
 * and nothing it learns is written to `.relay/config.json`.
 *
 * Each step is idempotent, so re-running is both the resume path and the repair
 * path when one dependency breaks later.
 */
export async function startCommand(options: StartOptions = {}): Promise<number> {
  return runStart(options, {
    prompter: new Prompter(),
    checkAgents: agentChecks,
    authState: (support, cwd) => probeAuth(support, { cwd }),
    login: (support, cwd) => delegateLogin(support, { cwd }),
    installed: async (binary) => (await resolveExecutable(binary)) !== null,
    providerCheck: (registration, cwd) => registration.create({ cwd }).checkAvailability(),
    init: initCommand,
    // The first run ends on the home screen rather than on a shell prompt: what
    // follows a run is the next issue, and onboarding is where that starts.
    run: runSession,
    now: () => new Date(),
  });
}

export async function runStart(options: StartOptions, deps: StartDeps): Promise<number> {
  const repo = await preflight();
  const json = options.json === true;

  if (options.tour === true && !json) {
    heading('How a Relay run works');
    showTour(await loadConfig(repo.root));
    await rememberTour(repo, deps);
    return EXIT.success;
  }

  // A prompt nobody can answer is a hang. Behind a pipe, in CI, or under
  // `--json`, `start` is `--check`: say what is missing, attempt no login, and
  // exit with the code that means "not set up".
  if (json || options.check === true || !deps.prompter.interactive) {
    return reportReadiness(repo, deps, { interactive: deps.prompter.interactive, json });
  }

  try {
    return await guidedStart(repo, deps, options);
  } catch (error) {
    if (!isPromptCancelled(error)) throw error;
    out();
    out(warning('Cancelled. Everything already done is kept — re-run `relay start` to continue.'));
    return EXIT.cancelled;
  } finally {
    deps.prompter.close();
  }
}

/** Step 1 — nothing else is worth checking outside a repository. */
async function preflight(): Promise<RepositoryInfo> {
  try {
    return await discoverRepository(process.cwd());
  } catch (error) {
    throw new RelayError('`relay start` must run inside a git repository.', {
      code: 'NOT_A_REPOSITORY',
      hint: 'cd into your project (or run `git init`), then run `relay start` again.',
      cause: error,
    });
  }
}

async function guidedStart(repo: RepositoryInfo, deps: StartDeps, options: StartOptions): Promise<number> {
  banner('Coding agents that plan, review and check each other\'s work.');
  heading('relay start');
  out(dim('Anything already satisfied is skipped, so re-running is safe at any point.'));
  out(dim('Relay never asks for a token: every sign-in below is that vendor\'s own command.'));

  section('1. Repository');
  rows([
    { label: 'Repository', value: repo.owner !== null && repo.name !== null ? `${repo.owner}/${repo.name}` : repo.root },
    { label: 'Root', value: repo.root },
    { label: 'Base branch', value: repo.defaultBranch },
  ]);

  const blockers = [...(await ensureAgents(repo, deps)), ...(await ensureIssueProvider(repo, deps))];

  const configCode = await ensureConfig(repo, deps);
  if (configCode !== 0) return configCode;
  const config = await loadConfig(repo.root);

  section('5. How a run works');
  const onboarding = await loadOnboarding(repo.root);
  if (onboarding.tourShownAt === undefined) {
    showTour(config);
    await rememberTour(repo, deps);
  } else {
    out(dim('  Already covered. `relay start --tour` brings it back.'));
  }

  return firstRun(repo, config, blockers, deps, options);
}

/**
 * Step 2 — the coding CLIs. Missing is the user's job to fix; signed out is
 * something onboarding can drive, by running the vendor's login itself.
 */
async function ensureAgents(repo: RepositoryInfo, deps: StartDeps): Promise<string[]> {
  section('2. Coding agents');

  const blockers: string[] = [];
  for (const { entry, check } of await deps.checkAgents()) {
    if (check.status !== 'ok') {
      fail(`${entry.label}  ${dim(check.detail)}`);
      hint('Install it, then run `relay start` again:', '    ');
      command(entry.installCommand, '    ');
      blockers.push(`${entry.label} is not installed.`);
      continue;
    }

    let state = await deps.authState(entry.auth, repo.root);
    printAuthRow(entry.label, check.detail, state);

    if (state !== 'authenticated') {
      state = await offerLogin(entry.label, entry.auth, state, repo.root, deps);
    }
    if (state === 'unauthenticated') blockers.push(`${entry.label} is not signed in.`);
  }
  return blockers;
}

/**
 * Step 3 — where the issues come from, and whether that tracker is usable.
 *
 * A tracker that is missing or signed out is a warning rather than a blocker,
 * because it no longer stops a first run: `relay run ./spec.md` and
 * `relay run --prompt "…"` need nothing installed and nothing signed into. The
 * person deciding whether this tool is worth adopting can find that out before
 * they file anything.
 */
async function ensureIssueProvider(repo: RepositoryInfo, deps: StartDeps): Promise<string[]> {
  section('3. Issues');

  let chosen = ISSUE_TRACKER_REGISTRY[0]!;
  if (ISSUE_TRACKER_REGISTRY.length > 1) {
    const choices: Array<Choice<string>> = ISSUE_TRACKER_REGISTRY.map((entry) => ({
      value: entry.name,
      label: entry.label,
    }));
    const name = await deps.prompter.choice('  Where do your issues live?', choices, chosen.name);
    chosen = issueTrackerRegistration(name) ?? chosen;
  } else {
    // Naming the one supported tracker beats a question with a single answer.
    out(dim(`  Issues come from ${chosen.label}, the only tracker Relay supports today.`));
  }

  if (!(await deps.installed(chosen.binary))) {
    warn(`${chosen.label}  ${dim(`${chosen.binary} not found`)}`);
    hint('Install it if your issues live there:', '    ');
    command(chosen.installCommand, '    ');
    withoutATracker();
    return [];
  }

  let status = await deps.providerCheck(chosen, repo.root);
  if (!status.available) {
    fail(`${chosen.label}  ${dim(status.detail)}`);
    await offerLogin(chosen.label, chosen.auth, 'unauthenticated', repo.root, deps);
    status = await deps.providerCheck(chosen, repo.root);
  }

  if (status.available) {
    ok(`${chosen.label}  ${dim(status.detail)}`);
    return [];
  }

  warn(`${chosen.label}  ${dim(status.detail)}`);
  withoutATracker();
  return [];
}

/** The other half of step 3: work that has no ticket, which needs no tracker. */
function withoutATracker(): void {
  hint('You can still run Relay on work that has no ticket:', '    ');
  command('relay run ./spec.md          # the file is the issue', '    ');
  command('relay run --prompt "Fix the flaky timeout in the retry test"', '    ');
  command('relay run --editor           # write it in $EDITOR', '    ');
}

/**
 * Offers to run a vendor's own login flow.
 *
 * This is the only place onboarding touches authentication, and all it can do
 * is spawn someone else's command with the terminal attached. Relay reads
 * nothing the vendor prints and stores nothing it learns; afterwards it simply
 * asks that CLI again whether it is signed in.
 */
async function offerLogin(
  label: string,
  support: AuthSupport,
  state: AuthState,
  cwd: string,
  deps: StartDeps,
): Promise<AuthState> {
  const invocation = describeCommand(support.login);

  hint(
    state === 'unauthenticated'
      ? `${label} is installed but signed out.`
      : `Relay could not tell whether ${label} is signed in.`,
    '    ',
  );
  hint(`Relay hands the terminal to ${label} and reads none of it — no token reaches Relay.`, '    ');

  // Defaults to yes only when we know sign-in is missing; an unknown state is
  // usually a CLI that simply cannot be asked, and re-launching it every run
  // would make the flow worse rather than better.
  const proceed = await deps.prompter.confirm(`    Run \`${invocation}\` now?`, state === 'unauthenticated');
  if (!proceed) {
    hint(`Skipped. Run \`${invocation}\` yourself before a run needs ${label}.`, '    ');
    return state;
  }

  // Release stdin before the child takes the terminal: two readers of one
  // terminal means neither the prompt nor the login gets a whole keystroke.
  deps.prompter.close();
  out(dim(`    Handing over to \`${invocation}\`…`));
  out();

  const completed = await deps.login(support, cwd);
  const next = await deps.authState(support, cwd);
  out();

  if (next === 'authenticated') ok(`${label} is signed in.`);
  else if (!completed) fail(`\`${invocation}\` did not complete. Continuing without ${label}.`);
  else warn(`${label} still reports no session. Try \`${invocation}\` in another shell.`);

  return next;
}

/** Step 4 — `init` owns configuration; `start` only decides whether to call it. */
async function ensureConfig(repo: RepositoryInfo, deps: StartDeps): Promise<number> {
  section('4. Configuration');

  const path = configPath(repo.root);
  if (await fileExists(path)) {
    ok(`${path}  ${dim('already configured')}`);
    hint('`relay init --force` re-runs the guided setup: roles, review rounds, test command.', '    ');
    return 0;
  }

  out(dim('  Handing off to `relay init`: roles, review rounds and the test command.'));
  out();

  // init drives the terminal from here, and two readline interfaces on one
  // stdin would split the user's keystrokes between them.
  deps.prompter.close();
  const code = await deps.init({});
  if (code === 0) return 0;

  out();
  out(warning('Configuration did not finish, so `relay start` stops here.'));
  hint('Run `relay init` on its own to finish it, then `relay start` again.');
  return code;
}

/**
 * Step 5 — the tour. Shown once, because the second run of `relay start` is
 * usually someone repairing a broken CLI, not someone learning the workflow.
 */
function showTour(config: RelayConfig): void {
  const inline = config.workflow.plan === 'inline';

  out(dim('  Four agent turns, in order. Each one leaves an artifact you can read afterwards.'));
  out();
  rows(
    [
      inline
        ? { label: '1. Plan', value: `${config.agents.implementer} plans in the same turn it implements` }
        : { label: '1. Plan', value: `${config.agents.planner} reads the issue and writes a plan` },
      !inline && {
        label: '2. Plan review',
        value: `${config.agents.planReviewer} attacks that plan, up to ${config.workflow.maxPlanReviewRounds} round(s)`,
      },
      { label: '3. Implement', value: `${config.agents.implementer} writes the code in an isolated worktree` },
      {
        label: '4. Code review',
        value: config.workflow.reviewCode
          ? `${config.agents.codeReviewer} reviews the diff, up to ${config.workflow.maxCodeReviewRounds} round(s)`
          : dim('disabled in config'),
      },
      {
        label: '5. Tests',
        value: config.workflow.runTests
          ? config.workflow.concurrentTests
            ? 'your own test command, run during the code review'
            : 'your own test command, discovered per run'
          : dim('disabled in config'),
      },
    ],
    '    ',
  );

  if (config.workflow.primeReviewers) {
    out();
    hint('Each reviewer reads the repository while the work it reviews is still being written,');
    hint('so a review turn is spent judging rather than opening files for the first time.');
  }

  out();
  hint(
    config.agents.planner === config.agents.planReviewer
      ? 'The plan is reviewed by the model that wrote it here — change that in `relay init --force`:'
      : 'The plan is reviewed by a different model than wrote it, and that is the point:',
  );
  hint('a plan checked only by its own author is a plan nobody checked.');

  out();
  out(`  ${bold('What lands on disk')}  ${dim('.relay/runs/<run-id>/')}`);
  rows(
    [
      { label: 'plan.md', value: 'the approved plan — the artifact worth reading first' },
      { label: 'summary.md', value: 'what happened, phase by phase, with timings and cost' },
      { label: 'issue.md', value: 'the issue exactly as the agents saw it' },
      { label: 'events.jsonl', value: dim('every agent event, behind `relay logs`') },
      { label: 'patches/', value: dim('the diff the run produced, behind `relay diff`') },
      { label: 'state.json', value: dim('machine state, behind `relay resume`') },
    ],
    '    ',
  );

  out();
  out(`  ${bold('What it costs')}`);
  rows(
    [
      {
        label: 'Time',
        value: inline
          ? 'typically 5–10 minutes; a large issue takes longer'
          : 'typically 8–15 minutes; `relay run <issue> --fast` skips both reviews',
      },
      { label: 'Tokens', value: 'billed to your own Claude Code and Codex accounts' },
      { label: 'Reporting', value: '`relay status <run>` shows tokens, and cost when the CLI reports one' },
    ],
    '    ',
  );

  out();
  out(`  ${bold('How a run ends')}  ${dim(`workflow.deliver: ${config.workflow.deliver}`)}`);
  rows(
    [
      { label: 'Delivery', value: `${deliveryStep(config)} — the run does that much itself` },
      { label: 'Asked', value: askedStep(config) },
      { label: 'Gated', value: 'each step runs only if the one it depends on did; skipped steps say why' },
      { label: 'Honest', value: 'failed tests or unanswered blocking findings open the pull request as a draft' },
      { label: 'Then', value: 'back to the Relay home screen, waiting for the next issue' },
      { label: 'Again', value: '`relay deliver <run>` re-runs it; steps already done are skipped, not repeated' },
    ],
    '    ',
  );

  out();
  out(`  ${bold('What Relay never does')}`);
  rows(
    [
      { label: 'Past the policy', value: `nothing beyond \`${config.workflow.deliver}\` — no merge unless you set one` },
      { label: 'Your tree', value: `untouched — a run works in a throwaway worktree under ${workspacesRoot()}` },
      { label: 'Credentials', value: 'never read, never prompted for, never stored — each CLI owns its own' },
    ],
    '    ',
  );
  out();
  hint('`relay stop <run>` cancels a run; `relay run <issue> --deliver branch` keeps the work local.');
}

/** Step 6 — the run itself, or a rehearsal of one that spends nothing. */
async function firstRun(
  repo: RepositoryInfo,
  config: RelayConfig,
  blockers: readonly string[],
  deps: StartDeps,
  options: StartOptions,
): Promise<number> {
  section('6. First run');

  const dry = options.dryRun === true;
  if (blockers.length > 0) {
    for (const blocker of blockers) warn(blocker);
    out();
    if (!dry) {
      hint('Fix those, then run `relay start` again — nothing above needs redoing.');
      out();
      return EXIT.preconditions;
    }
    hint('A dry run needs none of them: it calls no agent.');
    out();
  }

  const question = dry
    ? '  Walk through a run now, without calling any agent?'
    : '  Start a run against a real issue now?';
  // A real run defaults to "no": it takes 10–20 minutes and spends real tokens,
  // so it is never what pressing Enter does.
  if (!(await deps.prompter.confirm(question, dry))) {
    printNextSteps(dry);
    return blockers.length > 0 ? EXIT.preconditions : EXIT.success;
  }

  const ref = await deps.prompter.text(
    '  Which issue? (number, owner/repo#number, URL, or a path to a markdown file)',
    '',
    validateIssueRef,
  );
  if (ref.trim().length === 0) {
    out();
    hint('No issue given, so nothing was started.');
    printNextSteps(dry);
    return blockers.length > 0 ? EXIT.preconditions : EXIT.success;
  }

  await markCompleted(repo, deps);

  if (dry) return rehearseRun(repo, config, ref);

  // The run renderer owns the terminal from here.
  deps.prompter.close();
  out();
  return deps.run(ref, {});
}

/**
 * Walks the pipeline with no agent calls: same phases, same artifacts, same
 * guarantees, nothing spawned and nothing spent. It is the cheapest way to see
 * the shape of a run before committing 10–20 minutes and real tokens to one.
 */
function rehearseRun(repo: RepositoryInfo, config: RelayConfig, issueRef: string): number {
  const base = config.workflow.baseBranch.length > 0 ? config.workflow.baseBranch : repo.defaultBranch;

  out();
  out(bold('Dry run') + dim(' — no agent is called, no process is spawned, nothing is spent.'));
  out();
  rows([
    { label: 'Issue', value: issueRef },
    { label: 'Base branch', value: base },
    { label: 'Branch', value: `${config.workflow.branchPrefix}/<issue>-<short-id>  ${dim('(created, never pushed)')}` },
    { label: 'Worktree', value: `${workspacesRoot()}/…  ${dim('(throwaway, outside your repo)')}` },
    { label: 'Run state', value: '.relay/runs/<run-id>/' },
  ]);

  out();
  out(`  ${bold('What a real run would do, in order')}`);
  rows(
    [
      { label: 'Fetch issue', value: `read ${issueRef} through the issue provider  ${dim('→ issue.md')}` },
      { label: 'Workspace', value: `create the worktree and branch from ${base}` },
      { label: 'Plan', value: agentStep(config.agents.planner, 'read-only', config.timeouts.planningMs, 'plan.md') },
      {
        label: 'Plan review',
        value: agentStep(config.agents.planReviewer, 'read-only', config.timeouts.reviewMs, 'a verdict + findings'),
      },
      {
        label: 'Implement',
        value: agentStep(config.agents.implementer, 'write', config.timeouts.implementationMs, 'a diff'),
      },
      {
        label: 'Code review',
        value: agentStep(config.agents.codeReviewer, 'read-only', config.timeouts.reviewMs, 'blocking findings'),
      },
      {
        label: 'Tests',
        value: config.workflow.runTests
          ? testsStep(config)
          : dim('skipped (workflow.runTests is false)'),
      },
      {
        label: 'Deliver',
        value: `${deliveryStep(config)}  ${dim(`(workflow.deliver: ${config.workflow.deliver})`)}`,
      },
    ],
    '    ',
  );

  out();
  out(success('Nothing above happened. To do it for real:'));
  command(`relay run ${issueRef}`);
  out();
  return 0;
}

/** What the last phase of a run would actually do, in this repository's config. */
function deliveryStep(config: RelayConfig): string {
  switch (config.workflow.deliver) {
    case 'none':
      return 'leave the work staged in the worktree';
    case 'branch':
      return 'commit to the run branch';
    case 'push':
      return 'commit and push the run branch';
    case 'pr':
      return 'commit, push and open a pull request';
    case 'merge':
      return `commit, push, open a pull request and merge it (${config.workflow.mergeMethod})`;
  }
}

/**
 * What the run asks once it is done. Everything the policy did not authorize is
 * a question at the end rather than a setting decided weeks earlier — and every
 * one of those questions defaults to no.
 */
function askedStep(config: RelayConfig): string {
  if (!config.workflow.offerMerge) return dim('nothing (workflow.offerMerge: false)');
  if (config.workflow.deliver === 'merge') return dim('nothing — this repository asked for the merge up front');
  return config.workflow.deliver === 'pr'
    ? 'the merge, once, and only when it is possible — Enter is no'
    : 'the pull request, then the merge — once each, and Enter is no';
}

function agentStep(agent: string, capability: string, timeoutMs: number, produces: string): string {
  return `${agent}  ${dim(`${capability}, up to ${Math.round(timeoutMs / 60_000)}m`)}  ${dim(`→ ${produces}`)}`;
}

function testsStep(config: RelayConfig): string {
  return config.tests.command === null
    ? `discover and run this project's tests  ${dim('(detected per run)')}`
    : `run ${config.tests.command.join(' ')}`;
}

/**
 * The report `--check`, a pipe and CI all get: what is missing, and nothing
 * else. No question is asked and no login is attempted, so it cannot hang.
 */
async function reportReadiness(
  repo: RepositoryInfo,
  deps: StartDeps,
  mode: { interactive: boolean; json: boolean },
): Promise<number> {
  if (!mode.json) {
    heading('relay start --check');
    out();
    out(
      dim(
        mode.interactive
          ? 'Reporting only: nothing is prompted and no login is attempted.'
          : 'Not a terminal, so this is a report: nothing is prompted and no login is attempted.',
      ),
    );
    out();
  }

  const checks: Check[] = [
    {
      label: 'Git repository',
      status: 'ok',
      detail: `${repo.owner !== null && repo.name !== null ? `${repo.owner}/${repo.name}` : repo.root} · base ${repo.defaultBranch}`,
    },
  ];

  for (const { entry, check } of await deps.checkAgents()) {
    checks.push({ ...check, label: entry.label, ...(check.status === 'ok' ? {} : { hint: entry.installCommand }) });
    if (check.status !== 'ok') continue;
    checks.push(authStateCheck(`${entry.label} sign-in`, entry.auth, await deps.authState(entry.auth, repo.root)));
  }

  // A tracker is a warning, not a failure: a run can start from a file or a
  // prompt without one, so `--check` must not claim Relay is unusable.
  const provider = ISSUE_TRACKER_REGISTRY[0]!;
  const withoutIt = 'Or work without a tracker: `relay run ./spec.md`, `relay run --prompt "…"`.';
  if (!(await deps.installed(provider.binary))) {
    checks.push({
      label: provider.label,
      status: 'warn',
      detail: `${provider.binary} not found`,
      hint: `${provider.installCommand}\n${withoutIt}`,
    });
  } else {
    const status = await deps.providerCheck(provider, repo.root);
    checks.push({
      label: provider.label,
      status: status.available ? 'ok' : 'warn',
      detail: status.detail,
      ...(status.available ? {} : { hint: `Run \`${describeCommand(provider.auth.login)}\`.\n${withoutIt}` }),
    });
  }

  const path = configPath(repo.root);
  checks.push(
    (await fileExists(path))
      ? { label: 'Configuration', status: 'ok', detail: path }
      : { label: 'Configuration', status: 'fail', detail: 'no .relay/config.json', hint: 'Run `relay init --yes`.' },
  );

  const failed = checks.filter((check) => check.status === 'fail');

  if (mode.json) {
    emitJson('start', checksToJson(checks));
    return failed.length === 0 ? EXIT.success : EXIT.preconditions;
  }

  const width = Math.max(...checks.map((check) => check.label.length));
  for (const check of checks) out(`  ${statusMark(check)} ${check.label.padEnd(width)}  ${dim(check.detail)}`);

  // Warnings get their advice printed too — a tracker Relay could not reach is
  // worth explaining even though it no longer stops a run.
  const imperfect = checks.filter((check) => check.status !== 'ok');
  if (imperfect.length > 0) {
    out();
    for (const check of imperfect) {
      out(`  ${check.label}:`);
      for (const line of (check.hint ?? 'Run `relay doctor` for details.').split('\n')) hint(line, '    ');
    }
  }

  out();
  out(
    failed.length === 0
      ? success('Ready. Run `relay start` on a terminal for a guided first run.')
      : failure(`${failed.length} thing(s) still missing. Fix them, then run \`relay start\` on a terminal.`),
  );
  return failed.length === 0 ? EXIT.success : EXIT.preconditions;
}

function printAuthRow(label: string, detail: string, state: AuthState): void {
  if (state === 'authenticated') ok(`${label}  ${dim(`${detail} · signed in`)}`);
  else if (state === 'unknown') warn(`${label}  ${dim(`${detail} · sign-in state unknown`)}`);
  else fail(`${label}  ${dim(`${detail} · not signed in`)}`);
}

function printNextSteps(dry: boolean): void {
  out();
  hint('When you are ready:');
  command('relay run <issue-number>');
  command(`relay run --prompt "…"   ${dim('# work that has no ticket')}`);
  if (!dry) command(`relay start --dry-run   ${dim('# the same pipeline, without spending anything')}`);
  out();
}

async function rememberTour(repo: RepositoryInfo, deps: StartDeps): Promise<void> {
  // The marker is machine-local, so it is ignored before it is written — a
  // `--tour` in a repo that never ran `relay init` would otherwise leave an
  // untracked file behind for the user to wonder about.
  await ensureRelayIgnored(repo.root);
  const state = await loadOnboarding(repo.root);
  await saveOnboarding(repo.root, { ...state, tourShownAt: deps.now().toISOString() });
}

async function markCompleted(repo: RepositoryInfo, deps: StartDeps): Promise<void> {
  const state = await loadOnboarding(repo.root);
  await saveOnboarding(repo.root, { ...state, completedAt: deps.now().toISOString() });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8');
    return true;
  } catch {
    return false;
  }
}
