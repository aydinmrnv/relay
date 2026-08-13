import { readFile } from 'node:fs/promises';

import { AGENT_REGISTRY } from '../../agents/index.ts';
import { discoverRepository, type RepositoryInfo } from '../../git/repository.ts';
import { DEFAULT_CONFIG, ROLES, configPath, loadConfig, writeConfig, type RelayConfig, type Role } from '../../storage/config.ts';
import { discoverTestCommand } from '../../testing/discovery.ts';
import { Prompter, isPromptCancelled, type Choice, type PromptSession } from '../../ui/prompt.ts';
import { agentChecks, type AgentCheck } from '../checks.ts';
import { ensureRelayIgnored } from '../onboarding.ts';
import { statusMark } from './doctor.ts';
import { bullet, dim, heading, hint, out, rows, section, success, warning } from '../output.ts';

const RUNS_ENTRY = '.relay/runs/';

export interface InitOptions {
  force?: boolean;
  /** Skips every prompt and writes the detected defaults. Required for CI. */
  yes?: boolean;
}

/**
 * The two pieces of the outside world onboarding touches: the terminal, and
 * whether the coding CLIs are installed. Injected so the flow can be driven
 * without a TTY and without spawning a real `claude --version`.
 */
export interface InitDeps {
  prompter: PromptSession;
  checkAgents: () => Promise<AgentCheck[]>;
}

/** How each role is described during onboarding, in the order a run uses them. */
const ROLE_PROMPTS: Array<{ role: Role; question: string }> = [
  { role: 'planner', question: 'Which agent writes the plan?' },
  { role: 'planReviewer', question: 'Which agent reviews the plan?' },
  { role: 'implementer', question: 'Which agent implements it?' },
  { role: 'codeReviewer', question: 'Which agent reviews the code?' },
];

/**
 * Writes `.relay/config.json` and reports what Relay detected. Never overwrites
 * an existing config without `--force`: it may contain deliberate role choices.
 *
 * On a TTY this is a guided flow; `--yes`, a pipe, or CI take the same detected
 * defaults without asking. The consequential question — which model reviews
 * which — is the one a first run should never answer silently.
 */
export async function initCommand(options: InitOptions = {}): Promise<number> {
  return runInit(options, { prompter: new Prompter(), checkAgents: agentChecks });
}

export async function runInit(options: InitOptions, deps: InitDeps): Promise<number> {
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

  const config = structuredClone(alreadyConfigured ? existing : DEFAULT_CONFIG);

  // `--yes` forces the scripted path even on a TTY; everywhere else the
  // prompter has already decided from stdin and the theme.
  if (options.yes === true || !deps.prompter.interactive) {
    return writeDetectedConfig(repo, path, config, deps);
  }

  try {
    return await guidedInit(repo, path, config, deps);
  } catch (error) {
    if (!isPromptCancelled(error)) throw error;
    out();
    out(warning('Setup cancelled. Nothing was written.'));
    return 130;
  } finally {
    deps.prompter.close();
  }
}

/**
 * The non-interactive path, unchanged: `relay init --yes`, a pipe and CI all
 * produce exactly this, and scripts depend on it.
 */
async function writeDetectedConfig(
  repo: RepositoryInfo,
  path: string,
  config: RelayConfig,
  deps: InitDeps,
): Promise<number> {
  await writeConfig(repo.root, config);
  await ensureGitignore(repo.root);

  heading('Relay initialized');
  out();
  out(`  Config      ${path}`);
  out(`  Repository  ${repo.owner !== null && repo.name !== null ? `${repo.owner}/${repo.name}` : repo.root}`);
  out(`  Base branch ${repo.defaultBranch}`);

  const discovery = await discoverTestCommand(repo.root, null);
  out(`  Tests       ${discovery.found ? discovery.command.command.join(' ') : dim(`none detected (${discovery.reason})`)}`);

  const agents = await deps.checkAgents();
  const labelWidth = Math.max(11, ...AGENT_REGISTRY.map((entry) => entry.label.length));
  for (const { entry, check } of agents) {
    out(`  ${entry.label.padEnd(labelWidth)} ${check.status === 'ok' ? check.detail : warning(check.detail)}`);
  }

  out();
  if (agents.some(({ check }) => check.status !== 'ok')) {
    out(warning('Some agents are unavailable. Run `relay doctor` for details.'));
  } else {
    out(success('Ready. Run `relay run <issue-number>` to start.'));
  }
  return 0;
}

