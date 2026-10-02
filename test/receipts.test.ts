import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { changedBetween, patchSections, receiptsFor, type Receipt } from '../src/replay/receipts.ts';
import { DEFAULT_CONFIG } from '../src/storage/config.ts';
import type { LoggedEvent } from '../src/storage/runs.ts';
import { createRunState, type RunState } from '../src/workflow/state.ts';

const AT = '2026-08-13T10:00:00.000Z';

function runState(): RunState {
  const state = createRunState({
    runId: '20260813-100000-rcp001',
    shortId: 'rcp001',
    issueRef: '142',
    repository: { root: '/work/widgets', owner: 'acme', name: 'widgets', defaultBranch: 'main' },
    config: structuredClone(DEFAULT_CONFIG),
    now: new Date(AT),
  });
  state.workspace = { path: '/work/widgets/.relay/worktrees/rcp001', branch: 'relay/142-rcp001', baseSha: 'a'.repeat(40), baseRef: 'refs/heads/main', baseBranch: 'main' };
  return state;
}

function agentEvent(type: string, role: string, data: Record<string, unknown>): LoggedEvent {
  return { timestamp: AT, runId: '20260813-100000-rcp001', phase: 'IMPLEMENTING', agent: 'codex', type, data: { role, provider: 'codex', ...data } };
}

