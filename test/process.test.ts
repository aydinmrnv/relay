import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runProcess,
  resolveExecutable,
  resolveInvocation,
  describeFailure,
  type ExecutionPlatform,
} from '../src/process/runner.ts';
import { createLineSplitter, parseJsonLine } from '../src/process/lines.ts';
import { RelayError } from '../src/util/errors.ts';

describe('process runner', () => {
  it('passes arguments as an argv array, never through a shell', async () => {
    // If a shell were involved, `$(id -u)` and the semicolon would be expanded
    // or split. They must survive as literal text.
    const payload = '$(id -u); rm -rf /; `whoami`';
    const result = await runProcess('node', ['-e', 'process.stdout.write(process.argv[1])', payload]);

    assert.equal(result.ok, true);
    assert.equal(result.stdout, payload);
  });

  it('reports exit codes rather than throwing', async () => {
    const result = await runProcess('node', ['-e', 'process.exit(3)']);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 3);
  });

  it('delivers stdin and closes it', async () => {
    const result = await runProcess(
      'node',
      ['-e', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(d.toUpperCase()))'],
      { stdin: 'hello' },
    );
    assert.equal(result.stdout, 'HELLO');
  });

  it('streams stdout line by line across chunk boundaries', async () => {
    const lines: string[] = [];
    await runProcess(
      'node',
      ['-e', 'process.stdout.write("a\\nb\\n");process.stdout.write("c\\n")'],
      { onStdoutLine: (line) => lines.push(line) },
    );
    assert.deepEqual(lines, ['a', 'b', 'c']);
  });

  it('terminates a process that exceeds its timeout', async () => {
    const result = await runProcess('node', ['-e', 'setTimeout(()=>{}, 60000)'], { timeoutMs: 300 });
    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false);
  });

  it('cancels via an abort signal', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const result = await runProcess('node', ['-e', 'setTimeout(()=>{}, 60000)'], { signal: controller.signal });
    assert.equal(result.aborted, true);
    assert.equal(result.ok, false);
  });

  it('returns immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runProcess('node', ['-e', 'process.exit(0)'], { signal: controller.signal });
    assert.equal(result.aborted, true);
  });

  it('raises an actionable error for a missing executable', async () => {
    await assert.rejects(
      () => runProcess('relay-definitely-not-installed', []),
      (error: unknown) => {
        assert.ok(error instanceof RelayError);
        assert.equal(error.code, 'EXECUTABLE_NOT_FOUND');
        assert.match(error.hint ?? '', /relay doctor/);
        return true;
      },
    );
  });

  it('describes failures with the tail of stderr', async () => {
    const result = await runProcess('node', ['-e', 'console.error("boom");process.exit(2)']);
    assert.match(describeFailure(result), /exited with code 2/);
    assert.match(describeFailure(result), /boom/);
  });

  it('resolves executables on PATH and reports missing ones as null', async () => {
    assert.notEqual(await resolveExecutable('node'), null);
    assert.equal(await resolveExecutable('relay-definitely-not-installed'), null);
  });
});

/**
 * Windows behaviour, simulated by injecting the platform. These run on every
 * OS; the real-Windows leg of CI runs them on the platform they describe.
 *
 * Two comparisons are deliberately case-insensitive: resolution generates
 * candidate names from PATHEXT, and which spelling wins a `stat` depends on
 * whether the filesystem running the test folds case (APFS does, ext4 does
 * not, NTFS does).
 */
