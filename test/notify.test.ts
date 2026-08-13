import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/storage/config.ts';
import { buildWebhookPayload } from '../src/notify/payload.ts';
import { notifyRun } from '../src/notify/index.ts';
import { completionArgs } from '../src/notify/command.ts';
import { createRunState, transition } from '../src/workflow/state.ts';
import { RecordingObserver } from '../src/workflow/observer.ts';
import { buildIssueComment, RUN_MARKER } from '../src/workflow/issueComment.ts';

function state() {
  const config = structuredClone(DEFAULT_CONFIG);
  config.notify.webhook = 'https://hooks.example/run';
  const value = createRunState({ runId: 'run-1', shortId: 'one', issueRef: '35', repository: { root: '/secret/workspace', owner: 'acme', name: 'relay', defaultBranch: 'main' }, config, now: new Date('2026-01-01T00:00:00Z') });
  value.issue = { id: 'github:acme/relay#35', number: 35, title: 'Notify', url: 'https://example/issues/35', state: 'open' };
  value.diff = { fileCount: 2, additions: 4, deletions: 1, files: ['secret.ts'], patchFile: 'final.patch', at: value.createdAt };
  return value;
}

describe('webhook notification', () => {
  it('substitutes completion command tokens without interpreting shell syntax', () => {
    const value = state();
    value.phase = 'COMPLETE';
    value.pullRequest = { url: 'https://example.test/pr/1', number: 1, base: 'main', head: 'run', at: value.updatedAt };
    assert.deepEqual(completionArgs(['notify', '--run={{runId}}', '{{outcome}}', '{{url}}', '$(never)'], value), [
      'notify', `--run=${value.runId}`, 'complete', 'https://example.test/pr/1', '$(never)',
    ]);
  });
  it('builds a versioned, deliberately narrow payload', () => {
    const payload = buildWebhookPayload(state());
    assert.equal(payload.schema, 1);
    assert.deepEqual(payload.diff, { fileCount: 2, additions: 4, deletions: 1 });
    const json = JSON.stringify(payload);
    assert.doesNotMatch(json, /secret\.ts|final\.patch|secret\/workspace|agents|commit/);
  });

  it('retries transient responses and records success', async () => {
    const value = state();
    let calls = 0;
    const fetch = async () => new Response(null, { status: ++calls === 1 ? 500 : 204 });
    await notifyRun({ state: value, observer: new RecordingObserver() }, { fetch, sleep: async () => {} });
    assert.equal(calls, 2);
    assert.equal(value.notification?.webhook?.status, 'done');
  });

  it('does not retry terminal responses or alter a cancelled outcome', async () => {
    const value = state();
    transition(value, 'CANCELLED');
    let calls = 0;
    await notifyRun({ state: value, observer: new RecordingObserver() }, { fetch: async () => { calls += 1; return new Response('', { status: 400 }); }, sleep: async () => {} });
    assert.equal(calls, 1);
    assert.equal(value.phase, 'CANCELLED');
    assert.equal(value.notification?.webhook?.status, 'skipped');
  });
});

describe('issue result comment', () => {
  it('reports the PR, diff, tests, findings and cost with an intact trailing marker', () => {
    const value = state();
    value.config.workflow.typos = true;
    value.pullRequest = { url: 'https://example/pull/9', number: 9, base: 'main', head: 'relay/35-one', createdByRun: true, at: value.createdAt };
    value.tests = { discovered: true, command: ['npm', 'test'], reason: 'package.json', exitCode: 0, passed: true, durationMs: 5, timedOut: false, at: value.createdAt };
    const body = buildIssueComment(value);
    assert.match(body, /https:\/\/example\/pull\/9/);
    assert.match(body, /\+4\/-1/);
    assert.match(body, /passed/);
    assert.ok(body.endsWith(RUN_MARKER(value.runId)));
  });
});
