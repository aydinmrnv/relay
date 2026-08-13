import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AGENT_REGISTRY } from '../src/agents/index.ts';
import { describeCommand, type AuthState, type AuthSupport } from '../src/auth/delegated.ts';
import type { AgentCheck } from '../src/cli/checks.ts';
import { runStart, type StartDeps, type StartOptions } from '../src/cli/commands/start.ts';
import { loadOnboarding, onboardingPath } from '../src/cli/onboarding.ts';
import { setTheme } from '../src/cli/output.ts';
import { DEFAULT_CONFIG, writeConfig } from '../src/storage/config.ts';
import type { Theme } from '../src/ui/theme.ts';
import { ScriptedPrompter } from './helpers/scriptedPrompter.ts';
import { createTempRepo, type TempRepo } from './helpers/tempRepo.ts';

let repo: TempRepo;

const PIPED: Theme = { color: false, unicode: true, interactive: false };

beforeEach(async () => {
  repo = await createTempRepo({ withPackageJson: true });
  setTheme(PIPED);
});

afterEach(async () => {
  setTheme(undefined);
  await repo.cleanup();
});

interface WorldOptions {
  interactive?: boolean;
  /** Which CLIs are installed, by registry name. Defaults to all of them. */
  installed?: readonly string[];
  /** Sign-in state per binary, e.g. `{ codex: 'unauthenticated' }`. */
  auth?: Record<string, AuthState>;
  /** Sign-in state each binary reports once its login command has been run. */
  afterLogin?: Record<string, AuthState>;
  ghAvailable?: boolean;
  initExitCode?: number;
  runExitCode?: number;
}

/**
 * The world `start` runs against: which CLIs exist, which are signed in, and
 * what happens when a login is delegated. Every one of those is a process
 * Relay would otherwise spawn, so none of them are real here.
 */
class World {
  readonly logins: string[] = [];
  readonly initCalls: unknown[] = [];
  readonly runs: Array<{ ref: string }> = [];
  readonly prompter: ScriptedPrompter;
  output = '';

  private readonly options: WorldOptions;
  private readonly loggedIn = new Set<string>();

  constructor(answers: readonly string[], options: WorldOptions = {}) {
    this.options = options;
    this.prompter = new ScriptedPrompter(answers, options.interactive ?? true);
  }

  private installedNames(): readonly string[] {
    return this.options.installed ?? [...AGENT_REGISTRY.map((entry) => entry.name), 'gh'];
  }

  private stateOf(binary: string): AuthState {
    if (this.loggedIn.has(binary)) return this.options.afterLogin?.[binary] ?? 'authenticated';
    return this.options.auth?.[binary] ?? 'authenticated';
  }

  deps(): StartDeps {
    return {
      prompter: this.prompter,
      checkAgents: async (): Promise<AgentCheck[]> =>
        AGENT_REGISTRY.map((entry) => ({
          entry,
          check: this.installedNames().includes(entry.name)
            ? { label: entry.label, status: 'ok' as const, detail: `${entry.name} 1.0.0` }
            : { label: entry.label, status: 'fail' as const, detail: 'not found' },
        })),
      authState: async (support: AuthSupport) => this.stateOf(support.login.command),
      login: async (support: AuthSupport) => {
        this.logins.push(describeCommand(support.login));
        this.loggedIn.add(support.login.command);
        return true;
      },
      installed: async (binary: string) => this.installedNames().includes(binary),
      providerCheck: async (registration) => {
        if (this.options.ghAvailable === false) return { available: false, detail: 'not authenticated' };
        const state = this.stateOf(registration.auth.login.command);
        return state === 'authenticated'
          ? { available: true, detail: 'authenticated as octocat' }
          : { available: false, detail: 'not authenticated' };
      },
      init: async (options) => {
        this.initCalls.push(options);
        await writeConfig(repo.root, structuredClone(DEFAULT_CONFIG));
        return this.options.initExitCode ?? 0;
      },
      run: async (ref) => {
        this.runs.push({ ref });
        return this.options.runExitCode ?? 0;
      },
      now: () => new Date('2026-08-12T09:00:00Z'),
    };
  }
}

