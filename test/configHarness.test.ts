import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConfigHarness,
  configHarnessRegistrations,
  parseHarnessesConfig,
  type HarnessConfig,
} from '../src/agents/configHarness.ts';
import { AGENT_PROVIDERS, AGENT_REGISTRY } from '../src/agents/index.ts';
import { agentChecks, type AgentCheck } from '../src/cli/checks.ts';
import { runInit, type InitDeps } from '../src/cli/commands/init.ts';
import { applyOverrides } from '../src/cli/commands/run.ts';
import { createCliContext } from '../src/cli/context.ts';
import { setTheme } from '../src/cli/output.ts';
import {
  DEFAULT_CONFIG,
  ROLES,
  assertReviewRolesEnforceable,
  configHarnesses,
  loadConfig,
  mergeConfig,
  writeConfig,
} from '../src/storage/config.ts';
import { RelayError } from '../src/util/errors.ts';
import { ScriptedPrompter } from './helpers/scriptedPrompter.ts';
import { createTempRepo, type TempRepo } from './helpers/tempRepo.ts';

const RESERVED = [...AGENT_PROVIDERS, ...ROLES];

/** The issue's own example, verbatim in shape. */
const MYTOOL: Record<string, unknown> = {
  command: 'mytool',
  args: ['run', '--json'],
  promptOn: 'stdin',
  stream: 'jsonl',
  map: { text: '$.message', usage: '$.usage', sessionId: '$.session' },
  resume: ['--session', '{sessionId}'],
  readOnly: ['--sandbox', 'read-only'],
};

/** The same harness minus the one thing review roles need. */
const MYTOOL_NO_READONLY: Record<string, unknown> = (() => {
  const { readOnly: _dropped, ...rest } = MYTOOL;
  return rest;
})();

describe('config harness schema validation', () => {
  it('accepts the schema from the issue', () => {
    const parsed = parseHarnessesConfig({ mytool: MYTOOL }, RESERVED);
    const def = parsed['mytool'];
    assert.ok(def);
    assert.equal(def.command, 'mytool');
    assert.deepEqual(def.args, ['run', '--json']);
    assert.equal(def.promptOn, 'stdin');
    assert.equal(def.stream, 'jsonl');
    assert.equal(def.map.text, '$.message');
    assert.deepEqual(def.resume, ['--session', '{sessionId}']);
    assert.deepEqual(def.readOnly, ['--sandbox', 'read-only']);
  });

  it('refuses names that collide with shipped agents or roles', () => {
    for (const name of ['claude', 'codex', 'planner']) {
      assert.throws(() => parseHarnessesConfig({ [name]: MYTOOL }, RESERVED), /reserved/);
    }
  });

  it('refuses malformed names', () => {
    assert.throws(() => parseHarnessesConfig({ 'My Tool': MYTOOL }, RESERVED), /not a valid harness name/);
    assert.throws(() => parseHarnessesConfig({ '9tool': MYTOOL }, RESERVED), /not a valid harness name/);
  });

  it('refuses unknown keys instead of silently dropping them, including the readonly typo', () => {
    assert.throws(
      () => parseHarnessesConfig({ mytool: { ...MYTOOL_NO_READONLY, readonly: ['--ro'] } }, RESERVED),
      /unknown key "readonly"/,
    );
  });

  it('refuses everything but stdin prompts and jsonl streams', () => {
    assert.throws(() => parseHarnessesConfig({ mytool: { ...MYTOOL, promptOn: 'argv' } }, RESERVED), /stdin/);
    assert.throws(() => parseHarnessesConfig({ mytool: { ...MYTOOL, stream: 'text' } }, RESERVED), /jsonl/);
  });

  it('refuses substitution anywhere but resume', () => {
    assert.throws(
      () => parseHarnessesConfig({ mytool: { ...MYTOOL, args: ['run', '{sessionId}'] } }, RESERVED),
      /substitution only happens in "resume"/,
    );
  });

  it('requires resume to carry {sessionId} and map.sessionId to supply it', () => {
    assert.throws(
      () => parseHarnessesConfig({ mytool: { ...MYTOOL, resume: ['--continue'] } }, RESERVED),
      /\{sessionId\}/,
    );
    const map = { text: '$.message' };
    assert.throws(() => parseHarnessesConfig({ mytool: { ...MYTOOL, map } }, RESERVED), /map\.sessionId/);
  });

  it('refuses bad field paths and unknown map keys', () => {
    assert.throws(
      () => parseHarnessesConfig({ mytool: { ...MYTOOL, map: { text: 'message' } } }, RESERVED),
      /"\$\.field" path/,
    );
    assert.throws(
      () => parseHarnessesConfig({ mytool: { ...MYTOOL, map: { text: '$.message', extra: '$.x' } } }, RESERVED),
      /unknown key "extra"/,
    );
  });

  it('requires a command and well-formed flag lists', () => {
    assert.throws(() => parseHarnessesConfig({ mytool: { ...MYTOOL, command: '' } }, RESERVED), /command/);
    assert.throws(() => parseHarnessesConfig({ mytool: { ...MYTOOL, readOnly: [] } }, RESERVED), /readOnly/);
    assert.throws(() => parseHarnessesConfig({ mytool: { ...MYTOOL, readOnly: [42] } }, RESERVED), /readOnly/);
  });
});

