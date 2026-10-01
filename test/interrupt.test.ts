import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CONFIG } from '../src/storage/config.ts';
import { listRuns, RunStore } from '../src/storage/runs.ts';
import { createRunId } from '../src/util/ids.ts';
import { createRunState } from '../src/workflow/state.ts';
import { createTempRepo, isolatedGitEnv, type TempRepo } from './helpers/tempRepo.ts';

/**
 * Ctrl-C, on a real terminal.
 *
 * The live display reads single keys, so it puts the terminal in raw mode — and
 * in raw mode Ctrl-C is not a signal. It is the byte 0x03 on stdin, delivered
 * to whoever is reading, and SIGINT is sent to nobody. A test that sends
 * SIGINT to the process proves nothing about that, and a test that pipes stdin
 * never enters raw mode at all. So these run the real CLI on a pseudo-terminal
 * and type at it, which is the only place the behaviour exists.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, '..', 'src', 'index.ts');
const PTY = join(here, 'helpers', 'terminal.py');
const CTRL_C = '\u0003';
const EXIT_CANCELLED = 130;

/** Why these cannot run here, or undefined when they can. */
function unavailable(): string | undefined {
  // Windows has no pty to borrow, and its console delivers Ctrl-C differently.
  if (process.platform === 'win32') return 'no pseudo-terminal on Windows; Ctrl-C handling was not checked';
  const python = spawnSync('python3', ['-c', 'import pty'], { encoding: 'utf8' });
  if (python.error !== undefined || python.status !== 0) {
    return 'python3 is not installed; Ctrl-C handling was not checked on a terminal';
  }
  return undefined;
}

interface PtyStep {
  /** Text to wait for in what the command prints. */
  wait: string;
  /** What to type once it has appeared. */
  send?: string;
  /** A file to delete once it has appeared, instead of typing. */
  remove?: string;
  /** A signal to send the command once it has appeared, without the `SIG`. */
  signal?: 'TERM' | 'HUP' | 'INT';
  /** Seconds to keep reading before acting. */
  delay?: number;
}

interface PtyResult {
  status: number | null;
  signal: number | null;
  timedOut: boolean;
  stepsDone: number;
  output: string;
}

