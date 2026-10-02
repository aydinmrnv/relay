import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BUILTIN_RECORDINGS } from '@/lib/replay/builtin';
import { foldRecording, patchTimes, replaySteps, workflowForRecording } from '@/lib/replay/fold';
import { githubUrl, parseRecording, parseRecordingText } from '@/lib/replay/parse';
import type { Recording } from '@/lib/replay/types';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'recordings');

function builtin(slug: string): Recording {
  const parsed = parseRecordingText(readFileSync(join(PUBLIC, `${slug}.json`), 'utf8'));
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  return parsed.recording;
}

/** The least a recording can be: one phase, then the summary. */
function tiny(overrides: { pullRequestUrl?: string; issueUrl?: string } = {}): unknown {
  const run = {
    runId: '20260813T100000-abc123',
    shortId: 'abc123',
    phase: 'COMPLETE',
    phaseLabel: 'Complete',
    createdAt: '2026-08-13T10:00:00.000Z',
    finishedAt: '2026-08-13T10:05:00.000Z',
    durationMs: 300_000,
    issueRef: '142',
    issue: { number: 142, title: 'Add rate limiting', url: overrides.issueUrl ?? 'https://github.com/acme/widgets/issues/142' },
    repository: { owner: 'acme', name: 'widgets' },
    agents: { planner: 'claude', planReviewer: 'codex', implementer: 'codex', codeReviewer: 'claude' },
    pullRequest: { url: overrides.pullRequestUrl ?? 'https://github.com/acme/widgets/pull/412', number: 412 },
    usage: { total: { costUsd: 1.25, turns: 4, pricedTurns: 2 }, byPhase: { PLANNING: { costUsd: 1.25 } } },
    diff: { fileCount: 2, additions: 10, deletions: 3 },
    tests: { discovered: true, command: ['npm', 'test'], passed: true, durationMs: 9000, skippedReason: null },
    delivery: { policy: 'pr', reached: 'pr', steps: [{ step: 'commit', status: 'done', detail: 'abc' }], comment: { status: 'done', detail: 'commented', url: 'https://evil.example/comment' } },
  };
  return {
    bundle: 1,
    exportedAt: '2026-08-14T09:00:00.000Z',
    relayVersion: '0.1.0',
    exitCode: 0,
    run,
    stream: [
      { type: 'run_started', at: '2026-08-13T10:00:00.000Z', runId: run.runId, agents: run.agents },
      { type: 'phase_started', at: '2026-08-13T10:00:01.000Z', phase: 'PLANNING', phaseLabel: 'Planning', detail: null },
      { type: 'note', at: '2026-08-13T10:02:00.000Z', message: '40 line plan' },
      { type: 'phase_completed', at: '2026-08-13T10:02:00.000Z', phase: 'PLANNING', phaseLabel: 'Planning', durationMs: 119_000, status: 'done' },
      { type: 'phase_started', at: '2026-08-13T10:02:00.000Z', phase: 'DELIVERING', phaseLabel: 'Delivering', detail: null },
      { type: 'phase_completed', at: '2026-08-13T10:05:00.000Z', phase: 'DELIVERING', phaseLabel: 'Delivering', durationMs: 180_000, status: 'done' },
      { type: 'summary', at: '2026-08-13T10:05:00.000Z', exitCode: 0, run },
    ],
    artifacts: { issue: '# Add rate limiting', plan: '## Summary', implementationNotes: null, reviews: [], patches: [], testLog: null },
    receipts: [{ id: 'cost', subject: 'Cost', phase: 'COMPLETE', at: '2026-08-13T10:05:00.000Z', claim: null, measured: { by: 'the coding CLIs', text: '$1.25 over 4 turns', source: 'state.json' }, verdict: 'measured' }],
    cleaned: { secrets: 0, paths: 3, patchesOmitted: false },
  };
}

function parsed(value: unknown): Recording {
  const result = parseRecording(value);
  assert.ok(result.ok, result.ok ? '' : result.error);
  return result.recording;
}