describe('config harnesses in .relay/config.json', () => {
  it('makes the harness assignable to implementation roles', () => {
    const config = mergeConfig(DEFAULT_CONFIG, {
      harnesses: { mytool: MYTOOL_NO_READONLY },
      agents: { implementer: 'mytool' },
    });
    assert.equal(config.agents.implementer, 'mytool');
    assert.ok(configHarnesses(config)['mytool']);
  });

  it('refuses a harness without readOnly for planReviewer and codeReviewer, with a clear message', () => {
    for (const role of ['planReviewer', 'codeReviewer'] as const) {
      assert.throws(
        () =>
          mergeConfig(DEFAULT_CONFIG, {
            harnesses: { mytool: MYTOOL_NO_READONLY },
            agents: { [role]: 'mytool' },
          }),
        (error: unknown) => {
          assert.ok(error instanceof RelayError);
          assert.match(error.message, /readOnly/);
          assert.match(error.message, new RegExp(role));
          assert.match(error.message, /mytool/);
          return true;
        },
      );
    }
  });

  it('accepts a harness with readOnly for review roles', () => {
    const config = mergeConfig(DEFAULT_CONFIG, {
      harnesses: { mytool: MYTOOL },
      agents: { codeReviewer: 'mytool' },
    });
    assert.equal(config.agents.codeReviewer, 'mytool');
    assert.doesNotThrow(() => assertReviewRolesEnforceable(config));
  });

  it('still refuses agents nobody registered or defined', () => {
    assert.throws(
      () => mergeConfig(DEFAULT_CONFIG, { harnesses: { mytool: MYTOOL }, agents: { planner: 'othertool' } }),
      /Unknown agent "othertool".*mytool/s,
    );
  });

  it('refuses a model for a config harness, whose schema has no model flag', () => {
    assert.throws(
      () => mergeConfig(DEFAULT_CONFIG, { harnesses: { mytool: MYTOOL }, models: { mytool: 'fancy' } }),
      /no model flag/,
    );
  });
});