/** Runs `relay <args>` on a pseudo-terminal in `repo`, typing `steps` at it. */
async function relayOnTerminal(
  repo: TempRepo,
  args: string[],
  steps: PtyStep[],
  options: { timeout?: number } = {},
): Promise<PtyResult> {
  const spec = {
    // The sources, through type stripping: the flag is what makes that work on
    // the Node floor, and it is accepted everywhere above it.
    argv: [process.execPath, '--experimental-strip-types', ENTRY, ...args],
    cwd: repo.root,
    env: {
      ...(await isolatedGitEnv(dirname(repo.root))),
      RELAY_HOME: repo.relayHome,
      TERM: 'xterm-256color',
      // A CI runner sets these, and either one turns the live display off —
      // which would leave nothing here to test.
      CI: null,
      NO_COLOR: null,
      // Otherwise the child reports to this test run as one of its subtests.
      NODE_TEST_CONTEXT: null,
    },
    steps,
    timeout: options.timeout ?? 60,
  };

  const child = spawn('python3', [PTY, JSON.stringify(spec)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0, `the pty helper failed: ${stderr}`);
  return JSON.parse(stdout) as PtyResult;
}

/**
 * A repository whose every role is one scripted CLI that says it is ready and
 * then works for ever — a turn in flight, for as long as the test needs one.
 */
async function repoWithEndlessAgent(options: { ignoresSigterm: boolean }): Promise<{ repo: TempRepo; pidFile: string }> {
  const repo = await createTempRepo();
  const base = dirname(repo.root);
  const agent = join(base, 'agent.mjs');
  const pidFile = join(base, 'agent.pid');

  await writeFile(
    agent,
    [
      "import { writeFileSync } from 'node:fs';",
      'process.stdin.resume();',
      // A CLI that will not go quietly, which is what keeps a cancellation in
      // progress long enough for a second Ctrl-C to mean something.
      options.ignoresSigterm ? "process.on('SIGTERM', () => {});" : '',
      "process.stdin.on('end', () => {",
      '  writeFileSync(process.argv[2], String(process.pid));',
      "  process.stdout.write(JSON.stringify({ message: 'AGENT-IS-WORKING' }) + '\\n');",
      '  setInterval(() => {}, 1000);',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );

  await repo.writeFile(
    '.relay/config.json',
    `${JSON.stringify(
      {
        version: 1,
        harnesses: {
          endless: {
            command: process.execPath,
            args: [agent, pidFile],
            promptOn: 'stdin',
            stream: 'jsonl',
            map: { text: '$.message' },
            readOnly: ['--read-only'],
          },
        },
        agents: { planner: 'endless', planReviewer: 'endless', implementer: 'endless', codeReviewer: 'endless' },
        workflow: { runTests: false },
      },
      null,
      2,
    )}\n`,
  );
  await repo.commit('configure relay');
  return { repo, pidFile };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !processAlive(pid);
}

describe('Ctrl-C on a terminal', { concurrency: false }, () => {
  const skip = unavailable();

  it('cancels a run on the first press and records it as cancelled', { skip }, async () => {
    const { repo, pidFile } = await repoWithEndlessAgent({ ignoresSigterm: false });
    try {
      const result = await relayOnTerminal(
        repo,
        ['run', '--prompt', 'Add a greeting helper'],
        [
          // The run's own display is up and an agent turn is in flight.
          { wait: 'AGENT-IS-WORKING', send: CTRL_C },
          // The run is over and the session is back at its prompt, where the
          // same key leaves — with the code of the run it just cancelled.
          { wait: '^C exit', send: CTRL_C },
        ],
      );

      assert.equal(result.timedOut, false, result.output);
      assert.match(result.output, /Ctrl-C cancel/, 'the display named the key');
      assert.match(result.output, /Cancelling/);
      assert.match(result.output, /Run cancelled/);
      assert.equal(result.status, EXIT_CANCELLED, result.output);

      // Cancelled, not killed: the engine got to write down what happened.
      const [run] = await listRuns(repo.root);
      assert.equal(run?.phase, 'CANCELLED');
      const pid = Number.parseInt(await readFile(pidFile, 'utf8'), 10);
      assert.ok(await waitUntilGone(pid, 5_000), 'the agent turn outlived the run it belonged to');
    } finally {
      await repo.cleanup();
    }
  });

  it('exits 130 on the second press, taking the agents with it', { skip }, async () => {
    const { repo, pidFile } = await repoWithEndlessAgent({ ignoresSigterm: true });
    try {
      const started = Date.now();
      const result = await relayOnTerminal(
        repo,
        ['run', '--prompt', 'Add a greeting helper'],
        [
          { wait: 'AGENT-IS-WORKING', send: CTRL_C },
          // This agent ignores the polite signal, so the cancellation is still
          // waiting on it. The second press is "now".
          { wait: 'Cancelling', send: CTRL_C, delay: 0.5 },
        ],
      );

      assert.equal(result.timedOut, false, result.output);
      assert.equal(result.stepsDone, 2, result.output);
      assert.equal(result.status, EXIT_CANCELLED, result.output);
      assert.doesNotMatch(result.output, /Run cancelled/, 'the second press did not wait for the run to wind down');
      assert.ok(Date.now() - started < 30_000, 'the second press waited for the agent instead of leaving');

      const pid = Number.parseInt(await readFile(pidFile, 'utf8'), 10);
      assert.ok(await waitUntilGone(pid, 5_000), 'a force quit left the agent running with nobody to stop it');
    } finally {
      await repo.cleanup();
    }
  });

  // A second Ctrl-C is somebody saying "now". A second signal of any other
  // kind is not: a closing terminal hangs up more than once, a supervisor
  // sends SIGTERM and waits. Cutting the cancellation short for those leaves
  // exactly the stale run the cancellation exists to prevent.
  it('does not force quit on a repeated SIGTERM or a hangup, only on a second Ctrl-C', { skip }, async () => {
    const { repo, pidFile } = await repoWithEndlessAgent({ ignoresSigterm: true });
    try {
      const result = await relayOnTerminal(
        repo,
        ['run', '--prompt', 'Add a greeting helper'],
        [
          { wait: 'AGENT-IS-WORKING', signal: 'TERM' },
          // The agent ignores the polite signal, so the run is mid-cancel for
          // the whole grace period. Everything below lands inside it.
          { wait: 'Cancelling', signal: 'TERM', delay: 0.4 },
          { wait: '', signal: 'HUP', delay: 0.4 },
          // One Ctrl-C after a signal started the cancellation is still the
          // first Ctrl-C.
          { wait: '', send: CTRL_C, delay: 0.4 },
          // The run wound down on its own and the session is at its prompt.
          { wait: '^C exit', send: CTRL_C },
        ],
      );

      assert.equal(result.timedOut, false, result.output);
      assert.equal(result.stepsDone, 5, result.output);
      assert.match(result.output, /Already cancelling/);
      assert.match(result.output, /Run cancelled/, 'the cancellation was cut short');
      assert.equal(result.status, EXIT_CANCELLED, result.output);

      const [run] = await listRuns(repo.root);
      assert.equal(run?.phase, 'CANCELLED');
      const pid = Number.parseInt(await readFile(pidFile, 'utf8'), 10);
      assert.ok(await waitUntilGone(pid, 5_000), 'the agent turn outlived the run it belonged to');
    } finally {
      await repo.cleanup();
    }
  });

  // The display has the terminal in raw mode and stdin flowing. A watch that
  // fails has to hand both back, or the error is followed by a process that
  // never exits and a terminal where Ctrl-C no longer does anything.
  it('gives the terminal back when `relay watch` fails part-way', { skip }, async () => {
    const repo = await createTempRepo();
    try {
      const now = new Date();
      const state = createRunState({
        runId: createRunId(now),
        shortId: 'abc235',
        issueRef: '142',
        repository: { root: repo.root, owner: 'acme', name: 'widgets', defaultBranch: 'main' },
        config: structuredClone(DEFAULT_CONFIG),
        now,
      });
      const store = new RunStore(repo.root, state.runId);
      await store.init();
      await store.saveState(state);

      const result = await relayOnTerminal(
        repo,
        ['watch', state.runId, '--interval', '250'],
        // Once the display is up, the run's state goes away underneath it.
        [{ wait: 'Ctrl-C exit', remove: join(repo.root, '.relay', 'runs', state.runId, 'state.json') }],
        { timeout: 20 },
      );

      assert.equal(result.stepsDone, 1, result.output);
      assert.equal(result.timedOut, false, `the watch never exited after failing:\n${result.output}`);
      assert.match(result.output, /has no state file/);
      assert.notEqual(result.status, 0);
      assert.notEqual(result.status, null, result.output);
    } finally {
      await repo.cleanup();
    }
  });

  it('leaves `relay watch` on the first press, and leaves the run alone', { skip }, async () => {
    const repo = await createTempRepo();
    try {
      const now = new Date();
      const state = createRunState({
        runId: createRunId(now),
        shortId: 'abc234',
        issueRef: '142',
        repository: { root: repo.root, owner: 'acme', name: 'widgets', defaultBranch: 'main' },
        config: structuredClone(DEFAULT_CONFIG),
        now,
      });
      const store = new RunStore(repo.root, state.runId);
      await store.init();
      await store.saveState(state);

      const result = await relayOnTerminal(repo, ['watch', state.runId], [{ wait: 'Ctrl-C exit', send: CTRL_C }]);

      assert.equal(result.timedOut, false, result.output);
      assert.equal(result.stepsDone, 1, result.output);
      assert.equal(result.status, EXIT_CANCELLED, result.output);
      assert.match(result.output, /Stopped watching/);
      // Watching is not owning: `s` is not offered, and nothing was cancelled.
      assert.doesNotMatch(result.output, /s stop after this phase/);
      assert.equal((await store.loadState()).phase, 'INITIALIZING');
      assert.equal(await store.readArtifact('CANCEL'), undefined);
    } finally {
      await repo.cleanup();
    }
  });
});
