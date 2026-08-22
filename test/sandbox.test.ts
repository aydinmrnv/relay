import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildBubblewrapArgs,
  buildSandboxExecProfile,
  detectOsSandbox,
  wrapWithOsSandbox,
} from '../src/agents/sandbox.ts';
import { ClaudeHarness, claudeWritablePaths } from '../src/agents/claude.ts';
import { enforcementChecks } from '../src/cli/checks.ts';
import { AGENT_REGISTRY } from '../src/agents/index.ts';
import { resolveExecutable, runProcess } from '../src/process/runner.ts';

describe('sandbox-exec profile construction', () => {
  it('denies all writes, then allows only the declared paths back', () => {
    const profile = buildSandboxExecProfile(['/Users/me/.claude']);

    assert.match(profile, /\(version 1\)/);
    assert.match(profile, /\(deny file-write\*\)/);
    assert.match(profile, /\(allow file-write\*/);
    assert.match(profile, /\(subpath "\/Users\/me\/\.claude"\)/);
    // The temp trees every process needs are always writable.
    assert.match(profile, /\(subpath "\/private\/var\/folders"\)/);
    // The deny must come after the blanket allow, so it wins over it.
    assert.ok(profile.indexOf('(allow default)') < profile.indexOf('(deny file-write*)'));
  });

  it('escapes quotes and backslashes so a hostile path cannot break the profile', () => {
    const profile = buildSandboxExecProfile(['/tmp/we"ird\\path']);
    assert.ok(profile.includes('(subpath "/tmp/we\\"ird\\\\path")'));
  });
});

describe('bubblewrap argv construction', () => {
  it('binds the filesystem read-only and only the declared paths writable', () => {
    const args = buildBubblewrapArgs(['/home/me/.claude', '/home/me/.cache']);

    assert.deepEqual(args.slice(0, 3), ['--ro-bind', '/', '/']);
    assert.ok(args.includes('--die-with-parent'));
    const bind = args.indexOf('--bind-try');
    assert.deepEqual(args.slice(bind, bind + 3), ['--bind-try', '/home/me/.claude', '/home/me/.claude']);
    assert.equal(args[args.length - 1], '--');
  });
});

describe('wrapping an invocation', () => {
  const invocation = { command: 'claude', args: ['-p', '--verbose'] };

  it('prefixes sandbox-exec with the profile and keeps the original argv intact', () => {
    const wrapped = wrapWithOsSandbox('sandbox-exec', invocation, ['/x']);

    assert.equal(wrapped.command, 'sandbox-exec');
    assert.equal(wrapped.args[0], '-p');
    assert.match(wrapped.args[1] ?? '', /deny file-write\*/);
    assert.deepEqual(wrapped.args.slice(2), ['claude', '-p', '--verbose']);
  });

  it('prefixes bwrap and keeps the original argv after the separator', () => {
    const wrapped = wrapWithOsSandbox('bubblewrap', invocation, ['/x']);

    assert.equal(wrapped.command, 'bwrap');
    const separator = wrapped.args.indexOf('--');
    assert.deepEqual(wrapped.args.slice(separator + 1), ['claude', '-p', '--verbose']);
  });
});

describe('sandbox detection', () => {
  it('reports honestly on a platform with no sandbox', async () => {
    const result = await detectOsSandbox('win32');
    assert.equal(result.available, false);
    assert.match(result.available ? '' : result.reason, /no OS sandbox is available on win32/);
  });

  it('honours the escape hatch, and says that is why', async () => {
    process.env['RELAY_NO_OS_SANDBOX'] = '1';
    try {
      const result = await detectOsSandbox();
      assert.equal(result.available, false);
      assert.match(result.available ? '' : result.reason, /RELAY_NO_OS_SANDBOX/);
    } finally {
      delete process.env['RELAY_NO_OS_SANDBOX'];
    }
  });
});

/**
 * The wrapper against the real operating system: a write outside the allowed
 * paths must fail, a write inside them must succeed. Skipped where the
 * platform's sandbox is not installed — that absence is exactly what the
 * detection reports and doctor shows.
 */
describe('OS enforcement, where the platform provides it', () => {
  it('denies writes outside the allowlist and permits them inside', async (t) => {
    const detected = await detectOsSandbox();
    if (!detected.available) {
      t.skip(`no OS sandbox here: ${detected.reason}`);
      return;
    }

    // A directory outside every allowed path: the repository worktree itself.
    const denied = await mkdtemp(join(process.cwd(), '.sandbox-test-'));
    const allowed = await mkdtemp(join(tmpdir(), 'relay-sandbox-'));
    try {
      const touch = (await resolveExecutable('touch')) ?? '/usr/bin/touch';

      const blocked = wrapWithOsSandbox(detected.mechanism, { command: touch, args: [join(denied, 'x')] }, [tmpdir()]);
      const refused = await runProcess(blocked.command, blocked.args, { timeoutMs: 20_000 });
      assert.equal(refused.ok, false, 'a write outside the allowlist must be refused');

      const permitted = wrapWithOsSandbox(detected.mechanism, { command: touch, args: [join(allowed, 'x')] }, [tmpdir()]);
      const succeeded = await runProcess(permitted.command, permitted.args, { timeoutMs: 20_000 });
      assert.equal(succeeded.ok, true, `a write inside the allowlist must succeed: ${succeeded.stderr}`);
    } finally {
      await rm(denied, { recursive: true, force: true });
      await rm(allowed, { recursive: true, force: true });
    }
  });
});

describe('read-only turns through the claude harness', () => {
  const options = { prompt: 'noop', cwd: process.cwd(), role: 'planner', timeoutMs: 30_000 } as const;

  it('wraps a read-only turn in the OS sandbox, or says out loud that it cannot', async () => {
    const harness = new ClaudeHarness({ binary: 'true' });
    const session = await harness.start({ ...options, capability: 'read_only' });
    const detected = await detectOsSandbox();

    if (detected.available) {
      const expected = detected.mechanism === 'sandbox-exec' ? 'sandbox-exec' : 'bwrap';
      assert.equal(session.invocation.command, expected);
      assert.ok(session.invocation.args.includes('true'), 'the real binary rides inside the wrapper');
      // The deny list stays as the second layer.
      assert.ok(session.invocation.args.includes('--disallowed-tools'));
    } else {
      assert.equal(session.invocation.command, 'true');
      const notice = session.events.find((event) => event.type === 'notice');
      assert.match(notice?.type === 'notice' ? notice.text : '', /not OS-sandboxed/);
    }
  });

  it('leaves write turns unwrapped — the deny list and the workflow gate those', async () => {
    const harness = new ClaudeHarness({ binary: 'true' });
    const session = await harness.start({ ...options, capability: 'write' });
    assert.equal(session.invocation.command, 'true');
  });

  it('gives the CLI its own state paths and nothing in the worktree', () => {
    const paths = claudeWritablePaths('/home/me', '/tmp/scratch');
    assert.ok(paths.includes('/tmp/scratch'));
    assert.ok(paths.includes('/home/me/.claude'));
    assert.ok(paths.every((path) => !path.includes('worktree')));
  });
});

describe('relay doctor names the enforcement per harness', () => {
  it('reports one read-only row per registered harness', async () => {
    const checks = await enforcementChecks();
    assert.equal(checks.length, AGENT_REGISTRY.length);
    for (const entry of AGENT_REGISTRY) {
      assert.ok(checks.some((check) => check.label === `${entry.label} read-only`), `missing row for ${entry.name}`);
    }
  });

  it('credits codex with its own OS sandbox on every platform', async () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const check = (await enforcementChecks([], platform)).find((row) => row.label.startsWith('Codex'));
      assert.equal(check?.status, 'ok');
      assert.match(check?.detail ?? '', /OS sandbox \(codex --sandbox read-only\)/);
    }
  });

  it('warns, honestly, where a deny-list harness gets no OS sandbox', async () => {
    const check = (await enforcementChecks([], 'win32')).find((row) => row.label.startsWith('Claude'));
    assert.equal(check?.status, 'warn');
    assert.match(check?.detail ?? '', /tool deny list .* only — no OS sandbox is available on win32/);
    assert.ok((check?.hint ?? '').length > 0);
  });

  it('reports the layered enforcement where the sandbox exists', async (t) => {
    const detected = await detectOsSandbox();
    if (!detected.available) {
      t.skip(`no OS sandbox here: ${detected.reason}`);
      return;
    }
    const check = (await enforcementChecks()).find((row) => row.label.startsWith('Claude'));
    assert.equal(check?.status, 'ok');
    assert.match(check?.detail ?? '', new RegExp(`OS sandbox \\(${detected.mechanism}\\) \\+ tool deny list`));
  });
});
