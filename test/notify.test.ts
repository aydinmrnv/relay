import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/storage/config.ts';
import { buildWebhookPayload } from '../src/notify/payload.ts';
import { notifyRun } from '../src/notify/index.ts';
import { completionArgs } from '../src/notify/command.ts';
import { notifySystem } from '../src/notify/system.ts';
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
    value.pullRequest = { url: 'https://example.test/pr/1', number: 1, base: 'main', head: 'run', createdByRun: true, at: value.updatedAt };
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

describe('desktop notification', () => {
  function recorder(available: readonly string[]) {
    const calls: Array<{ command: string; args: readonly string[]; env?: Record<string, string | undefined> }> = [];
    return {
      calls,
      resolve: async (name: string) => (available.includes(name) ? `/resolved/${name}` : null),
      run: async (command: string, args: readonly string[], options: { env?: Record<string, string | undefined> } = {}) => {
        calls.push({ command, args, ...(options.env === undefined ? {} : { env: options.env }) });
        return { command, args, cwd: '/', exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1, timedOut: false, aborted: false, ok: true };
      },
    };
  }

  it('raises a notification on Windows instead of reporting the platform unsupported', async () => {
    const fake = recorder(['powershell']);
    const detail = await notifySystem('Run relay-1 complete', { platform: 'win32', resolve: fake.resolve as never, run: fake.run as never });
    assert.equal(detail, 'powershell');
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0]!.command, '/resolved/powershell');
  });

  // The notification body is the one part of that command line Relay did not
  // write, so it never becomes part of it: PowerShell reads it from the
  // environment, where a `;` or a `$(...)` is text and stays text.
  it('passes the body through the environment, never through the script', async () => {
    const fake = recorder(['powershell']);
    const body = 'Run $(Get-Process); rm -rf / complete';
    await notifySystem(body, { platform: 'win32', resolve: fake.resolve as never, run: fake.run as never });
    const call = fake.calls[0]!;
    assert.equal(call.env?.['RELAY_NOTIFY_BODY'], body);
    assert.ok(!call.args.some((arg) => arg.includes(body)), 'the body must not appear in argv');
    assert.ok(call.args.some((arg) => arg.includes('$env:RELAY_NOTIFY_BODY')), 'the script must read it from the environment');
    assert.ok(call.args.includes('-NoProfile'), 'a user profile must not be able to redefine the script');
  });

  it('falls back to pwsh, and reports the notifier missing when neither is installed', async () => {
    const withPwsh = recorder(['pwsh']);
    assert.equal(await notifySystem('done', { platform: 'win32', resolve: withPwsh.resolve as never, run: withPwsh.run as never }), 'pwsh');

    const withNeither = recorder([]);
    assert.equal(await notifySystem('done', { platform: 'win32', resolve: withNeither.resolve as never, run: withNeither.run as never }), 'notifier unavailable');
    assert.equal(withNeither.calls.length, 0);
  });

  it('still uses each POSIX platform notifier', async () => {
    const mac = recorder(['osascript']);
    assert.equal(await notifySystem('done', { platform: 'darwin', resolve: mac.resolve as never, run: mac.run as never }), 'osascript');
    const linux = recorder(['notify-send']);
    assert.equal(await notifySystem('done', { platform: 'linux', resolve: linux.resolve as never, run: linux.run as never }), 'notify-send');
    const other = recorder(['osascript']);
    assert.equal(await notifySystem('done', { platform: 'aix', resolve: other.resolve as never, run: other.run as never }), 'unsupported platform');
  });
});