describe('windows executable resolution (simulated)', () => {
  const FAKE_NODE = '/fake/windows/node.exe';
  let dir: string;

  function winPlatform(dirs: string[], env: Record<string, string | undefined> = {}): ExecutionPlatform {
    return {
      isWindows: true,
      env: { PATH: dirs.join(';'), PATHEXT: '.COM;.EXE;.BAT;.CMD', ...env },
      execPath: FAKE_NODE,
    };
  }

  function posixPlatform(dirs: string[]): ExecutionPlatform {
    return { isWindows: false, env: { PATH: dirs.join(':') }, execPath: process.execPath };
  }

  const sameFile = (actual: string | null, expected: string): void => {
    assert.equal(actual?.toLowerCase(), expected.toLowerCase());
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'relay-win-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('honours PATHEXT instead of the execute bit', async () => {
    // Mode 644: no execute bit anywhere. On Windows that means nothing, and
    // the resolver must not let a POSIX X_OK probe say "missing".
    await writeFile(join(dir, 'gh.exe'), 'MZ');
    await chmod(join(dir, 'gh.exe'), 0o644);
    await writeFile(join(dir, 'git.exe'), 'MZ');
    await chmod(join(dir, 'git.exe'), 0o644);

    const platform = winPlatform([dir]);
    sameFile(await resolveExecutable('gh', { platform }), join(dir, 'gh.exe'));
    sameFile(await resolveExecutable('git', { platform }), join(dir, 'git.exe'));
    assert.equal(await resolveExecutable('missing-entirely', { platform }), null);
  });

  it('still requires the execute bit on POSIX', async () => {
    await writeFile(join(dir, 'noexec'), '#!/bin/sh\n');
    await chmod(join(dir, 'noexec'), 0o644);
    assert.equal(await resolveExecutable('noexec', { platform: posixPlatform([dir]) }), null);
  });

  it('does not treat a bare POSIX executable as runnable on Windows', async () => {
    await writeFile(join(dir, 'codex'), '#!/usr/bin/env node\n');
    await chmod(join(dir, 'codex'), 0o755);
    assert.equal(await resolveExecutable('codex', { platform: winPlatform([dir]) }), null);
    assert.notEqual(await resolveExecutable('codex', { platform: posixPlatform([dir]) }), null);
  });

  it('respects PATHEXT order within a directory and PATH order across them', async () => {
    const first = join(dir, 'first');
    const second = join(dir, 'second');
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    await writeFile(join(first, 'tool.cmd'), '@echo off\r\n');
    await writeFile(join(second, 'tool.exe'), 'MZ');
    await writeFile(join(second, 'both.cmd'), '@echo off\r\n');
    await writeFile(join(second, 'both.exe'), 'MZ');

    // The earlier PATH entry wins even when a later one has a "better" extension.
    sameFile(await resolveExecutable('tool', { platform: winPlatform([first, second]) }), join(first, 'tool.cmd'));
    // Within one directory, PATHEXT order decides: .EXE before .CMD.
    sameFile(await resolveExecutable('both', { platform: winPlatform([second]) }), join(second, 'both.exe'));
  });

  it('unquotes quoted PATH entries and accepts an explicit extension', async () => {
    const platform = winPlatform([`"${dir}"`]);
    sameFile(await resolveExecutable('gh', { platform }), join(dir, 'gh.exe'));
    sameFile(await resolveExecutable('gh.exe', { platform }), join(dir, 'gh.exe'));
  });

  it('spawns a resolved .exe by its full path, unchanged args, no shell', async () => {
    const invocation = await resolveInvocation('gh', ['pr', 'view'], winPlatform([dir]));
    assert.equal(invocation.command.toLowerCase(), join(dir, 'gh.exe').toLowerCase());
    assert.deepEqual([...invocation.args], ['pr', 'view']);
  });

  it('sees through a modern npm cmd shim to node plus the wrapped script', async () => {
    const shims = join(dir, 'shims');
    await mkdir(shims, { recursive: true });
    // The target is extensionless, the way npm bin entries often are.
    await mkdir(join(dir, 'typescript', 'bin'), { recursive: true });
    await writeFile(join(dir, 'typescript', 'bin', 'tsc'), '#!/usr/bin/env node\n');
    await writeFile(
      join(shims, 'tsc.cmd'),
      [
        '@ECHO off',
        'GOTO start',
        ':find_dp0',
        'SET dp0=%~dp0',
        'EXIT /b',
        ':start',
        'SETLOCAL',
        'CALL :find_dp0',
        '',
        'IF EXIST "%dp0%\\node.exe" (',
        '  SET "_prog=%dp0%\\node.exe"',
        ') ELSE (',
        '  SET "_prog=node"',
        '  SET PATHEXT=%PATHEXT:;.JS;=;%',
        ')',
        '',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\..\\typescript\\bin\\tsc" %*',
        '',
      ].join('\r\n'),
    );

    // The hostile argument must ride through untouched: it becomes one argv
    // entry for node, and cmd.exe never exists to reinterpret it.
    const payload = '$(rm -rf /) & del C:\\Windows %PATH%';
    const invocation = await resolveInvocation('tsc', ['--version', payload], winPlatform([shims]));

    assert.equal(invocation.command, FAKE_NODE);
    assert.equal(invocation.args[0], join(dir, 'typescript', 'bin', 'tsc'));
    assert.deepEqual([...invocation.args.slice(1)], ['--version', payload]);
  });

  it('sees through the older shim format that names node.exe directly', async () => {
    await mkdir(join(dir, 'node_modules', 'npm', 'bin'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'console.log("npm")\n');
    await writeFile(
      join(dir, 'legacy.cmd'),
      '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n) ELSE (\r\n  node  "%~dp0\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n)\r\n',
    );

    const invocation = await resolveInvocation('legacy', ['install'], winPlatform([dir]));
    assert.equal(invocation.command, FAKE_NODE);
    assert.equal(invocation.args[0], join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    assert.deepEqual([...invocation.args.slice(1)], ['install']);
  });

  it('refuses a batch file it cannot see through, rather than spawning a shell', async () => {
    await writeFile(join(dir, 'deploy.bat'), '@echo off\r\ndel /q "%1"\r\n');

    await assert.rejects(
      () => resolveInvocation('deploy', [], winPlatform([dir])),
      (error: unknown) => {
        assert.ok(error instanceof RelayError);
        assert.equal(error.code, 'BATCH_SHIM_UNSUPPORTED');
        assert.match(error.hint ?? '', /never spawns through a shell/);
        return true;
      },
    );
  });

  it('refuses a shim that wraps something other than node', async () => {
    await writeFile(
      join(dir, 'pytool.cmd'),
      [
        '@ECHO off',
        'SETLOCAL',
        'SET "_prog=python3"',
        '"%_prog%"  "%dp0%\\pytool.py" %*',
        '',
      ].join('\r\n'),
    );

    await assert.rejects(
      () => resolveInvocation('pytool', [], winPlatform([dir])),
      (error: unknown) => error instanceof RelayError && error.code === 'BATCH_SHIM_UNSUPPORTED',
    );
  });

  it('refuses a shim whose wrapped script does not exist', async () => {
    await writeFile(join(dir, 'ghost.cmd'), '"%_prog%"  "%dp0%\\nowhere\\ghost.js" %*\r\nSET "_prog=node"\r\n');
    await assert.rejects(
      () => resolveInvocation('ghost', [], winPlatform([dir])),
      (error: unknown) => error instanceof RelayError && error.code === 'BATCH_SHIM_UNSUPPORTED',
    );
  });

  it('is the identity on POSIX', async () => {
    const invocation = await resolveInvocation('git', ['status'], posixPlatform([dir]));
    assert.equal(invocation.command, 'git');
    assert.deepEqual([...invocation.args], ['status']);
  });
});

describe('line splitting', () => {
  it('buffers partial lines until a newline arrives', () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    splitter.push('{"a":1}\n{"b"');
    assert.deepEqual(lines, ['{"a":1}']);
    splitter.push(':2}\n');
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  });

  it('emits a trailing line without a newline on flush', () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    splitter.push('no newline');
    splitter.flush();
    assert.deepEqual(lines, ['no newline']);
  });

  it('strips carriage returns', () => {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line));
    splitter.push('value\r\n');
    assert.deepEqual(lines, ['value']);
  });

  it('ignores non-JSON banner lines', () => {
    assert.equal(parseJsonLine('Reading additional input from stdin...'), undefined);
    assert.equal(parseJsonLine('[1,2,3]'), undefined);
    assert.deepEqual(parseJsonLine('{"type":"x"}'), { type: 'x' });
  });
});
