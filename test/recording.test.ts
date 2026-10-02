import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { recordingCommand } from '../src/cli/commands/recording.ts';
import { restoreHumanOutput, setTheme } from '../src/cli/output.ts';
import { RunJsonStream, type RunStreamLine } from '../src/cli/runStream.ts';
import { buildRunBundle, type RunBundle } from '../src/replay/bundle.ts';
import { RelayError } from '../src/util/errors.ts';
import { WorkflowEngine } from '../src/workflow/engine.ts';
import type { RunState } from '../src/workflow/state.ts';
import { buildEngineContext, type Harness } from './helpers/engine.ts';
import { FakeAgentHarness, approveReview, planText, requestChangesReview, responsesText, section } from './helpers/fakeHarness.ts';
import { writesFile } from './helpers/engine.ts';
import { createTempRepo, type TempRepo } from './helpers/tempRepo.ts';

let repo: TempRepo;
let originalCwd: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  repo = await createTempRepo({ withPackageJson: true });
  process.env['RELAY_HOME'] = repo.relayHome;
  // The command resolves its repository from the working directory.
  process.chdir(repo.root);
  setTheme({ color: false, unicode: true, interactive: false });
});

afterEach(async () => {
  process.chdir(originalCwd);
  delete process.env['RELAY_HOME'];
  restoreHumanOutput();
  setTheme(undefined);
  await repo.cleanup();
});

