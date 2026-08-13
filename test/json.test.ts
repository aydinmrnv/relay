import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CommanderError } from 'commander';

import { EXIT, exitCodeFor, exitCodeForRun } from '../src/cli/exit.ts';
import { enterJsonMode, exitJsonMode, SCHEMA_VERSION } from '../src/cli/json.ts';
import { restoreHumanOutput, setTheme } from '../src/cli/output.ts';
import { buildProgram } from '../src/cli/program.ts';
import { checksToJson } from '../src/cli/doctorJson.ts';
import { homeCommand } from '../src/cli/commands/home.ts';
import { diffCommand, logsCommand, planCommand, statusCommand, stopCommand } from '../src/cli/commands/inspect.ts';
import { statsCommand } from '../src/cli/commands/stats.ts';
import { RunJsonStream, type RunStreamLine } from '../src/cli/runStream.ts';
import { relaySession, type SessionDeps } from '../src/cli/session.ts';
import { RunStore, RUN_FILES } from '../src/storage/runs.ts';
import { DEFAULT_CONFIG, writeConfig } from '../src/storage/config.ts';
import { configToJson } from '../src/cli/homeJson.ts';
import { runToJson } from '../src/cli/runJson.ts';
import { RelayError } from '../src/util/errors.ts';
import { createRunId } from '../src/util/ids.ts';
import { WorkflowEngine } from '../src/workflow/engine.ts';
import { createRunState, transition, type RunState } from '../src/workflow/state.ts';
import { buildEngineContext, happyPathHarnesses, writesFile } from './helpers/engine.ts';
import { FakeAgentHarness, approveReview, section } from './helpers/fakeHarness.ts';
import { ScriptedPrompter } from './helpers/scriptedPrompter.ts';
import { createTempRepo, type TempRepo } from './helpers/tempRepo.ts';

let repo: TempRepo;
let originalCwd: string;

it('projects tracking privacy choices into config JSON', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.tracking.enabled = true;
  config.tracking.includeAgentPhases = false;
  assert.deepEqual(configToJson(config).tracking, { enabled: true, includeAgentPhases: false });
});

beforeEach(async () => {
  originalCwd = process.cwd();
  repo = await createTempRepo();
  // Every command resolves its repository from the working directory.
  process.chdir(repo.root);
  // Colour must never be what decides whether the output parses, so the theme
  // is pinned to something that would happily paint if anything asked it to.
  setTheme({ color: true, unicode: true, interactive: true });
});

afterEach(async () => {
  process.chdir(originalCwd);
  exitJsonMode();
  restoreHumanOutput();
  setTheme(undefined);
  await repo.cleanup();
});

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command in JSON mode with both streams captured separately.
 *
 * The split is the whole point: the acceptance criterion is not "the JSON is
 * correct" but "stdout carries the JSON and nothing else", and only a test that
 * watches both streams can tell those apart.
 */
async function capture(action: () => Promise<number>): Promise<Captured> {
  return captureStreams(async () => {
    enterJsonMode();
    return action();
  });
}