describe('config harness runtime edges', () => {
  const def = parseHarnessesConfig({ mytool: MYTOOL_NO_READONLY }, RESERVED)['mytool'] as HarnessConfig;

  it('refuses resume without a resume template as a failed session, not a throw', async () => {
    const { resume: _dropped, ...rest } = def;
    const harness = new ConfigHarness('mytool', { ...rest });
    const scratch = await mkdtemp(join(tmpdir(), 'relay-harness-'));
    try {
      const session = await harness.resume('sess-1', 'go on', {
        cwd: scratch,
        role: 'implementer',
        capability: 'write',
      });
      assert.equal(session.ok, false);
      assert.match(session.error ?? '', /resume/);
      assert.ok(session.events.some((event) => event.type === 'failed'));
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it('reports a missing command through checkAvailability, with an install hint', async () => {
    const harness = new ConfigHarness('mytool', { ...def, command: 'definitely-not-installed-anywhere' });
    const result = await harness.checkAvailability();
    assert.equal(result.available, false);
    assert.equal(result.detail, 'not found');
    assert.match(result.hint ?? '', /mytool/);
  });
});

describe('config harnesses across the CLI surface', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ withPackageJson: true });
    setTheme({ color: false, unicode: true, interactive: false });
  });

  afterEach(async () => {
    setTheme(undefined);
    await repo.cleanup();
  });

  /** Availability rows the way `agentChecks` reports them, without probing real CLIs. */
  const stubChecks: InitDeps['checkAgents'] = async (config) => {
    const shipped: AgentCheck[] = AGENT_REGISTRY.map((entry) => ({
      entry,
      check: { label: entry.label, status: 'ok' as const, detail: `${entry.name} 1.0.0` },
    }));
    const configured: AgentCheck[] = configHarnessRegistrations(configHarnesses(config)).map((entry) => ({
      entry,
      check: { label: entry.label, status: 'ok' as const, detail: '/usr/local/bin/mytool' },
    }));
    return [...shipped, ...configured];
  };

  async function writeHarnessConfig(): Promise<void> {
    const config = mergeConfig(DEFAULT_CONFIG, {
      harnesses: { mytool: MYTOOL },
      agents: { implementer: 'mytool' },
    });
    await writeConfig(repo.root, config);
  }

  it('registers the harness for doctor and init, with read-only capability recorded', () => {
    const registrations = configHarnessRegistrations(
      parseHarnessesConfig({ mytool: MYTOOL, other: MYTOOL_NO_READONLY }, RESERVED),
    );
    assert.deepEqual(registrations.map((entry) => entry.name), ['mytool', 'other']);
    assert.equal(registrations[0]?.label, 'mytool (config)');
    assert.equal(registrations[0]?.enforcesReadOnly, true);
    assert.equal(registrations[1]?.enforcesReadOnly, false);
    assert.equal(registrations[0]?.create({}).name, 'mytool');
  });

  it('doctor-style agent checks include the config harness after the shipped rows', async () => {
    const registrations = configHarnessRegistrations(parseHarnessesConfig({ mytool: MYTOOL }, RESERVED));
    const checks = await agentChecks(registrations);
    assert.equal(checks.length, AGENT_REGISTRY.length + 1);
    const last = checks.at(-1);
    assert.equal(last?.entry.name, 'mytool');
    assert.equal(last?.check.label, 'mytool (config)');
    // `mytool` is not on PATH here, which is exactly what doctor should say.
    assert.equal(last?.check.status, 'fail');
    assert.equal(last?.check.detail, 'not found');
  });

  it('relay init --json reports the config harness among the agents', async () => {
    await writeHarnessConfig();

    const originalCwd = process.cwd();
    const originalWrite = process.stdout.write.bind(process.stdout);
    let output = '';
    process.chdir(repo.root);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stdout.write;

    try {
      const deps: InitDeps = { prompter: new ScriptedPrompter([], false), checkAgents: stubChecks };
      const exitCode = await runInit({ json: true }, deps);
      assert.equal(exitCode, 0);
    } finally {
      process.stdout.write = originalWrite;
      process.chdir(originalCwd);
    }

    const document = JSON.parse(output) as { agents: Array<{ name: string; label: string; available: boolean }> };
    const mytool = document.agents.find((agent) => agent.name === 'mytool');
    assert.ok(mytool, 'relay init --json must list the config-defined harness');
    assert.equal(mytool.label, 'mytool (config)');
  });

  it('createCliContext builds a live harness for roles to run on', async () => {
    await writeHarnessConfig();
    const originalCwd = process.cwd();
    process.chdir(repo.root);
    try {
      const context = await createCliContext(repo.root);
      assert.equal(context.config.agents.implementer, 'mytool');
      assert.equal(context.harnesses['mytool']?.name, 'mytool');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('run flags accept the config harness but never hand a review seat to one without readOnly', async () => {
    const config = mergeConfig(DEFAULT_CONFIG, { harnesses: { mytool: MYTOOL_NO_READONLY } });

    const merged = applyOverrides(config, { implementer: 'mytool' }, { announce: false });
    assert.equal(merged.agents.implementer, 'mytool');
    // The usual pairing would make it the plan reviewer; the guarantee wins.
    assert.equal(merged.agents.planReviewer, config.agents.planReviewer);

    assert.throws(() => applyOverrides(config, { planner: 'nosuch' }, { announce: false }), /--planner/);

    const enforced = mergeConfig(DEFAULT_CONFIG, { harnesses: { mytool: MYTOOL } });
    const paired = applyOverrides(enforced, { implementer: 'mytool' }, { announce: false });
    assert.equal(paired.agents.planReviewer, 'mytool');
  });

  it('round-trips through write and load', async () => {
    await writeHarnessConfig();
    const loaded = await loadConfig(repo.root);
    assert.deepEqual(configHarnesses(loaded)['mytool']?.readOnly, ['--sandbox', 'read-only']);
    assert.equal(loaded.agents.implementer, 'mytool');
  });
});