/** The five steps of the interactive flow: detect, check, assign, explain, land. */
async function guidedInit(repo: RepositoryInfo, path: string, config: RelayConfig, deps: InitDeps): Promise<number> {
  heading('Relay setup');
  out(dim('Every question has a default — press Enter to accept it.'));

  await confirmDetection(repo, config, deps.prompter);
  const agents = await confirmAgents(deps);
  await assignRoles(config, agents, deps.prompter);
  explainRun(config);

  await writeConfig(repo.root, config);
  await ensureGitignore(repo.root);

  section('Done');
  rows([
    { label: 'Config', value: path },
    { label: 'Run state', value: dim(`${RUNS_ENTRY} (git-ignored, machine-local)`) },
  ]);

  out();
  if (agents.some(({ check }) => check.status !== 'ok')) {
    out(warning('Some agents are still unavailable — `relay doctor` explains each one.'));
    out();
  }
  out(success('Next:'));
  out('  relay run <issue-number>');
  out();
  return 0;
}

/** Step 1 — show what Relay found, and let the user correct the two that matter. */
async function confirmDetection(repo: RepositoryInfo, config: RelayConfig, prompter: PromptSession): Promise<void> {
  section('1. This repository');
  rows([
    { label: 'Repository', value: repo.owner !== null && repo.name !== null ? `${repo.owner}/${repo.name}` : repo.root },
    { label: 'Root', value: repo.root },
  ]);
  out();

  const baseDefault = config.workflow.baseBranch.length > 0 ? config.workflow.baseBranch : repo.defaultBranch;
  const base = await prompter.text('  Base branch for run worktrees?', baseDefault, (value) =>
    value.trim().length === 0 ? 'Enter a branch name.' : undefined,
  );
  // An empty string means "whatever the repository's default is at run time",
  // which stays correct if the default branch is later renamed.
  config.workflow.baseBranch = base === repo.defaultBranch ? '' : base;

  const discovery = await discoverTestCommand(repo.root, null);
  const detected = discovery.found ? discovery.command.command.join(' ') : '';
  out();
  out(
    discovery.found
      ? dim(`  Detected test command: ${detected} (${discovery.command.reason})`)
      : dim(`  No test command detected (${discovery.reason}).`),
  );

  const configured = config.tests.command === null ? detected : config.tests.command.join(' ');
  const answer = await prompter.text('  Test command to verify a run? (blank to re-detect each run)', configured);

  // Accepting the detected command leaves discovery in charge, so a project that
  // changes how it runs tests does not need this config edited.
  config.tests.command = answer.trim().length === 0 || answer.trim() === detected ? null : tokenize(answer);
}

/** Step 2 — the doctor checks, with a re-check that does not restart the flow. */
async function confirmAgents(deps: InitDeps): Promise<AgentCheck[]> {
  for (;;) {
    section('2. Coding agents');
    const agents = await deps.checkAgents();
    const width = Math.max(...agents.map(({ entry }) => entry.label.length));
    for (const { entry, check } of agents) {
      out(`  ${statusMark(check)} ${entry.label.padEnd(width)}  ${dim(check.detail)}`);
    }

    const unavailable = agents.filter(({ check }) => check.status !== 'ok');
    if (unavailable.length === 0) return agents;

    out();
    for (const { entry, check } of unavailable) {
      out(`  ${entry.label}:`);
      for (const line of (check.hint ?? 'Install it and make sure it is on your PATH.').split('\n')) {
        if (line.length > 0) hint(line, '    ');
      }
    }

    out();
    // Defaults to "no" on purpose: the whole flow has to be completable with
    // Enter, and a re-check that Enter repeats would never terminate.
    if (!(await deps.prompter.confirm('  Fix it in another shell, then re-check?', false))) {
      out(dim('  Continuing. Relay will fail at the first turn an unavailable agent has to take.'));
      return agents;
    }
  }
}