/** The same capture, without claiming stdout for JSON. */
async function captureStreams(action: () => Promise<number>): Promise<Captured> {
  const streams = { stdout: '', stderr: '' };
  const originals = { stdout: process.stdout.write, stderr: process.stderr.write };

  const patch = (name: 'stdout' | 'stderr'): void => {
    process[name].write = ((chunk: string | Uint8Array): boolean => {
      streams[name] += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stdout.write;
  };

  patch('stdout');
  patch('stderr');
  try {
    const code = await action();
    return { code, ...streams };
  } finally {
    process.stdout.write = originals.stdout;
    process.stderr.write = originals.stderr;
  }
}

/** Parses a single JSON document and asserts the envelope every payload carries. */
function documentOf(output: string, command: string): Record<string, unknown> {
  const parsed = JSON.parse(output) as Record<string, unknown>;
  assert.equal(parsed['schema'], SCHEMA_VERSION, 'every payload carries the schema version');
  assert.equal(parsed['command'], command);
  return parsed;
}

function runState(root: string, phase: RunState['phase'] = 'INITIALIZING'): RunState {
  const created = new Date('2026-08-13T10:00:00Z');
  const state = createRunState({
    runId: createRunId(created),
    shortId: 'jsn001',
    issueRef: '142',
    repository: { root, owner: 'acme', name: 'widgets', defaultBranch: 'main' },
    config: structuredClone(DEFAULT_CONFIG),
    now: created,
  });
  state.issue = {
    number: 142,
    title: 'Add authentication rate limiting',
    url: 'https://github.com/acme/widgets/issues/142',
    state: 'open',
  };
  state.workspace = {
    path: `${root}/.gone`,
    branch: 'relay/142-jsn001',
    baseSha: 'a'.repeat(40),
    baseRef: 'refs/heads/main',
    baseBranch: 'main',
  };
  state.diff = {
    fileCount: 1,
    additions: 3,
    deletions: 1,
    files: ['src/app.ts'],
    patchFile: 'patches/final.patch',
    at: '2026-08-13T10:05:00Z',
  };

  if (phase !== 'INITIALIZING') {
    for (const step of ['FETCHING_ISSUE', 'CREATING_WORKSPACE', 'IMPLEMENTING', 'TESTING', 'DELIVERING'] as const) {
      if (state.phase === phase) break;
      transition(state, step);
    }
    transition(state, phase);
  }
  return state;
}

async function persist(state: RunState): Promise<RunStore> {
  const store = new RunStore(repo.root, state.runId);
  await store.init();
  await store.saveState(state);
  return store;
}

describe('the JSON contract', () => {
  it('puts a --json flag on every command that reports something', () => {
    const program = buildProgram('test');
    const named = program.commands.map((command) => command.name());

    // Not an allowlist of what happens to exist — the list from the issue, so
    // a new reporting command without `--json` fails here rather than shipping.
    for (const name of ['start', 'init', 'doctor', 'run', 'resume', 'deliver', 'status', 'watch', 'diff', 'plan', 'logs', 'stats', 'stop']) {
      assert.ok(named.includes(name), `${name} should be a command`);
      const command = program.commands.find((entry) => entry.name() === name);
      const flags = command?.options.map((option) => option.long) ?? [];
      assert.ok(flags.includes('--json'), `relay ${name} must accept --json`);
    }
    // The home screen is the root command, and it reports too.
    assert.ok(program.options.map((option) => option.long).includes('--json'));
  });

  it('routes --json to the command it was typed after, not to the root', async () => {
    await persist(runState(repo.root));
    const previous = process.exitCode;

    // Straight through the real program, because this is a parsing bug, not a
    // command bug: the root declares `--json` too, and Commander resolves a
    // repeated flag against the parent unless it is told to parse positionally.
    // Without that, `relay status --json` prints the human table.
    const captured = await captureStreams(async () => {
      await buildProgram('test').parseAsync(['node', 'relay', 'status', '--json']);
      return 0;
    });
    process.exitCode = previous;

    documentOf(captured.stdout, 'status');
  });

  it('leaves the same command without the flag printing its table to stdout', async () => {
    await persist(runState(repo.root));
    const previous = process.exitCode;

    const captured = await captureStreams(async () => {
      await buildProgram('test').parseAsync(['node', 'relay', 'status']);
      return 0;
    });
    process.exitCode = previous;

    assert.match(captured.stdout, /Relay runs in/);
    assert.throws(() => JSON.parse(captured.stdout));
  });

  it('carries the schema version on the status payloads, in both shapes', async () => {
    const state = runState(repo.root);
    await persist(state);

    const list = await capture(() => statusCommand(undefined, { json: true }));
    const listed = documentOf(list.stdout, 'status');
    assert.ok(Array.isArray(listed['runs']));

    const single = await capture(() => statusCommand(state.shortId, { json: true }));
    const named = documentOf(single.stdout, 'status');
    assert.equal((named['run'] as { runId: string }).runId, state.runId);
  });

  it('carries the schema version on logs, plan, stop, diff and home', async () => {
    const state = runState(repo.root);
    const store = await persist(state);
    await store.writeArtifact(RUN_FILES.plan, '# Plan\n\nDo the thing.\n');
    await store.writeArtifact(state.diff!.patchFile, 'diff --git a/src/app.ts b/src/app.ts\n');
    await store.logEvent({
      timestamp: '2026-08-13T10:01:00Z',
      runId: state.runId,
      phase: 'PLANNING',
      agent: 'planner',
      type: 'turn_completed',
      message: 'wrote the plan',
    });
    await writeConfig(repo.root, structuredClone(DEFAULT_CONFIG));

    const logs = documentOf((await capture(() => logsCommand(state.shortId, { json: true }))).stdout, 'logs');
    assert.equal(logs['total'], 1);
    assert.equal((logs['events'] as Array<{ message: string }>)[0]?.message, 'wrote the plan');

    const plan = documentOf((await capture(() => planCommand(state.shortId, { json: true }))).stdout, 'plan');
    assert.match(plan['plan'] as string, /Do the thing/);

    const stop = documentOf((await capture(() => stopCommand(state.shortId, { json: true }))).stdout, 'stop');
    assert.equal(stop['cancelRequested'], true);

    // The worktree is gone, so this exercises the stored-patch branch.
    const diff = documentOf((await capture(() => diffCommand(state.shortId, { json: true }))).stdout, 'diff');
    assert.equal(diff['source'], 'stored');
    assert.match(diff['patch'] as string, /diff --git/);

    const home = documentOf((await capture(() => homeCommand({ json: true }))).stdout, 'home');
    assert.equal(home['configured'], true);
    assert.equal((home['runs'] as unknown[]).length, 1);
  });

  it('carries the schema version on stats, which arrived with its own --json', async () => {
    await persist(runState(repo.root, 'COMPLETE'));
    await writeConfig(repo.root, structuredClone(DEFAULT_CONFIG));

    // `relay stats` shipped a `--json` that wrote through `raw()`. That is the
    // human sink, which this contract diverts to stderr — so an unconverted
    // command prints nothing at all rather than printing the wrong thing.
    const captured = await capture(() => statsCommand({ json: true }));
    const parsed = documentOf(captured.stdout, 'stats');
    assert.equal(parsed['runs'], 1);
    assert.ok(!captured.stdout.includes('\u001B'));
  });

  it('drops the patch under --stat but keeps the files it summarizes', async () => {
    const state = runState(repo.root);
    const store = await persist(state);
    await store.writeArtifact(state.diff!.patchFile, 'diff --git a/src/app.ts b/src/app.ts\n');

    const parsed = documentOf(
      (await capture(() => diffCommand(state.shortId, { stat: true, json: true }))).stdout,
      'diff',
    );
    // `null` says "not requested"; an empty string would say "no changes".
    assert.equal(parsed['patch'], null);
    assert.deepEqual((parsed['files'] as Array<{ path: string }>).map((file) => file.path), ['src/app.ts']);
  });

  it('reports a check list without a colour code or a status glyph in sight', () => {
    const payload = checksToJson([
      { label: 'git', status: 'ok', detail: 'git version 2.43.0' },
      { label: 'Codex', status: 'fail', detail: 'not found', hint: 'npm install -g @openai/codex' },
      { label: 'Working tree', status: 'warn', detail: '2 uncommitted change(s)' },
    ]);

    assert.equal(payload.ok, false);
    assert.deepEqual(payload.counts, { ok: 1, warn: 1, fail: 1 });
    // A passing check keeps the key and nulls it, so `.hint` is always indexable.
    assert.equal(payload.checks[0]?.hint, null);
    assert.equal(payload.checks[1]?.hint, 'npm install -g @openai/codex');
    const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes('\u001B'));
    for (const glyph of ['✓', '✗', '●', '○']) assert.ok(!serialized.includes(glyph), `no ${glyph} in JSON`);
  });
});

describe('stdout carries the JSON and nothing else', () => {
  it('keeps prose, frames and advice off stdout for every reporting command', async () => {
    const state = runState(repo.root);
    const store = await persist(state);
    await store.writeArtifact(RUN_FILES.plan, '# Plan\n');
    await writeConfig(repo.root, structuredClone(DEFAULT_CONFIG));

    const invocations: Array<[string, () => Promise<number>]> = [
      ['status', () => statusCommand(undefined, { json: true })],
      ['status <run>', () => statusCommand(state.shortId, { json: true })],
      ['logs', () => logsCommand(state.shortId, { json: true })],
      ['plan', () => planCommand(state.shortId, { json: true })],
      ['stop', () => stopCommand(state.shortId, { json: true })],
      ['home', () => homeCommand({ json: true })],
    ];

    for (const [name, action] of invocations) {
      const result = await capture(action);
      assert.doesNotThrow(() => JSON.parse(result.stdout), `relay ${name} --json wrote non-JSON to stdout`);
      assert.ok(!result.stdout.includes('\u001B'), `relay ${name} --json wrote an escape sequence to stdout`);
    }
  });

  it('sends the empty-state advice to stderr rather than dropping it', async () => {
    // `relay logs` on a run with no events prints prose and two commands. Under
    // `--json` that advice is still worth having — just not on stdout.
    const state = runState(repo.root);
    await persist(state);

    const result = await capture(() => logsCommand(state.shortId, { json: true }));
    const parsed = documentOf(result.stdout, 'logs');
    assert.deepEqual(parsed['events'], []);
    assert.equal(parsed['total'], 0);
    assert.ok(!result.stdout.includes('No events recorded'));
  });

  it('leaves the human path writing to stdout, which is where a person reads it', async () => {
    const state = runState(repo.root);
    await persist(state);

    // The diversion is what `--json` does, not what Relay does. Without the
    // flag the same command still talks to a person on stdout.
    const captured = await captureStreams(() => stopCommand(state.shortId, {}));
    assert.match(captured.stdout, /Cancellation requested/);
    assert.equal(captured.stderr, '');
  });
});

describe('exit codes', () => {
  it('0 — a command that did what it was asked', async () => {
    await persist(runState(repo.root));
    assert.equal((await capture(() => statusCommand(undefined, { json: true }))).code, EXIT.success);
  });

  it('1 — a Relay error', () => {
    assert.equal(exitCodeFor(new RelayError('No run matching "zzz".', { code: 'RUN_NOT_FOUND' })), EXIT.error);
    assert.equal(exitCodeFor(new Error('something else entirely')), EXIT.error);

    // A run that broke mid-phase broke; it did not reach a verdict.
    const failed = runState(repo.root, 'IMPLEMENTING');
    failed.error = { message: 'codex exited with status 1', phase: 'IMPLEMENTING', code: 'AGENT_FAILED' };
    transition(failed, 'FAILED');
    assert.equal(exitCodeForRun(failed, 'committed'), EXIT.error);
  });

  it('2 — a usage error, from Commander rather than from Relay', async () => {
    const program = buildProgram('test');
    // `exitOverride` turns Commander's own `process.exit(1)` into a throw, which
    // is the only way a caller can tell a typo from a failure.
    const error = await program
      .parseAsync(['node', 'relay', 'diff', '--nonsense'])
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    assert.ok(error !== undefined, 'an unknown option must not be silently accepted');
    assert.equal(exitCodeFor(error), EXIT.usage);
  });

  it('2 — but not for the throw that only reports that help was printed', () => {
    // Commander unwinds through the same channel to say it printed help or a
    // version. That is a success that happens to arrive as an exception.
    assert.equal(exitCodeFor(new CommanderError(0, 'commander.helpDisplayed', '(outputHelp)')), EXIT.success);
    assert.equal(exitCodeFor(new CommanderError(0, 'commander.version', 'test')), EXIT.success);
    assert.equal(exitCodeFor(new CommanderError(1, 'commander.unknownCommand', 'nope')), EXIT.usage);
  });

  it('3 — preconditions unmet, for every failure that means "not set up"', () => {
    for (const code of [
      'NOT_A_REPOSITORY',
      'EMPTY_REPOSITORY',
      'EXECUTABLE_NOT_FOUND',
      'AGENT_UNAVAILABLE',
      'UNKNOWN_AGENT',
      'GH_NOT_INSTALLED',
      'GH_NOT_AUTHENTICATED',
    ]) {
      assert.equal(exitCodeFor(new RelayError('not ready', { code })), EXIT.preconditions, code);
    }

    // And when a run dies of one, the run reports it the same way.
    const failed = runState(repo.root, 'IMPLEMENTING');
    failed.error = { message: 'codex is not installed', phase: 'IMPLEMENTING', code: 'AGENT_UNAVAILABLE' };
    transition(failed, 'FAILED');
    assert.equal(exitCodeForRun(failed, 'unknown'), EXIT.preconditions);
  });

  it('4 — the run finished and its work is committed nowhere', () => {
    const state = runState(repo.root, 'COMPLETE');
    assert.equal(exitCodeForRun(state, 'unlanded'), EXIT.unlanded);
    assert.equal(exitCodeForRun(state, 'committed'), EXIT.success);
  });

  it('5 — the run failed on its own terms', () => {
    const testsFailed = runState(repo.root, 'COMPLETE');
    testsFailed.tests = {
      discovered: true,
      command: ['npm', 'test'],
      reason: 'package.json scripts.test',
      exitCode: 1,
      passed: false,
      durationMs: 1200,
      timedOut: false,
      at: '2026-08-13T10:07:00Z',
    };
    assert.equal(exitCodeForRun(testsFailed, 'committed'), EXIT.checksFailed);

    const unresolved = runState(repo.root, 'COMPLETE');
    unresolved.reviews = [
      {
        round: 1,
        kind: 'code',
        reviewer: 'claude',
        decision: 'request_changes',
        summary: 'Rate limiter is not concurrency safe.',
        findings: [{ id: 'F1', severity: 'high', category: 'correctness', summary: 'Race on the counter.' }],
        at: '2026-08-13T10:06:00Z',
      },
    ];
    assert.equal(exitCodeForRun(unresolved, 'committed'), EXIT.checksFailed);

    // A repository with no suite has not failed its tests — it has none, and
    // exiting 5 for that would make the code mean nothing.
    const noTests = runState(repo.root, 'COMPLETE');
    assert.equal(exitCodeForRun(noTests, 'committed'), EXIT.success);
  });

  it('130 — cancelled, however it was cancelled', () => {
    const cancelled = runState(repo.root, 'FETCHING_ISSUE');
    transition(cancelled, 'CANCELLED');
    assert.equal(exitCodeForRun(cancelled, 'unknown'), EXIT.cancelled);
    assert.equal(exitCodeFor(new RelayError('Cancelled.', { code: 'PROMPT_CANCELLED' })), EXIT.cancelled);
  });

  it('prefers the run\'s own verdict over where its work ended up', () => {
    // Both are true at once, and "the work is not good enough" is the answer
    // that decides whether anything downstream should happen at all.
    const state = runState(repo.root, 'COMPLETE');
    state.tests = {
      discovered: true,
      command: ['npm', 'test'],
      reason: 'package.json scripts.test',
      exitCode: 1,
      passed: false,
      durationMs: 900,
      timedOut: false,
      at: '2026-08-13T10:07:00Z',
    };
    assert.equal(exitCodeForRun(state, 'unlanded'), EXIT.checksFailed);
  });
});


describe('relay run --json', () => {
  interface Streamed {
    lines: RunStreamLine[];
    state: RunState;
    /** Everything a reader could already have parsed while the run was going. */
    midRun: string;
  }

  /** Drives a real engine with the JSON stream attached, capturing every line. */
  async function streamedRun(): Promise<Streamed> {
    const lines: RunStreamLine[] = [];
    let serialized = '';
    let midRun = '';

    const harnesses = happyPathHarnesses();
    // The implementer's turn is unambiguously mid-run, so the snapshot it takes
    // is the literal claim under test: parseable lines, while work is going on.
    harnesses.codex = new FakeAgentHarness('codex', {
      planReviewer: [{ text: approveReview('Plan is sound.') }],
      implementer: [
        {
          text: section('NOTES', 'Edited src/app.ts'),
          effect: async (cwd: string) => {
            midRun = serialized;
            await writesFile('src/app.ts', 'export const value = 2;\n')(cwd);
          },
        },
      ],
    });

    const built = buildEngineContext(repo, harnesses, { config: { runTests: false, deliver: 'none' } });
    const stream = new RunJsonStream({
      state: built.state,
      command: 'run',
      // A fixed clock, advanced a second per reading, so a duration in the
      // stream is an assertion rather than a hope.
      now: (() => {
        let tick = 0;
        return (): Date => new Date(Date.parse('2026-08-13T10:00:00Z') + (tick += 1) * 1000);
      })(),
      write: (line, command) => {
        lines.push(line);
        serialized += `${JSON.stringify({ schema: SCHEMA_VERSION, command, ...line })}\n`;
      },
    });

    built.context.observer = stream;
    stream.start();
    const state = await new WorkflowEngine(built.context).run();
    stream.finish(state.phase);

    return { lines, state, midRun };
  }

  it('emits one parseable object per line while the run is in progress', async () => {
    const { midRun } = await streamedRun();

    assert.ok(midRun.length > 0, 'nothing had been emitted by the time the implementer was working');
    const early = midRun.trimEnd().split('\n').map((line) => JSON.parse(line) as RunStreamLine & { schema: number });

    for (const line of early) assert.equal(line.schema, SCHEMA_VERSION);
    assert.equal(early[0]?.type, 'run_started');
    assert.ok(early.some((line) => line.type === 'phase_completed'), 'a phase should have closed already');
    assert.ok(!early.some((line) => line.type === 'summary'), 'the summary comes last, not first');
  });

  it('closes every phase the engine entered, with the time it took', async () => {
    const { lines } = await streamedRun();

    const completed = lines.filter((line) => line.type === 'phase_completed') as Array<{
      phase: string;
      durationMs: number;
      status: string;
    }>;
    assert.deepEqual(
      completed.map((line) => line.phase),
      [
        'INITIALIZING',
        'FETCHING_ISSUE',
        'CREATING_WORKSPACE',
        'PLANNING',
        'REVIEWING_PLAN',
        'IMPLEMENTING',
        'REVIEWING_CODE',
        'TESTING',
        'DELIVERING',
      ],
    );
    for (const line of completed) {
      assert.ok(line.durationMs > 0, `${line.phase} should carry how long it took`);
      assert.equal(line.status, 'done');
    }
  });

  it('reports the engine\'s own phases, including revisions the dashboard folds away', () => {
    const lines: RunStreamLine[] = [];
    const stream = new RunJsonStream({
      state: runState(repo.root),
      command: 'run',
      write: (line) => lines.push(line),
    });

    // The dashboard keeps a revision inside the review row it belongs to. The
    // stream does not: a revision is a phase the run entered, and a reader
    // counting rounds needs to see it.
    stream.phaseChanged('REVIEWING_PLAN', 'round 1/2');
    stream.phaseChanged('REVISING_PLAN', 'revising · round 1/2');
    stream.phaseChanged('REVIEWING_PLAN', 'round 2/2');
    stream.finish('COMPLETE');

    assert.deepEqual(
      lines.filter((line) => line.type === 'phase_started').map((line) => (line as { phase: string }).phase),
      ['REVIEWING_PLAN', 'REVISING_PLAN', 'REVIEWING_PLAN'],
    );
    assert.equal((lines[0] as { detail: string }).detail, 'round 1/2');
  });

  it('marks the phase a failed run died in as failed, not done', () => {
    const lines: RunStreamLine[] = [];
    const stream = new RunJsonStream({
      state: runState(repo.root),
      command: 'run',
      write: (line) => lines.push(line),
    });

    stream.phaseChanged('IMPLEMENTING');
    stream.warn('codex exited with status 1');
    stream.finish('FAILED');

    assert.deepEqual(
      lines.map((line) => line.type),
      ['phase_started', 'warning', 'phase_completed'],
    );
    assert.equal((lines[2] as { status: string }).status, 'failed');
  });

  it('closes with a summary carrying the whole run and the code it exits with', async () => {
    const { lines, state } = await streamedRun();

    const stream = new RunJsonStream({ state, command: 'run', write: (line) => lines.push(line) });
    stream.summary(runToJson(state, { landing: 'unlanded' }), EXIT.unlanded);

    const summary = lines.at(-1) as { type: string; exitCode: number; run: { runId: string; unlanded: boolean } };
    assert.equal(summary.type, 'summary');
    assert.equal(summary.exitCode, EXIT.unlanded);
    assert.equal(summary.run.runId, state.runId);
    assert.equal(summary.run.unlanded, true);
  });

  it('keeps per-tool agent noise out of the stream unless --verbose asked for it', async () => {
    const { lines } = await streamedRun();
    assert.equal(lines.filter((line) => line.type === 'agent_event').length, 0);
  });

  it('names the command that produced each line, so run and resume are distinguishable', () => {
    const seen: string[] = [];
    const stream = new RunJsonStream({
      state: runState(repo.root),
      command: 'resume',
      write: (_line, command) => seen.push(command),
    });

    stream.start();
    stream.phaseChanged('IMPLEMENTING');
    stream.finish('COMPLETE');
    assert.deepEqual(seen, ['resume', 'resume', 'resume']);
  });
});

describe('--json and the session loop', () => {
  /** The session, driven against a terminal that would happily answer. */
  async function session(options: { json: boolean }): Promise<{ asked: string[]; homes: number }> {
    const prompter = new ScriptedPrompter(['12', ''], true);
    let homes = 0;

    const deps: SessionDeps = {
      prompter,
      home: async () => {
        homes += 1;
        return { ready: true };
      },
      run: async () => 0,
    };

    if (options.json) enterJsonMode();
    try {
      await relaySession(deps, {}, { code: 0 });
    } finally {
      exitJsonMode();
    }
    return { asked: prompter.asked, homes };
  }

  it('does not ask for the next issue when the output is being parsed', async () => {
    // The prompter is genuinely interactive here — `relay run --json` on a real
    // terminal is the case that matters, and the theme cannot tell it apart. A
    // question nobody is reading is a hang, and a home screen drawn after a
    // JSON document is a second document that was never promised.
    const streamed = await session({ json: true });
    assert.deepEqual(streamed.asked, []);
    assert.equal(streamed.homes, 0);
  });

  it('still comes back for the next issue when a person is reading it', async () => {
    const human = await session({ json: false });
    assert.equal(human.asked.length, 2);
    assert.ok(human.homes > 0);
  });
});
