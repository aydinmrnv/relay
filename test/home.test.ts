import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { showHome, chooseNextCommand, type HomeScreen, type RunHomeView } from '../src/cli/commands/home.ts';
import { Help } from 'commander';

import { buildProgram, defaultHelp } from '../src/cli/program.ts';
import { setTheme } from '../src/cli/output.ts';
import { DEFAULT_CONFIG, writeConfig } from '../src/storage/config.ts';
import { RunStore } from '../src/storage/runs.ts';
import { createRunId } from '../src/util/ids.ts';
import { createRunState, transition, type RunState } from '../src/workflow/state.ts';
import { createTempRepo, type TempRepo } from './helpers/tempRepo.ts';

const interactive = { color: false, unicode: true, interactive: true } as const;
let repo: TempRepo;
let originalCwd: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  repo = await createTempRepo();
  setTheme(interactive);
});

afterEach(async () => {
  process.chdir(originalCwd);
  setTheme(undefined);
  await repo.cleanup();
});

async function captureStdout(action: () => Promise<HomeScreen>): Promise<{ screen: HomeScreen; output: string }> {
  let output = '';
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    return { screen: await action(), output };
  } finally {
    process.stdout.write = original;
  }
}

function state(phase: RunState['phase'] = 'INITIALIZING'): RunState {
  const created = new Date('2026-08-12T10:00:00Z');
  const value = createRunState({
    runId: createRunId(created),
    shortId: 'abc123',
    issueRef: '18',
    repository: { root: repo.root, owner: null, name: null, defaultBranch: 'main' },
    config: structuredClone(DEFAULT_CONFIG),
    now: created,
  });
  if (phase === 'COMPLETE') {
    value.workspace = {
      path: repo.root,
      branch: 'main',
      baseSha: value.repository.root,
      baseRef: 'refs/heads/main',
      baseBranch: 'main',
    };
    transition(value, 'FETCHING_ISSUE');
    transition(value, 'CREATING_WORKSPACE');
    transition(value, 'IMPLEMENTING');
    transition(value, 'REVIEWING_CODE');
    transition(value, 'TESTING');
    transition(value, 'DELIVERING');
    transition(value, 'COMPLETE');
  }
  return value;
}

describe('home screen', { concurrency: 1 }, () => {
  it('shows configured state, run facts, and exactly one next command in one panel', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.tests.command = ['npm', 'test'];
    await writeConfig(repo.root, config);
    const run = state();
    run.updatedAt = '2026-08-12T10:00:05Z';
    run.diff = { fileCount: 2, additions: 7, deletions: 2, files: [], patchFile: 'patch', at: run.updatedAt };
    await new RunStore(repo.root, run.runId).saveState(run);
    process.chdir(repo.root);

    const result = await captureStdout(showHome);
    // A configured repository is one the next issue can start from.
    assert.equal(result.screen.ready, true);
    for (const text of ['Planner', 'Plan reviewer', 'Implementer', 'Code reviewer', 'Delivery', 'npm test', 'Initializing', '+7 −2']) {
      assert.match(result.output, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.equal((result.output.match(/Next  relay watch/g) ?? []).length, 1);
    assert.equal((result.output.match(/╭─/g) ?? []).length, 1);
  });

  it('offers start in an unconfigured repository', async () => {
    process.chdir(repo.root);
    const result = await captureStdout(showHome);
    // Nothing to run yet, so nothing asks for an issue on top of `relay start`.
    assert.equal(result.screen.ready, false);
    assert.match(result.output, /not configured/);
    assert.match(result.output, /Next  relay start/);
  });

  it('does not treat a malformed present config as absent', async () => {
    await repo.writeFile('.relay/config.json', '{ broken');
    process.chdir(repo.root);
    await assert.rejects(showHome, /config\.json/);
  });

  it('marks completed work that has not been landed', async () => {
    await writeConfig(repo.root, structuredClone(DEFAULT_CONFIG));
    const run = state('COMPLETE');
    run.workspace!.baseSha = await repo.git('rev-parse', 'HEAD');
    run.diff = { fileCount: 1, additions: 1, deletions: 0, files: ['src/app.ts'], patchFile: 'patch', at: run.updatedAt };
    await new RunStore(repo.root, run.runId).saveState(run);
    process.chdir(repo.root);

    const result = await captureStdout(showHome);
    assert.match(result.output, /unlanded/);
    assert.match(result.output, new RegExp(`Next  relay deliver ${run.runId}`));
  });

  it('prints the introduction and start outside a repository', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'relay-home-outside-'));
    process.chdir(outside);
    try {
      const result = await captureStdout(showHome);
      assert.equal(result.screen.ready, false);
      assert.match(result.output, /Relay coordinates/);
      assert.match(result.output, /relay start/);
    } finally {
      process.chdir(originalCwd);
      await rm(outside, { recursive: true, force: true });
    }
  });
});

it('chooses the next command by the documented precedence', () => {
  const live = state();
  const finished = { ...live, phase: 'COMPLETE' as const };
  const view = (value: RunState, unlanded = false): RunHomeView => ({ state: value, unlanded });
  assert.equal(chooseNextCommand(false, [view(live)]), 'relay start');
  assert.equal(chooseNextCommand(true, [view(live)]), `relay watch ${live.runId}`);
  assert.equal(chooseNextCommand(true, [view(finished, true)]), `relay deliver ${finished.runId}`);
  assert.equal(chooseNextCommand(true, [view(finished)]), 'relay run <issue>');
});

it('uses package.json for version and groups explicit root help', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  const program = buildProgram(manifest.version);
  assert.equal(program.version(), manifest.version);
  const help = program.helpInformation();
  for (const heading of ['Setup:', 'Run:', 'Inspect:', 'Deliver:']) assert.match(help, new RegExp(heading));
});

it('gives the run flags people type most a short form', () => {
  const program = buildProgram('test');
  const run = program.commands.find((command) => command.name() === 'run');
  const parsed = run?.parseOptions(['-f', '-m', '--tuff']);
  const options = run?.opts() ?? {};

  assert.deepEqual(parsed?.unknown, [], '-f, -m and --tuff must all be real options on `relay run`');
  assert.equal(options['fast'], true);
  assert.equal(options['merge'], true);
  assert.equal(options['tuff'], true);
});

it('renders bare non-interactive help byte-for-byte like Commander error help at the stderr width', () => {
  const program = buildProgram('test');
  const width = 117;
  const commander = new Help();
  commander.helpWidth = width;
  const expected = commander.formatHelp(program, commander);

  assert.equal(defaultHelp(program, width), expected);
  assert.notEqual(defaultHelp(program, width), defaultHelp(program, 80));
});
