import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runProcess, resolveExecutable, describeFailure } from '../src/process/runner.ts';
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
