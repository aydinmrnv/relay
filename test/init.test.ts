import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { runInit, type InitDeps } from '../src/cli/commands/init.ts';
import { setTheme } from '../src/cli/output.ts';
import type { AgentCheck } from '../src/cli/checks.ts';
import { AGENT_REGISTRY } from '../src/agents/index.ts';
import { loadConfig, configPath, type RelayConfig } from '../src/storage/config.ts';
import type { PromptSession } from '../src/ui/prompt.ts';
import { RelayError } from '../src/util/errors.ts';
import type { Theme } from '../src/ui/theme.ts';
import { ScriptedPrompter } from './helpers/scriptedPrompter.ts';
import { createTempRepo, type TempRepo } from './helpers/tempRepo.ts';

let repo: TempRepo;

const PIPED: Theme = { color: false, unicode: true, interactive: false };

beforeEach(async () => {
  repo = await createTempRepo({ withPackageJson: true });
  // Every assertion here is about text, never about escape codes.
  setTheme(PIPED);
});

afterEach(async () => {
  setTheme(undefined);
  await repo.cleanup();
});

/** Agent probe results, without spawning a real `claude --version`. */
function stubAgents(available: boolean): () => Promise<AgentCheck[]> {
  return async () =>
    AGENT_REGISTRY.map((entry) => ({
      entry,
      check: available
        ? { label: entry.label, status: 'ok' as const, detail: `${entry.name} 1.0.0` }
        : {
            label: entry.label,
            status: 'fail' as const,
            detail: 'not found',
            hint: `Install ${entry.name} and sign in.`,
          },
    }));
}

interface Session {
  output: string;
  exitCode: number;
  prompter: ScriptedPrompter;
}

interface FlowOptions {
  interactive?: boolean;
  agentsAvailable?: boolean;
  force?: boolean;
  yes?: boolean;
}

/** Runs the flow from inside the temp repo, capturing everything it printed. */
async function runFlow(answers: readonly string[] = [], options: FlowOptions = {}): Promise<Session> {
  const prompter = new ScriptedPrompter(answers, options.interactive ?? true);
  const deps: InitDeps = { prompter, checkAgents: stubAgents(options.agentsAvailable ?? true) };

  const originalCwd = process.cwd();
  const originalWrite = process.stdout.write.bind(process.stdout);
  let output = '';

  process.chdir(repo.root);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;

  try {
    const exitCode = await runInit(
      { ...(options.force === true ? { force: true } : {}), ...(options.yes === true ? { yes: true } : {}) },
      deps,
    );
    return { output, exitCode, prompter };
  } finally {
    process.stdout.write = originalWrite;
    process.chdir(originalCwd);
  }
}

function readConfig(): Promise<RelayConfig> {
  return loadConfig(repo.root);
}

describe('relay init — non-interactive', () => {
  it('writes the detected defaults without asking anything', async () => {
    const { output, exitCode, prompter } = await runFlow([], { interactive: false });

    assert.equal(exitCode, 0);
    assert.deepEqual(prompter.asked, [], 'a non-interactive init must not ask a single question');
    assert.match(output, /Relay initialized/);
    assert.match(output, /Base branch main/);
    // package.json declares a test script, so discovery reports it.
    assert.match(output, /Tests\s+npm test/);
    assert.ok(!output.includes('Relay setup'), output);

    assert.deepEqual((await readConfig()).agents, {
      planner: 'claude',
      planReviewer: 'codex',
      implementer: 'codex',
      codeReviewer: 'claude',
    });
  });

  it('reports the exact same block whether it was --yes or a pipe', async () => {
    const piped = await runFlow([], { interactive: false });
    const pipedRoot = repo.root;

    await repo.cleanup();
    repo = await createTempRepo({ withPackageJson: true });
    // `--yes` on a TTY takes the same path, and must print the same thing.
    const yes = await runFlow([], { interactive: true, yes: true });

    assert.equal(yes.exitCode, 0);
    // Only the repository path legitimately differs between the two runs.
    assert.equal(yes.output.replaceAll(repo.root, '<repo>'), piped.output.replaceAll(pipedRoot, '<repo>'));
  });

  it('says which agents are unavailable and points at doctor', async () => {
    const { output } = await runFlow([], { interactive: false, agentsAvailable: false });

    assert.match(output, /Some agents are unavailable\. Run `relay doctor` for details\./);
    assert.ok(!output.includes('Ready. Run'));
  });

  it('adds the run directory to .gitignore exactly once', async () => {
    await runFlow([], { interactive: false });
    await runFlow([], { interactive: false, force: true });

    const gitignore = await readFile(join(repo.root, '.gitignore'), 'utf8');
    assert.equal(gitignore.split('\n').filter((line) => line.trim() === '.relay/runs/').length, 1);
  });

  it('refuses to overwrite an existing config and prints it instead', async () => {
    await runFlow([], { interactive: false });
    const { output } = await runFlow([], { interactive: false });

    assert.match(output, /already exists/);
    assert.match(output, /Re-run with --force/);
    assert.match(output, /planner\s+claude/);
    assert.match(output, /plan reviewer\s+codex/);
    assert.ok(!output.includes('Relay initialized'), 'it must not claim to have written anything');
  });

  it('never produces an escape sequence', async () => {
    // Detection is left to the real environment here: under the test runner
    // stdout is a pipe, which is the case the acceptance criteria name.
    setTheme(undefined);
    const { output } = await runFlow([], { interactive: false });
    assert.ok(!output.includes(''), output);
  });
});