/** Step 3 — the one question that actually shapes the workflow. */
async function assignRoles(config: RelayConfig, agents: AgentCheck[], prompter: PromptSession): Promise<void> {
  section('3. Roles');
  out(dim('  A plan reviewed by the model that wrote it is a plan nobody checked.'));
  out(dim('  Relay is built around each agent attacking the other\'s work, so keep'));
  out(dim('  the planner and the plan reviewer on different models.'));

  const choices: Array<Choice<string>> = agents.map(({ entry, check }) => ({
    value: entry.name,
    label: entry.label,
    ...(check.status === 'ok' ? {} : { hint: 'unavailable' }),
  }));

  for (const { role, question } of ROLE_PROMPTS) {
    out();
    config.agents[role] = await prompter.choice(`  ${question}`, choices, config.agents[role]);
  }

  if (config.agents.planner === config.agents.planReviewer) {
    out();
    out(warning('  The planner and plan reviewer are the same agent, so the plan is self-reviewed.'));
  }
  if (config.agents.implementer === config.agents.codeReviewer) {
    out(warning('  The implementer and code reviewer are the same agent, so the code is self-reviewed.'));
  }
}

/** Step 4 — what pressing enter on `relay run` is actually going to do. */
function explainRun(config: RelayConfig): void {
  section('4. What a run does');
  const sequence = [
    `plan (${config.agents.planner})`,
    `review (${config.agents.planReviewer}, up to ${config.workflow.maxPlanReviewRounds} rounds)`,
    `implement (${config.agents.implementer})`,
    `review (${config.agents.codeReviewer}, up to ${config.workflow.maxCodeReviewRounds} rounds)`,
    'tests',
  ];
  bullet(sequence.join(' → '));
  bullet('All of it inside a throwaway git worktree — your own branch, index and files are untouched.');
  bullet('A run typically takes 10–20 minutes and spends real tokens on your own CLI accounts.');
  bullet(`It then delivers the work itself: ${deliverySentence(config)}.`);
  bullet('Delivery never goes past `workflow.deliver`, and every step it skips is reported with the reason.');
  bullet(endingSentence(config));
  bullet('Then Relay goes back to its home screen and waits for the next issue, rather than exiting.');
}

/** The questions a run ends on, which is everything the policy left undone. */
function endingSentence(config: RelayConfig): string {
  if (!config.workflow.offerMerge) return 'Nothing is asked afterwards (workflow.offerMerge: false).';
  if (config.workflow.deliver === 'merge') {
    return 'Merging happens automatically, because this repository asked for it.';
  }
  return config.workflow.deliver === 'pr'
    ? 'Merging is the one thing it asks about, once, at the end — and Enter means no.'
    : 'What the policy left undone is asked at the end, once each: the pull request, then the merge — and Enter means no.';
}

/** What the delivery phase would do in this repository, spelled out. */
function deliverySentence(config: RelayConfig): string {
  switch (config.workflow.deliver) {
    case 'none':
      return 'nothing — the diff stays in the worktree (workflow.deliver: none)';
    case 'branch':
      return 'commits it to the run branch, and stops there';
    case 'push':
      return 'commits and pushes the run branch';
    case 'pr':
      return 'commits, pushes and opens a pull request';
    case 'merge':
      return `commits, pushes, opens a pull request and merges it (${config.workflow.mergeMethod})`;
  }
}

function tokenize(input: string): string[] {
  return input.trim().split(/\s+/).filter((part) => part.length > 0);
}

function printConfig(config: RelayConfig): void {
  rows([
    ...ROLES.map((role) => ({ label: roleLabel(role), value: config.agents[role] })),
    { label: 'plan rounds', value: String(config.workflow.maxPlanReviewRounds) },
    { label: 'code rounds', value: String(config.workflow.maxCodeReviewRounds) },
  ]);
}

function roleLabel(role: Role): string {
  switch (role) {
    case 'planner':
      return 'planner';
    case 'planReviewer':
      return 'plan reviewer';
    case 'implementer':
      return 'implementer';
    case 'codeReviewer':
      return 'code reviewer';
  }
}

/**
 * Run state is machine-local and can be large, so it is kept out of git.
 * The config itself is intentionally committable.
 */
async function ensureGitignore(repoRoot: string): Promise<void> {
  const added = await ensureRelayIgnored(repoRoot);
  if (added.length > 0) out(dim(`  Added ${added.join(', ')} to .gitignore`));
}

async function readFileOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}