const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(3)}`;

/** A run with one plan revision and one code revision, so every kind of record exists. */
function debatedHarnesses(): Harness {
  const planFinding = { id: 'F1', severity: 'high', category: 'architecture', summary: 'Ignores the existing RateLimiter' };
  const codeFinding = { id: 'F1', severity: 'high', category: 'correctness', summary: 'Off-by-one in the window', impact: 'BLOCKING', file: 'src/app.ts' };
  return {
    claude: new FakeAgentHarness('claude', {
      planner: [
        // A credential an agent read and repeated: it must not survive the export.
        { text: planText(`First attempt, using ${TOKEN}`) },
        { text: responsesText([{ findingId: 'F1', response: 'ACCEPT', reasoning: 'Will reuse it' }], '## Summary\nRevised plan reusing RateLimiter') },
      ],
      codeReviewer: [{ text: requestChangesReview([codeFinding]) }, { text: approveReview('Fixed.') }],
    }),
    codex: new FakeAgentHarness('codex', {
      planReviewer: [{ text: requestChangesReview([planFinding]) }, { text: approveReview('Now correct.') }],
      implementer: [
        { text: section('NOTES', 'first pass'), effect: writesFile('src/app.ts', 'export const value = 6;\n') },
        { text: responsesText([{ findingId: 'F1', response: 'ACCEPT', reasoning: 'fixed the boundary' }]), effect: writesFile('src/app.ts', 'export const value = 7;\n') },
      ],
    }),
  };
}

async function finishedRun(): Promise<{ state: RunState; live: RunStreamLine[] }> {
  const { context, state } = buildEngineContext(repo, debatedHarnesses());
  // Watch the run through the same stream `relay run --json` prints, to compare with the rebuilt one.
  const live: RunStreamLine[] = [];
  const stream = new RunJsonStream({ state, command: 'run', write: (line) => live.push(line) });
  context.observer = stream;
  stream.start();
  const final = await new WorkflowEngine(context).run();
  stream.finish(final.phase);
  assert.equal(final.phase, 'COMPLETE');
  return { state: final, live };
}

async function silently<T>(action: () => Promise<T>): Promise<T> {
  const originals = { stdout: process.stdout.write, stderr: process.stderr.write };
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return await action();
  } finally {
    process.stdout.write = originals.stdout;
    process.stderr.write = originals.stderr;
  }
}

async function exported(state: RunState, options: { patches?: boolean } = {}): Promise<{ bundle: RunBundle; text: string }> {
  const out = join(repo.root, '..', `recording-${state.shortId}.json`);
  const code = await silently(() => recordingCommand(state.shortId, { out, ...options }));
  assert.equal(code, 0);
  const text = await readFile(out, 'utf8');
  return { bundle: JSON.parse(text) as RunBundle, text };
}

describe('relay recording', () => {
  it('rebuilds the run’s stream from disk, phase for phase, with the recorded times', async () => {
    const { state, live } = await finishedRun();
    const { bundle } = await exported(state);

    assert.equal(bundle.bundle, 1);
    assert.equal(bundle.stream[0]?.type, 'run_started');
    assert.equal(bundle.stream.at(-1)?.type, 'summary');

    // The same phases, in the same order, with the same round details, as the live stream printed.
    const phases = (lines: RunStreamLine[]) => lines.filter((line) => line.type === 'phase_started').map((line) => `${line.phase} ${line.detail ?? ''}`.trim());
    assert.deepEqual(phases(bundle.stream), phases(live));
    assert.ok(phases(bundle.stream).some((phase) => phase.startsWith('REVISING_CODE')), 'the code revision is a phase of its own');

    // Every phase that opened closed, and time only moves forwards.
    const started = bundle.stream.filter((line) => line.type === 'phase_started').length;
    const completed = bundle.stream.filter((line) => line.type === 'phase_completed');
    assert.equal(completed.length, started);
    assert.ok(completed.every((line) => line.type === 'phase_completed' && line.status === 'done' && line.durationMs >= 0));
    const times = bundle.stream.map((line) => line.at);
    assert.deepEqual(times, [...times].sort(), 'the stream is in time order');

    // The times are the run's, not the export's.
    assert.ok(bundle.stream.every((line) => line.at <= (state.finishedAt ?? '')));
    assert.ok(bundle.exportedAt >= (state.finishedAt ?? ''));

    const summary = bundle.stream.at(-1);
    assert.ok(summary?.type === 'summary');
    assert.equal(summary.exitCode, bundle.exitCode);
    assert.equal(summary.run.runId, state.runId);
  });

  it('carries what the run produced: the plan, both debates, every patch and the test log', async () => {
    const { state } = await finishedRun();
    const { bundle } = await exported(state);

    assert.match(bundle.artifacts.issue ?? '', /Add authentication rate limiting/);
    assert.match(bundle.artifacts.plan ?? '', /Revised plan reusing RateLimiter/);
    assert.deepEqual(bundle.artifacts.reviews.map((review) => `${review.kind}:${review.round}:${review.decision}`), ['plan:1:request_changes', 'plan:2:approve', 'code:1:request_changes', 'code:2:approve']);
    assert.equal(bundle.artifacts.reviews[0]?.responses?.[0]?.response, 'ACCEPT');
    assert.deepEqual(bundle.artifacts.patches.map((patch) => patch.label), ['implementation', 'revision-round-1']);
    assert.match(bundle.artifacts.patches[0]?.patch ?? '', /\+export const value = 6;/);
    assert.match(bundle.artifacts.patches[1]?.patch ?? '', /\+export const value = 7;/);
    assert.match(bundle.artifacts.testLog ?? '', /exit code: 0/);
  });

  it('writes receipts for the checks the run already made', async () => {
    const { state } = await finishedRun();
    const { bundle } = await exported(state);
    const receipt = (id: string) => bundle.receipts.find((entry) => entry.id === id);

    assert.equal(receipt('independence:plan')?.verdict, 'match');
    assert.match(receipt('independence:plan')?.measured?.text ?? '', /Written by claude, reviewed by codex/);
    assert.equal(receipt('independence:code')?.verdict, 'match');
    // The implementer accepted the finding, and the patch for that file did change.
    assert.equal(receipt('finding:code:1:F1')?.verdict, 'match');
    assert.match(receipt('finding:code:1:F1')?.measured?.text ?? '', /changed src\/app\.ts/);
    // The planner accepted the plan finding, and plan.md was rewritten.
    assert.equal(receipt('plan-revision:1')?.verdict, 'match');
    assert.match(receipt('files')?.measured?.text ?? '', /1 file changed.*src\/app\.ts/);
    assert.match(receipt('tests')?.measured?.text ?? '', /exited 0/);
    assert.equal(receipt('code-review')?.verdict, 'measured');

    // In the order they became known.
    const times = bundle.receipts.map((entry) => entry.at);
    assert.deepEqual(times, [...times].sort());
  });

  it('leaves this machine’s paths and anything shaped like a credential out of the file', async () => {
    const { state } = await finishedRun();
    const { bundle, text } = await exported(state);

    assert.ok(!text.includes(repo.root), 'the repository’s path is gone');
    assert.ok(!text.includes(homedir()), 'the home directory is gone');
    assert.ok(!text.includes(TOKEN), 'the token is gone');
    assert.equal(bundle.run.workspace?.path, '<worktree>');
    assert.equal(bundle.run.notification, null);
    assert.ok(bundle.cleaned.paths > 0);
    // The token the planner repeated was in the first plan, which the revision replaced; the notes and events may still echo it.
    assert.ok(!JSON.stringify(bundle.artifacts).includes('ghp_'));
  });

  it('leaves the diffs out when asked, and says so', async () => {
    const { state } = await finishedRun();
    const { bundle } = await exported(state, { patches: false });

    assert.deepEqual(bundle.artifacts.patches, []);
    assert.equal(bundle.cleaned.patchesOmitted, true);
    // The receipts were read before the patches were dropped.
    assert.equal(bundle.receipts.find((entry) => entry.id === 'finding:code:1:F1')?.verdict, 'match');
  });

  it('redacts a credential in a patch without rewriting the code around it', () => {
    const state = structuredClone(BASE_STATE);
    const patch = ['diff --git a/src/app.ts b/src/app.ts', '--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1 +1,2 @@', `+const leaked = "${TOKEN}";`, '+const API_TOKEN = process.env.API_TOKEN;', ''].join('\n');
    const bundle = buildRunBundle({ state, events: [], landing: 'unknown', relayVersion: 'test', patches: [{ label: 'implementation', patch }] });

    assert.match(bundle.artifacts.patches[0]?.patch ?? '', /\[redacted:github-token\]/);
    // A looser pattern would have rewritten this line; in a diff it is left as written.
    assert.match(bundle.artifacts.patches[0]?.patch ?? '', /const API_TOKEN = process\.env\.API_TOKEN;/);
    assert.equal(bundle.cleaned.secrets, 1);
  });

  it('does not count what was logged after the run ended as time its last phase spent', () => {
    const state = structuredClone(BASE_STATE);
    const at = (seconds: number) => new Date(Date.parse('2026-08-13T10:00:00.000Z') + seconds * 1000).toISOString();
    const event = (type: string, phase: string, seconds: number, message?: string) => ({ timestamp: at(seconds), runId: state.runId, phase, agent: null, type, ...(message === undefined ? {} : { message }) }) as never;
    const events = [
      event('phase_started', 'PLANNING', 0),
      event('phase_completed', 'PLANNING', 100, '40 line plan'),
      event('phase_started', 'DELIVERING', 100),
      event('phase_completed', 'DELIVERING', 300, 'opened a pull request'),
      // `relay deliver`, run again an hour later.
      event('delivery', 'COMPLETE', 3900, 'merged'),
    ];
    const bundle = buildRunBundle({ state, events, landing: 'unknown', relayVersion: 'test', patches: [] });
    const completed = bundle.stream.filter((line) => line.type === 'phase_completed');
    assert.deepEqual(completed.map((line) => (line.type === 'phase_completed' ? [line.phase, line.durationMs] : null)), [['PLANNING', 100_000], ['DELIVERING', 200_000]]);
    // The later line is still there, after the phases, at its own time.
    const merged = bundle.stream.find((line) => line.type === 'note' && line.message === 'merged');
    assert.equal(merged?.at, at(3900));
    assert.ok(bundle.stream.indexOf(merged!) > bundle.stream.indexOf(completed.at(-1)!));
    assert.equal(bundle.stream.at(-1)?.type, 'summary');
  });

  it('refuses a run that has not finished', () => {
    const state = structuredClone(BASE_STATE);
    state.phase = 'IMPLEMENTING';
    assert.throws(
      () => buildRunBundle({ state, events: [], landing: 'unknown', relayVersion: 'test', patches: [] }),
      (error: unknown) => error instanceof RelayError && error.code === 'RUN_NOT_FINISHED',
    );
  });
});

/** The least a finished run can be, for the cases that need no engine. */
const BASE_STATE = {
  version: 1,
  runId: '20260813-100000-abc123',
  shortId: 'abc123',
  createdAt: '2026-08-13T10:00:00.000Z',
  updatedAt: '2026-08-13T10:05:00.000Z',
  finishedAt: '2026-08-13T10:05:00.000Z',
  phase: 'COMPLETE',
  history: [
    { phase: 'INITIALIZING', at: '2026-08-13T10:00:00.000Z' },
    { phase: 'COMPLETE', at: '2026-08-13T10:05:00.000Z' },
  ],
  issueRef: '142',
  repository: { root: '/tmp/widgets', owner: 'acme', name: 'widgets', defaultBranch: 'main' },
  agents: { planner: { provider: 'claude' }, planReviewer: { provider: 'codex' }, implementer: { provider: 'codex' }, codeReviewer: { provider: 'claude' } },
  config: (await import('../src/storage/config.ts')).DEFAULT_CONFIG,
  rounds: { planReview: 0, codeReview: 0 },
  reviews: [],
  planApproved: false,
} as unknown as RunState;