describe('relay init — guided', () => {
  // base branch, test command, planner, plan reviewer, implementer, code reviewer
  const ALL_DEFAULTS: string[] = [];

  it('walks the five steps and writes the roles the user chose', async () => {
    const { output, exitCode } = await runFlow(['', '', 'codex', 'claude', 'claude', 'codex']);

    assert.equal(exitCode, 0);
    for (const step of [
      /Relay setup/,
      /1\. This repository/,
      /2\. Coding agents/,
      /3\. Roles/,
      /4\. What a run does/,
      /Done/,
    ]) {
      assert.match(output, step);
    }

    assert.deepEqual((await readConfig()).agents, {
      planner: 'codex',
      planReviewer: 'claude',
      implementer: 'claude',
      codeReviewer: 'codex',
    });
  });

  it('asks for all four roles, offering every registered agent', async () => {
    const { prompter } = await runFlow(ALL_DEFAULTS);

    const roleQuestions = prompter.asked.filter((question) => question.includes('agent'));
    assert.deepEqual(roleQuestions, [
      '  Which agent writes the plan?',
      '  Which agent reviews the plan?',
      '  Which agent implements it?',
      '  Which agent reviews the code?',
    ]);
    // Driven by the registry, so a newly added harness is offered automatically.
    const names = AGENT_REGISTRY.map((entry) => entry.name);
    assert.equal(prompter.offered.length, 4);
    for (const offered of prompter.offered) assert.deepEqual(offered, names);
  });

  it('completes on defaults alone, keeping the shipped roles', async () => {
    const { output, exitCode } = await runFlow(ALL_DEFAULTS);
    const config = await readConfig();

    assert.equal(exitCode, 0);
    assert.deepEqual(config.agents, {
      planner: 'claude',
      planReviewer: 'codex',
      implementer: 'codex',
      codeReviewer: 'claude',
    });
    // Accepting the detected base branch leaves it empty, which means "whatever
    // the repository default is at run time".
    assert.equal(config.workflow.baseBranch, '');
    // Accepting the detected test command leaves discovery in charge per run.
    assert.equal(config.tests.command, null);
    assert.match(output, /relay run <issue-number>/);
  });

  it('records a corrected base branch and an explicit test command', async () => {
    await runFlow(['develop', 'make check']);

    const config = await readConfig();
    assert.equal(config.workflow.baseBranch, 'develop');
    assert.deepEqual(config.tests.command, ['make', 'check']);
  });

  it('shows the detected test command before asking about it', async () => {
    const { output } = await runFlow(ALL_DEFAULTS);
    assert.match(output, /Detected test command: npm test/);
  });

  it('explains the shape and the cost of a run before finishing', async () => {
    const { output } = await runFlow(ALL_DEFAULTS);

    assert.match(output, /10–20 minutes/);
    // The end of a run is part of its shape: it delivers as far as the policy
    // in config, and never past it.
    assert.match(output, /delivers the work itself: commits it to the run branch/);
    assert.match(output, /never goes past `workflow.deliver`/);
    // The decisions it does not make for you, and where it leaves you after.
    assert.match(output, /asked at the end, once each: the pull request, then the merge/);
    assert.match(output, /back to its home screen and waits for the next issue/);
    assert.match(output, /plan \(claude\).*implement \(codex\)/s);
    // The round limits are named, not left to be discovered mid-run.
    assert.match(output, /up to 2 rounds/);
    assert.match(output, /up to 2 rounds/);
  });

  it('warns when a plan would be reviewed by the model that wrote it', async () => {
    const { output } = await runFlow(['', '', 'claude', 'claude', 'codex', 'codex']);

    assert.match(output, /planner and plan reviewer are the same agent/);
    assert.match(output, /implementer and code reviewer are the same agent/);
    // A warning, not a veto: one installed CLI is still a usable setup.
    assert.equal((await readConfig()).agents.planReviewer, 'claude');
  });

  it('offers a re-check for an unavailable agent and defaults to continuing', async () => {
    // The re-check has to default to "no": a flow that must be completable with
    // Enter cannot contain a question whose default repeats the question.
    const { output, exitCode, prompter } = await runFlow(ALL_DEFAULTS, { agentsAvailable: false });

    assert.equal(exitCode, 0);
    assert.match(output, /Install claude and sign in\./);
    assert.ok(prompter.asked.some((question) => /re-check/i.test(question)));
    assert.match(output, /Continuing\./);
    assert.match(output, /still unavailable/);
  });

  it('re-checks when asked, and proceeds once the agents appear', async () => {
    let probes = 0;
    const prompter = new ScriptedPrompter(['', '', 'yes']);
    const deps: InitDeps = {
      prompter,
      checkAgents: async () => {
        probes += 1;
        // Missing the first time, installed by the second — the whole point of
        // offering a re-check instead of telling the user to start over.
        return stubAgents(probes > 1)();
      },
    };

    const originalCwd = process.cwd();
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.chdir(repo.root);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      assert.equal(await runInit({}, deps), 0);
    } finally {
      process.stdout.write = originalWrite;
      process.chdir(originalCwd);
    }

    assert.equal(probes, 2, 'the second probe is the re-check');
    assert.equal(prompter.closed, true, 'the flow must release the terminal');
  });

  it('writes nothing when the user presses Ctrl-C partway through', async () => {
    const cancelling: PromptSession = {
      interactive: true,
      async text() {
        throw new RelayError('Cancelled.', { code: 'PROMPT_CANCELLED' });
      },
      async confirm() {
        throw new RelayError('Cancelled.', { code: 'PROMPT_CANCELLED' });
      },
      async choice() {
        throw new RelayError('Cancelled.', { code: 'PROMPT_CANCELLED' });
      },
      async select() {
        throw new RelayError('Cancelled.', { code: 'PROMPT_CANCELLED' });
      },
      close() {},
    };

    const originalCwd = process.cwd();
    const originalWrite = process.stdout.write.bind(process.stdout);
    let output = '';
    process.chdir(repo.root);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stdout.write;

    let exitCode: number;
    try {
      exitCode = await runInit({}, { prompter: cancelling, checkAgents: stubAgents(true) });
    } finally {
      process.stdout.write = originalWrite;
      process.chdir(originalCwd);
    }

    assert.equal(exitCode, 130);
    assert.match(output, /Setup cancelled\. Nothing was written\./);
    await assert.rejects(readFile(configPath(repo.root), 'utf8'), 'no config should exist');
  });

  it('writes the config and the gitignore entry it reports', async () => {
    await runFlow(ALL_DEFAULTS);

    const written = JSON.parse(await readFile(configPath(repo.root), 'utf8')) as RelayConfig;
    assert.equal(written.version, 1);
    assert.ok((await readFile(join(repo.root, '.gitignore'), 'utf8')).includes('.relay/runs/'));
  });

  it('leaves an existing config alone without --force, even on a TTY', async () => {
    await runFlow([], { interactive: false });
    const { output, prompter } = await runFlow(ALL_DEFAULTS);

    assert.match(output, /already exists/);
    assert.deepEqual(prompter.asked, [], 'it must not start a flow it would refuse to land');
  });
});