function patchOf(files: Record<string, string>): string {
  return Object.entries(files)
    .map(([path, line]) => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -1 +1 @@', `+${line}`, ''].join('\n'))
    .join('');
}

function only(receipts: Receipt[], id: string): Receipt {
  const found = receipts.find((receipt) => receipt.id === id);
  assert.ok(found !== undefined, `expected a receipt called ${id}`);
  return found;
}

describe('receipts: tests', () => {
  const withTests = (passed: boolean): RunState => {
    const state = runState();
    state.tests = { discovered: true, command: ['npm', 'test'], reason: 'package.json', exitCode: passed ? 0 : 1, passed, durationMs: 12_000, timedOut: false, outputFile: 'tests/test-run.log', at: AT };
    return state;
  };

  it('agree when the implementer’s own run and Relay’s run exited the same way', () => {
    const receipt = only(receiptsFor({ state: withTests(true), events: [agentEvent('command', 'implementer', { command: 'npm test', exitCode: 0 })], patches: [] }), 'tests');
    assert.equal(receipt.verdict, 'match');
    assert.match(receipt.claim?.text ?? '', /exit 0/);
    assert.match(receipt.measured?.text ?? '', /`npm test` exited 0 .* passed/);
  });

  it('disagree when the implementer saw the suite pass and Relay’s run of it failed', () => {
    const receipt = only(receiptsFor({ state: withTests(false), events: [agentEvent('command', 'implementer', { command: 'bash -lc "npm test"', exitCode: 0 })], patches: [] }), 'tests');
    assert.equal(receipt.verdict, 'mismatch');
    assert.match(receipt.measured?.text ?? '', /exited 1 .* failed/);
  });

  it('do not take a filtered run, or a line that does more than run the suite, for a claim about the suite', () => {
    // From a real run: the line exited 1 because of what came before the tests, and the tests it ran were a subset.
    const events = [
      agentEvent('command', 'implementer', { command: `/bin/zsh -lc "sed -n '1,55p' src/atomic.ts; rg \"loadConfig\" test -n; npm test -- --test-name-pattern='home screen' test/home.test.ts"`, exitCode: 1 }),
      agentEvent('command', 'implementer', { command: 'npm test -- test/home.test.ts', exitCode: 1 }),
    ];
    const receipt = only(receiptsFor({ state: withTests(true), events, patches: [] }), 'tests');
    assert.equal(receipt.verdict, 'measured');
    assert.equal(receipt.claim, null);
  });

  it('are measured only when no agent reported how the command exited', () => {
    // Claude Code's command events carry no exit code, and a reviewer's run is not the author's claim.
    const events = [agentEvent('command', 'implementer', { command: 'npm test' }), agentEvent('command', 'codeReviewer', { command: 'npm test', exitCode: 0 })];
    const receipt = only(receiptsFor({ state: withTests(true), events, patches: [] }), 'tests');
    assert.equal(receipt.verdict, 'measured');
    assert.equal(receipt.claim, null);
  });

  it('are unverified when Relay ran no suite, whatever the agent says it ran', () => {
    const state = runState();
    state.tests = { discovered: false, command: [], reason: 'no test script', exitCode: null, passed: false, durationMs: 0, timedOut: false, skippedReason: 'no test command was found', at: AT };
    const receipt = only(receiptsFor({ state, events: [], patches: [] }), 'tests');
    assert.equal(receipt.verdict, 'unverified');
    assert.equal(receipt.measured, null);
    assert.match(receipt.note ?? '', /no test command was found/);
  });
});

describe('receipts: files changed', () => {
  const withDiff = (files: string[]): RunState => {
    const state = runState();
    state.diff = { fileCount: files.length, additions: 4, deletions: 1, files, patchFile: 'patches/implementation.patch', at: AT };
    return state;
  };
  const edited = (path: string): LoggedEvent => agentEvent('file_changed', 'implementer', { path });

  it('agree when git’s diff is exactly the files the implementer reported editing', () => {
    // Reported as absolute paths inside the worktree; git prints them relative to it.
    const events = [edited('/work/widgets/.relay/worktrees/rcp001/src/app.ts'), edited('src/limit.ts'), edited('src/app.ts')];
    const receipt = only(receiptsFor({ state: withDiff(['src/app.ts', 'src/limit.ts']), events, patches: [] }), 'files');
    assert.equal(receipt.verdict, 'match');
    assert.match(receipt.claim?.text ?? '', /Edited 2 files: src\/app\.ts, src\/limit\.ts/);
  });

  it('disagree when a file reported as edited is unchanged in the diff', () => {
    const receipt = only(receiptsFor({ state: withDiff(['src/app.ts']), events: [edited('src/app.ts'), edited('src/ghost.ts')], patches: [] }), 'files');
    assert.equal(receipt.verdict, 'mismatch');
    assert.match(receipt.note ?? '', /src\/ghost\.ts/);
  });

  it('do not call it a contradiction when the diff holds more than the edit tool reported', () => {
    const receipt = only(receiptsFor({ state: withDiff(['package-lock.json', 'src/app.ts']), events: [edited('src/app.ts')], patches: [] }), 'files');
    assert.equal(receipt.verdict, 'measured');
    assert.match(receipt.note ?? '', /package-lock\.json.*shell edits/);
  });

  it('are measured only when nothing was reported', () => {
    const receipt = only(receiptsFor({ state: withDiff(['src/app.ts']), events: [], patches: [] }), 'files');
    assert.equal(receipt.verdict, 'measured');
    assert.equal(receipt.claim, null);
  });

  it('record a success that changed nothing as the mismatch it is', () => {
    const state = runState();
    state.error = { message: 'The implementer reported success but changed no files.', phase: 'IMPLEMENTING', code: 'EMPTY_IMPLEMENTATION' };
    assert.equal(only(receiptsFor({ state, events: [], patches: [] }), 'empty-implementation').verdict, 'mismatch');
  });
});

describe('receipts: review', () => {
  const reviewed = (reviewer: string): RunState => {
    const state = runState();
    state.diff = { fileCount: 1, additions: 1, deletions: 0, files: ['src/app.ts'], patchFile: 'patches/implementation.patch', at: AT };
    state.reviews = [{ round: 1, kind: 'code', reviewer, decision: 'approve', findings: [], at: AT }];
    return state;
  };

  it('agree when the reviewer is the other model, and disagree when it graded its own work', () => {
    // The default config has codex implement and claude review.
    assert.equal(only(receiptsFor({ state: reviewed('claude'), events: [], patches: [] }), 'independence:code').verdict, 'match');
    assert.equal(only(receiptsFor({ state: reviewed('codex'), events: [], patches: [] }), 'independence:code').verdict, 'mismatch');
  });

  it('say so when a diff was read by nobody but its author', () => {
    const state = reviewed('claude');
    state.reviews = [];
    const receipt = only(receiptsFor({ state, events: [], patches: [] }), 'independence:code');
    assert.equal(receipt.verdict, 'unverified');
    assert.match(receipt.note ?? '', /nobody but its author/);
  });

  it('do not call a review that ran and returned no readable verdict "no review"', () => {
    const state = reviewed('claude');
    state.reviews = [];
    state.error = { message: 'codeReviewer could not produce parseable output after a retry.', phase: 'REVIEWING_CODE', code: 'UNPARSEABLE_OUTPUT' };
    const receipt = only(receiptsFor({ state, events: [], patches: [] }), 'independence:code');
    assert.equal(receipt.verdict, 'unverified');
    assert.match(receipt.note ?? '', /claude read the diff codex wrote, and the run ended before a verdict was recorded: codeReviewer could not produce parseable output/);
    assert.ok(!(receipt.note ?? '').includes('nobody but its author'));
  });

  const debated = (response: 'ACCEPT' | 'REJECT', nextDecision?: 'approve' | 'request_changes', file: string | undefined = 'src/app.ts'): RunState => {
    const state = reviewed('claude');
    state.reviews = [
      {
        round: 1,
        kind: 'code',
        reviewer: 'claude',
        decision: 'request_changes',
        findings: [{ id: 'F1', severity: 'high', category: 'correctness', summary: 'Off-by-one', impact: 'BLOCKING', ...(file === undefined ? {} : { file }) }],
        responses: [{ findingId: 'F1', response, reasoning: 'because' }],
        at: AT,
      },
      ...(nextDecision === undefined ? [] : [{ round: 2, kind: 'code' as const, reviewer: 'claude', decision: nextDecision, findings: [], at: AT }]),
    ];
    return state;
  };
  const before = patchOf({ 'src/app.ts': 'const a = 1;', 'src/other.ts': 'const b = 1;' });

  it('agree when a finding was accepted and the revision changed the file it names', () => {
    const after = patchOf({ 'src/app.ts': 'const a = 2;', 'src/other.ts': 'const b = 1;' });
    const receipt = only(receiptsFor({ state: debated('ACCEPT', 'approve'), events: [], patches: [{ label: 'implementation', patch: before }, { label: 'revision-round-1', patch: after }] }), 'finding:code:1:F1');
    assert.equal(receipt.verdict, 'match');
    assert.match(receipt.measured?.text ?? '', /changed src\/app\.ts/);
  });

  it('disagree when a finding was accepted and the revision changed nothing', () => {
    const receipt = only(receiptsFor({ state: debated('ACCEPT', 'approve'), events: [], patches: [{ label: 'implementation', patch: before }, { label: 'revision-round-1', patch: before }] }), 'finding:code:1:F1');
    assert.equal(receipt.verdict, 'mismatch');
  });

  it('claim nothing when the revision changed only another file, or the finding names none', () => {
    const after = patchOf({ 'src/app.ts': 'const a = 1;', 'src/other.ts': 'const b = 2;' });
    const patches = [{ label: 'implementation', patch: before }, { label: 'revision-round-1', patch: after }];
    const elsewhere = only(receiptsFor({ state: debated('ACCEPT', 'approve'), events: [], patches }), 'finding:code:1:F1');
    assert.equal(elsewhere.verdict, 'unverified');
    assert.match(elsewhere.measured?.text ?? '', /src\/other\.ts, and not src\/app\.ts/);
    assert.equal(only(receiptsFor({ state: debated('ACCEPT', 'approve', undefined), events: [], patches }), 'finding:code:1:F1').verdict, 'unverified');
  });

  it('let a rejection stand only when the next review approved', () => {
    assert.equal(only(receiptsFor({ state: debated('REJECT', 'approve'), events: [], patches: [] }), 'finding:code:1:F1').verdict, 'match');
    assert.equal(only(receiptsFor({ state: debated('REJECT', 'request_changes'), events: [], patches: [] }), 'finding:code:1:F1').verdict, 'unverified');
    assert.equal(only(receiptsFor({ state: debated('REJECT'), events: [], patches: [] }), 'finding:code:1:F1').verdict, 'unverified');
  });

  it('write down whether a debate ended in approval or at the round limit', () => {
    const state = runState();
    state.reviews = [
      { round: 1, kind: 'plan', reviewer: 'codex', decision: 'request_changes', findings: [{ id: 'F1', severity: 'high', category: 'architecture', summary: 'a' }], at: AT },
      { round: 2, kind: 'plan', reviewer: 'codex', decision: 'request_changes', findings: [{ id: 'F1', severity: 'high', category: 'architecture', summary: 'a' }, { id: 'F2', severity: 'low', category: 'testing', summary: 'b' }], at: AT },
      { round: 1, kind: 'code', reviewer: 'claude', decision: 'approve', findings: [], at: AT },
    ];
    const receipts = receiptsFor({ state, events: [], patches: [] });
    const plan = only(receipts, 'plan-review');
    assert.equal(plan.verdict, 'measured');
    assert.match(plan.measured?.text ?? '', /Still requesting changes after round 2: 2 findings open/);
    assert.match(plan.note ?? '', /round limit ended the debate, not an approval/);
    assert.equal(only(receipts, 'code-review').measured?.text, 'Approved in round 1.');
  });

  it('check a plan revision by whether the plan was rewritten', () => {
    const state = runState();
    state.reviews = [
      { round: 1, kind: 'plan', reviewer: 'codex', decision: 'request_changes', findings: [{ id: 'F1', severity: 'high', category: 'architecture', summary: 'Ignores RateLimiter' }], responses: [{ findingId: 'F1', response: 'ACCEPT', reasoning: 'ok' }], at: AT },
    ];
    assert.equal(only(receiptsFor({ state, events: [], patches: [], planRevised: { 1: true } }), 'plan-revision:1').verdict, 'match');
    assert.equal(only(receiptsFor({ state, events: [], patches: [], planRevised: { 1: false } }), 'plan-revision:1').verdict, 'mismatch');
    assert.equal(only(receiptsFor({ state, events: [], patches: [] }), 'plan-revision:1').verdict, 'unverified');
  });
});

describe('receipts: delivery and cost', () => {
  it('compare how far delivery was allowed to go with how far it went', () => {
    const state = runState();
    state.delivery = {
      policy: 'pr',
      reached: 'push',
      steps: [
        { step: 'commit', status: 'done', detail: 'abc1234 on relay/142-rcp001', at: AT },
        { step: 'push', status: 'done', detail: 'origin/relay/142-rcp001', at: AT },
        { step: 'pullRequest', status: 'failed', detail: 'gh is not signed in', at: AT },
      ],
      at: AT,
    };
    const short = only(receiptsFor({ state, events: [], patches: [] }), 'delivery');
    assert.equal(short.verdict, 'mismatch');
    assert.match(short.note ?? '', /Stopped at pullRequest \(failed\): gh is not signed in/);

    state.delivery.reached = 'pr';
    state.delivery.steps[2] = { step: 'pullRequest', status: 'done', detail: 'opened #412', at: AT };
    state.pullRequest = { url: 'https://github.com/acme/widgets/pull/412', number: 412, base: 'main', head: 'relay/142-rcp001', createdByRun: true, at: AT };
    const full = only(receiptsFor({ state, events: [], patches: [] }), 'delivery');
    assert.equal(full.verdict, 'match');
    assert.match(full.measured?.text ?? '', /pull\/412/);
  });

  it('say a cost is a floor when some turns reported no price, and never print $0 for no price at all', () => {
    const state = runState();
    state.usage = { total: { inputTokens: 12_000, outputTokens: 3_400, costUsd: 1.5, turns: 5, pricedTurns: 3 }, byPhase: {} };
    const partial = only(receiptsFor({ state, events: [], patches: [] }), 'cost');
    assert.equal(partial.verdict, 'measured');
    assert.match(partial.measured?.text ?? '', /\$1\.50 over 5 turns/);
    assert.match(partial.note ?? '', /2 turns reported no price/);

    state.usage = { total: { inputTokens: 100, outputTokens: 50, turns: 2, pricedTurns: 0 }, byPhase: {} };
    const unpriced = only(receiptsFor({ state, events: [], patches: [] }), 'cost');
    assert.match(unpriced.measured?.text ?? '', /No price reported over 2 turns/);
    assert.ok(!(unpriced.measured?.text ?? '').includes('$'));
  });
});

describe('patches', () => {
  it('are split by file, and compared file by file', () => {
    const before = patchOf({ 'src/a.ts': 'one', 'src/b.ts': 'two' });
    const after = patchOf({ 'src/a.ts': 'one', 'src/b.ts': 'TWO', 'src/c.ts': 'three' });
    assert.deepEqual([...patchSections(before).keys()], ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(changedBetween(before, after), ['src/b.ts', 'src/c.ts']);
    assert.deepEqual(changedBetween(before, before), []);
  });
});