interface Session {
  output: string;
  exitCode: number;
  world: World;
}

/** Runs the flow from inside the temp repo, capturing everything it printed. */
async function start(
  answers: readonly string[] = [],
  options: StartOptions = {},
  world: WorldOptions = {},
): Promise<Session> {
  const scenario = new World(answers, world);
  const originalCwd = process.cwd();
  const originalWrite = process.stdout.write.bind(process.stdout);
  let output = '';

  process.chdir(repo.root);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;

  try {
    const exitCode = await runStart(options, scenario.deps());
    scenario.output = output;
    return { output, exitCode, world: scenario };
  } finally {
    process.stdout.write = originalWrite;
    process.chdir(originalCwd);
  }
}

/** Onboarding is finished for a repo that has already been through the flow. */
async function alreadyOnboarded(): Promise<void> {
  await writeConfig(repo.root, structuredClone(DEFAULT_CONFIG));
  const { saveOnboarding } = await import('../src/cli/onboarding.ts');
  await saveOnboarding(repo.root, { version: 1, tourShownAt: '2026-08-01T00:00:00Z' });
}

describe('relay start — the credential guarantee', () => {
  it('never asks for a token, a key or a password anywhere in the flow', async () => {
    const { world } = await start(['y', 'y', 'y'], {}, { auth: { claude: 'unauthenticated', gh: 'unauthenticated' } });

    for (const question of world.prompter.asked) {
      assert.doesNotMatch(question, /token|api key|secret|password|credential/i, `asked for a credential: ${question}`);
    }
  });

  it('drives each vendor\'s own login command and nothing else', async () => {
    const { world } = await start(
      ['y', 'y', 'y'],
      {},
      { auth: { claude: 'unauthenticated', codex: 'unauthenticated', gh: 'unauthenticated' } },
    );

    // Exactly the commands the registries declare — never a Relay-owned flow.
    assert.deepEqual(world.logins, ['claude auth login', 'codex login', 'gh auth login']);
  });

  it('writes no credential into config or onboarding state', async () => {
    await start(['y', 'y', ''], {}, { auth: { claude: 'unauthenticated' } });

    const onboarding = JSON.parse(await readFile(onboardingPath(repo.root), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(onboarding).sort(), ['tourShownAt', 'version']);

    const config = await readFile(join(repo.root, '.relay', 'config.json'), 'utf8');
    assert.doesNotMatch(config, /token|apiKey|api_key|secret/i);
  });
});

describe('relay start — non-interactive', () => {
  it('reports instead of prompting, and exits non-zero when something is missing', async () => {
    const { output, exitCode, world } = await start([], {}, { interactive: false, installed: ['claude'] });

    assert.equal(exitCode, 1);
    assert.deepEqual(world.prompter.asked, [], 'a non-TTY run must not ask a single question');
    assert.deepEqual(world.logins, [], 'a non-TTY run must not attempt a login');
    assert.match(output, /Not a terminal/);
    assert.match(output, /Codex/);
    assert.match(output, /npm install -g @openai\/codex/);
    assert.match(output, /no \.relay\/config\.json/);
  });

  it('passes once every dependency is satisfied and the repo is configured', async () => {
    await alreadyOnboarded();
    const { output, exitCode } = await start([], {}, { interactive: false });

    assert.equal(exitCode, 0);
    assert.match(output, /Ready\./);
  });

  it('treats a signed-out CLI as a failure and names the command that fixes it', async () => {
    await alreadyOnboarded();
    const { output, exitCode } = await start([], {}, { interactive: false, auth: { codex: 'unauthenticated' } });

    assert.equal(exitCode, 1);
    assert.match(output, /Codex sign-in\s+not signed in/);
    assert.match(output, /Run `codex login`\./);
  });

  it('reports an unknown sign-in state as a warning, not a failure', async () => {
    await alreadyOnboarded();
    const { output, exitCode } = await start([], {}, { interactive: false, auth: { claude: 'unknown' } });

    assert.equal(exitCode, 0);
    assert.match(output, /sign-in state unknown/);
  });

  it('behaves the same on a TTY when --check is passed', async () => {
    await alreadyOnboarded();
    const { output, exitCode, world } = await start([], { check: true }, { auth: { codex: 'unauthenticated' } });

    assert.equal(exitCode, 1);
    assert.deepEqual(world.logins, []);
    assert.deepEqual(world.prompter.asked, []);
    assert.match(output, /Reporting only/);
  });
});

describe('relay start — guided flow', () => {
  it('walks every step and reaches a config without the user reading the README', async () => {
    const { output, exitCode, world } = await start([]);

    assert.equal(exitCode, 0);
    for (const step of [
      /1\. Repository/,
      /2\. Coding agents/,
      /3\. Issues/,
      /4\. Configuration/,
      /5\. How a run works/,
      /6\. First run/,
    ]) {
      assert.match(output, step);
    }
    assert.equal(world.initCalls.length, 1, 'configuration is delegated to `relay init`, not reimplemented');
  });

  it('offers the vendor login for a CLI that is installed but signed out', async () => {
    const { output, world } = await start(['y'], {}, { auth: { codex: 'unauthenticated' } });

    assert.match(output, /Codex.*not signed in/);
    assert.ok(world.prompter.asked.some((question) => question.includes('Run `codex login` now?')));
    assert.deepEqual(world.logins, ['codex login']);
    assert.match(output, /Codex is signed in\./);
  });

  it('re-asks the vendor after a login and reports when it still has no session', async () => {
    const { output } = await start(
      ['y'],
      {},
      { auth: { codex: 'unauthenticated' }, afterLogin: { codex: 'unauthenticated' } },
    );

    assert.match(output, /Codex still reports no session/);
  });

  it('skips the login when the user declines, and says what to run instead', async () => {
    const { output, world } = await start(['n'], {}, { auth: { codex: 'unauthenticated' } });

    assert.deepEqual(world.logins, []);
    assert.match(output, /Run `codex login` yourself/);
  });

  it('prints the install command for a missing CLI rather than trying to fix it', async () => {
    const { output, world } = await start([], {}, { installed: ['claude', 'gh'] });

    assert.match(output, /npm install -g @openai\/codex/);
    assert.deepEqual(world.logins, []);
    assert.match(output, /Codex is not installed\./);
  });

  it('does not offer a real first run while a dependency is still missing', async () => {
    const { output, exitCode, world } = await start([], {}, { installed: ['claude', 'gh'] });

    assert.equal(exitCode, 1);
    assert.equal(world.runs.length, 0);
    assert.match(output, /Fix those, then run `relay start` again/);
  });

  it('drives `gh auth login` when GitHub is installed but unauthenticated', async () => {
    const { output, world } = await start(['y'], {}, { auth: { gh: 'unauthenticated' } });

    assert.deepEqual(world.logins, ['gh auth login']);
    assert.match(output, /GitHub\s+authenticated as octocat/);
  });

  it('stops when configuration does not complete, and says how to finish it', async () => {
    const { output, exitCode, world } = await start([], {}, { initExitCode: 130 });

    assert.equal(exitCode, 130);
    assert.match(output, /Configuration did not finish/);
    assert.match(output, /Run `relay init` on its own/);
    assert.equal(world.runs.length, 0);
  });
});

describe('relay start — idempotence', () => {
  it('skips configuration and the tour on a second run', async () => {
    const first = await start([]);
    assert.equal(first.world.initCalls.length, 1);
    assert.match(first.output, /Four agent turns/);

    const second = await start([]);
    assert.equal(second.world.initCalls.length, 0, 'an existing config is never rewritten');
    assert.match(second.output, /already configured/);
    assert.match(second.output, /relay start --tour/);
    assert.ok(!second.output.includes('Four agent turns'), 'the tour is shown once');
  });

  it('remembers the tour but not anything else about the user', async () => {
    await start([]);

    const state = await loadOnboarding(repo.root);
    assert.equal(state.tourShownAt, '2026-08-12T09:00:00.000Z');
    assert.equal(state.version, 1);
  });

  it('keeps its own state out of git', async () => {
    await start([], { tour: true });

    const gitignore = await readFile(join(repo.root, '.gitignore'), 'utf8');
    assert.ok(gitignore.includes('.relay/onboarding.json'), gitignore);
  });

  it('replays the tour on demand without touching anything else', async () => {
    await alreadyOnboarded();
    const { output, exitCode, world } = await start([], { tour: true });

    assert.equal(exitCode, 0);
    assert.match(output, /Four agent turns/);
    assert.deepEqual(world.prompter.asked, []);
    assert.equal(world.initCalls.length, 0);
  });
});

describe('relay start — the tour', () => {
  it('names the four phases, who runs each, and the round limits', async () => {
    const { output } = await start([]);

    assert.match(output, /1\. Plan\s+claude/);
    assert.match(output, /2\. Plan review\s+codex/);
    assert.match(output, /3\. Implement\s+codex/);
    assert.match(output, /4\. Code review\s+claude/);
    assert.match(output, /up to 2 round\(s\)/);
    assert.match(output, /up to 2 round\(s\)/);
  });

  it('says why the reviewer is a different model than the author', async () => {
    const { output } = await start([]);
    assert.match(output, /a plan checked only by its own author is a plan nobody checked/);
  });

  it('says where the artifacts land and which are worth reading', async () => {
    const { output } = await start([]);

    assert.match(output, /\.relay\/runs\/<run-id>\//);
    assert.match(output, /plan\.md\s+the approved plan/);
    assert.match(output, /summary\.md\s+what happened/);
    assert.match(output, /events\.jsonl/);
  });

  it('is honest about time, tokens and what Relay will never do', async () => {
    const { output } = await start([]);

    assert.match(output, /8–15 minutes/);
    assert.match(output, /--fast/);
    assert.match(output, /billed to your own Claude Code and Codex accounts/);
    assert.match(output, /never read, never prompted for, never stored/);
    // Delivery is part of the tour because it is part of the run: the tour says
    // how far this repository's policy goes, what it will ask about the rest,
    // and that a finished run leaves you back on the home screen.
    assert.match(output, /commit to the run branch — the run does that much itself/);
    assert.match(output, /no merge unless you set one/);
    assert.match(output, /relay deliver <run>/);
    assert.match(output, /the pull request, then the merge — once each, and Enter is no/);
    assert.match(output, /back to the Relay home screen, waiting for the next issue/);
  });
});

describe('relay start — the first run', () => {
  it('does not start a run unless the user asks for one', async () => {
    const { world } = await start([]);

    assert.equal(world.runs.length, 0, 'pressing Enter must never spend tokens');
    assert.ok(world.prompter.asked.some((question) => question.includes('Start a run against a real issue now?')));
  });

  it('hands the issue reference to `relay run` when the user opts in', async () => {
    await alreadyOnboarded();
    const { exitCode, world } = await start(['y', '142']);

    assert.equal(exitCode, 0);
    assert.deepEqual(world.runs, [{ ref: '142' }]);
  });

  it('starts nothing when no issue is given', async () => {
    await alreadyOnboarded();
    const { output, world } = await start(['y', '']);

    assert.equal(world.runs.length, 0);
    assert.match(output, /No issue given/);
  });

  it('walks the whole pipeline with --dry-run and calls no agent', async () => {
    await alreadyOnboarded();
    const { output, exitCode, world } = await start(['y', '142'], { dryRun: true });

    assert.equal(exitCode, 0);
    assert.equal(world.runs.length, 0, 'a dry run must not start a real run');
    assert.match(output, /no agent is called, no process is spawned, nothing is spent/);
    assert.match(output, /Fetch issue/);
    assert.match(output, /Plan\s+claude\s+read-only/);
    assert.match(output, /Implement\s+codex\s+write/);
    assert.match(output, /relay run 142/);
  });

  it('offers the dry run even when a dependency is still missing', async () => {
    await alreadyOnboarded();
    const { output, exitCode, world } = await start(['y', '142'], { dryRun: true }, { installed: ['claude', 'gh'] });

    assert.equal(exitCode, 0);
    assert.match(output, /A dry run needs none of them/);
    assert.match(output, /Dry run/);
    assert.equal(world.runs.length, 0);
  });
});