test('every recording that ships with the studio is one this studio can read', () => {
  assert.ok(BUILTIN_RECORDINGS.length >= 3);
  for (const meta of BUILTIN_RECORDINGS) {
    const recording = builtin(meta.slug);
    // The card says what the file says.
    assert.equal(`${recording.run.repository.owner}/${recording.run.repository.name}`, meta.repository, meta.slug);
    assert.equal(recording.run.pullRequest?.number ?? null, meta.pullRequest, meta.slug);
    assert.equal(recording.run.issue?.title, meta.title, meta.slug);
    assert.equal(Math.round((recording.run.durationMs ?? 0) / 60_000), meta.minutes, meta.slug);
    assert.equal(recording.run.costUsd === null ? null : Math.round(recording.run.costUsd * 100) / 100, meta.costUsd, meta.slug);
    assert.equal(recording.exitCode === 0 ? 'passed' : recording.exitCode === 5 ? 'checks-failed' : 'failed', meta.outcome, meta.slug);
    assert.ok(recording.receipts.length > 0, `${meta.slug} has receipts`);
    // Made to be shown: nothing of the machine it ran on.
    assert.ok(!/\/(Users|home)\//.test(JSON.stringify(recording)), `${meta.slug} names no home directory`);
  }
});

test('a recording folds into the run the studio draws, and the same way every time', () => {
  for (const meta of BUILTIN_RECORDINGS) {
    const recording = builtin(meta.slug);
    const run = foldRecording(recording);
    assert.deepEqual(foldRecording(recording), run, 'folding is deterministic: no clock of its own');
    assert.equal(run.status, meta.outcome === 'passed' ? 'succeeded' : 'failed', meta.slug);
    assert.equal(run.source, 'machine', 'a recording is of a real run');
    assert.equal(run.finishedAt, recording.run.finishedAt);
    assert.ok(run.phases.length >= 5, `${meta.slug} has its phases`);
    assert.ok(run.phases.every((phase) => phase.ms >= 0));
    assert.equal(run.prUrl, recording.run.pullRequest?.url);
    // The phases are the run's time and no more: nothing logged after it ended is counted as work.
    const worked = run.phases.reduce((sum, phase) => sum + phase.ms, 0);
    assert.ok(worked <= (recording.run.durationMs ?? 0) + 1000, `${meta.slug}: phases took ${worked}ms of a ${recording.run.durationMs}ms run`);
    // A phase visited twice has one reported cost; counted once, the phases add up to the run.
    const phased = run.phases.reduce((sum, phase) => sum + (phase.costUsd ?? 0), 0);
    assert.ok(Math.abs(phased - run.costUsd) < 0.05, `${meta.slug}: phases cost ${phased.toFixed(2)}, the run ${run.costUsd.toFixed(2)}`);
    assert.ok(Object.values(run.nodeStatus).every((status) => status !== 'pending' && status !== 'running'), 'a finished run leaves nothing pending');
  }
});

test('scrubbing only ever moves a run forwards', () => {
  const recording = builtin('open-the-product');
  const workflow = workflowForRecording(recording);
  const steps = replaySteps(recording);
  assert.equal(steps[0]?.label, 'Started');
  assert.equal(steps.at(-1)?.label, 'Finished');
  assert.equal(steps.at(-1)?.count, recording.stream.length);
  let before = { events: 0, phases: 0, offset: -1, count: 0 };
  for (const step of steps) {
    const run = foldRecording(recording, step.count, workflow);
    assert.ok(step.count > before.count, 'each stop is further into the stream');
    assert.ok(step.offsetMs >= before.offset, 'and no earlier in time');
    assert.ok(run.events.length >= before.events && run.phases.length >= before.phases, 'nothing is taken back');
    assert.equal(run.status, step.count === recording.stream.length ? 'succeeded' : 'running');
    before = { events: run.events.length, phases: run.phases.length, offset: step.offsetMs, count: step.count };
  }
  // Part way through, the pipeline is the node at work and delivery has not begun.
  const middle = foldRecording(recording, steps[4]!.count, workflow);
  assert.equal(middle.nodeStatus['rec_pipeline'], 'running');
  assert.equal(middle.nodeStatus['rec_delivery'], 'pending');
  assert.equal(middle.prUrl, undefined);
});

test('a recording is drawn on what ran: a person, the pipeline with its agents, delivery', () => {
  const recording = builtin('open-the-product');
  const workflow = workflowForRecording(recording);
  assert.deepEqual(workflow.nodes.map((node) => node.data.typeId), ['logic.trigger.manual', 'pipeline.action.run', 'delivery.action.deliver']);
  assert.equal(workflow.nodes[1]?.data.config['planner'], 'claude');
  assert.equal(workflow.nodes[1]?.data.config['implementer'], 'codex');
  assert.equal(workflow.repository, 'aydinmrnv/relay');
  assert.equal(workflow.edges.length, 2);
});

test('each patch is dated by the phase that produced it', () => {
  const recording = builtin('shell-completions');
  const times = patchTimes(recording);
  assert.deepEqual(Object.keys(times), ['implementation', 'revision-round-1']);
  assert.ok(times['implementation']! < times['revision-round-1']!);
  assert.deepEqual(recording.artifacts.patches.map((patch) => patch.label), ['implementation', 'revision-round-1']);
});

test('what is not a recording is turned away with a reason', () => {
  assert.match(String((parseRecordingText('not json') as { error: string }).error), /not JSON/);
  assert.match(String((parseRecording({ nodes: [], edges: [] }) as { error: string }).error), /no `bundle` version/);
  assert.match(String((parseRecording({ bundle: 2 }) as { error: string }).error), /version 2/);
  assert.match(String((parseRecording({ ...(tiny() as object), stream: [] }) as { error: string }).error), /stream is empty/);
  assert.match(String((parseRecording({ ...(tiny() as object), run: {} }) as { error: string }).error), /which run/);
});

test('a recording from anywhere cannot put a link of its own on the page', () => {
  assert.equal(githubUrl('https://github.com/acme/widgets/pull/412', 'pull'), 'https://github.com/acme/widgets/pull/412');
  for (const hostile of ['javascript:alert(1)', 'https://github.com.evil.example/acme/widgets/pull/1', 'https://github.com/acme/widgets/pull/1/../../settings', 'http://github.com/acme/widgets/pull/1', 'https://github.com/acme/widgets/pull/1?x=<script>']) {
    assert.equal(githubUrl(hostile, 'pull'), null, hostile);
  }

  const hostile = parsed(tiny({ pullRequestUrl: 'javascript:alert(document.cookie)', issueUrl: 'https://evil.example/issues/1' }));
  assert.equal(hostile.run.pullRequest, null);
  assert.equal(hostile.run.issue?.url, '');
  const run = foldRecording(hostile);
  assert.equal(run.prUrl, undefined);
  assert.ok(!JSON.stringify(run).includes('javascript:'));
  assert.ok(!JSON.stringify(run).includes('evil.example'), 'the comment address in the summary is dropped too');
  assert.equal(run.status, 'succeeded');

  // An honest one keeps its pull request.
  assert.equal(foldRecording(parsed(tiny())).prUrl, 'https://github.com/acme/widgets/pull/412');
});

test('a field of the wrong shape is dropped, not fatal', () => {
  const odd = parsed({ ...(tiny() as object), receipts: [{ id: 'x', subject: 'y', at: 'not a date', verdict: 'match' }, { id: 7 }, 'nope'], artifacts: { plan: 42, patches: 'no', reviews: [{ kind: 'essay', at: '2026-08-13T10:00:00.000Z' }] }, relayVersion: 9 });
  assert.deepEqual(odd.receipts, []);
  assert.equal(odd.artifacts.plan, null);
  assert.deepEqual(odd.artifacts.patches, []);
  assert.deepEqual(odd.artifacts.reviews, []);
  assert.equal(odd.relayVersion, 'unknown');
});
