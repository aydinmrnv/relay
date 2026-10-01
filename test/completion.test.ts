import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProgram } from '../src/cli/program.ts';
import { completionCandidates, EMPTY_WORD } from '../src/cli/completion/complete.ts';
import { COMPLETION_SHELLS, generateCompletion } from '../src/cli/completion/generate.ts';
import { AGENT_PROVIDERS } from '../src/agents/index.ts';
import { DELIVERY_POLICIES, MERGE_METHODS } from '../src/storage/config.ts';
import { createTempRepo } from './helpers/tempRepo.ts';

async function dispatchCompletion(words: string[]): Promise<string> {
  let output = '';
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await buildProgram('test').parseAsync(['node', 'relay', '__complete', ...words]);
  } finally {
    process.stdout.write = original;
  }
  return output;
}

test('generates non-empty completion scripts from the command tree', () => {
  const program = buildProgram('test');
  for (const shell of COMPLETION_SHELLS) {
    const script = generateCompletion(program, shell);
    assert.match(script, /relay __complete/);
    assert.match(script, /completion/);
  }
});

// Windows ships none of bash, zsh or fish, so a PowerShell script is the whole
// of shell completion there. It has to route through the same `__complete`
// dispatch as the others rather than hard-coding a command list that drifts.
test('completes through the shell Windows actually has', () => {
  const script = generateCompletion(buildProgram('test'), 'powershell');
  assert.match(script, /Register-ArgumentCompleter -Native -CommandName relay/);
  assert.match(script, /relay __complete @words/);
  assert.match(script, /CompletionResult/);
  // Never a bare '': PowerShell drops empty arguments to a native command.
  assert.ok(script.includes(`$words += '${EMPTY_WORD}'`), script);
});

// The word being completed is empty whenever the cursor sits on a fresh one,
// and that is the case with the most to say — every branch, every run. The
// PowerShell script cannot send an empty argument, so it sends this instead
// and the two spellings have to mean the same thing here.
test('reads the empty-word stand-in as an empty word', async () => {
  const program = buildProgram('test');
  assert.deepEqual(
    await completionCandidates(program, ['run', '--planner', EMPTY_WORD]),
    await completionCandidates(program, ['run', '--planner', '']),
  );
  assert.deepEqual(await completionCandidates(program, ['run', '--deliver', EMPTY_WORD]), [...DELIVERY_POLICIES]);
});

for (const [shell, args] of [
  ['bash', ['-n']],
  ['zsh', ['-n']],
  ['fish', ['--no-execute']],
] as const) {
  test(`generated ${shell} script parses`, (context) => {
    const available = spawnSync(shell, ['--version'], { encoding: 'utf8' });
    if (available.error !== undefined) {
      context.skip(`${shell} is not installed; completion syntax was not checked`);
      return;
    }
    const result = spawnSync(shell, [...args], {
      input: generateCompletion(buildProgram('test'), shell), encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  });
}

// The Windows leg of CI is the only place this runs, and it is the only place
// the script is ever used, so a syntax error here reaches users unless it is
// caught there. `ParseFile` checks the script without registering the
// completer in the shell doing the checking.
test('generated powershell script parses', (context) => {
  const pwsh = spawnSync('pwsh', ['--version'], { encoding: 'utf8' });
  if (pwsh.error !== undefined) {
    context.skip('pwsh is not installed; completion syntax was not checked');
    return;
  }
  const path = join(mkdtempSync(join(tmpdir(), 'relay-completion-')), 'relay.ps1');
  writeFileSync(path, generateCompletion(buildProgram('test'), 'powershell'));
  try {
    const result = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-Command',
        `$errors = $null
         [void][System.Management.Automation.Language.Parser]::ParseFile('${path}', [ref]$null, [ref]$errors)
         if ($errors.Count) { $errors | Out-String | Write-Error; exit 1 }`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test('classifies registry-backed option values and static options', async () => {
  const program = buildProgram('test');
  assert.deepEqual(await completionCandidates(program, ['run', '--planner', '']), [...AGENT_PROVIDERS]);
  assert.deepEqual(await completionCandidates(program, ['run', '--deliver=']), [...DELIVERY_POLICIES]);
  assert.deepEqual(await completionCandidates(program, ['run', '--merge-method', '']), [...MERGE_METHODS]);
  assert.ok((await completionCandidates(program, ['run', '--pla'])).includes('--planner'));
});

test('registered __complete preserves option/value order', { concurrency: false }, async () => {
  assert.equal(await dispatchCompletion(['run', '--planner', '']), `${AGENT_PROVIDERS.join('\n')}\n`);

  const repo = await createTempRepo();
  const previous = process.cwd();
  try {
    await repo.git('branch', 'maintenance');
    process.chdir(repo.root);
    assert.equal(await dispatchCompletion(['run', '--base', 'mai']), 'main\nmaintenance\n');
    assert.equal(await dispatchCompletion(['status', 'lat']), 'latest\n');
  } finally {
    process.chdir(previous);
    await repo.cleanup();
  }
});

// The first word is the only one the scripts answer without starting Relay,
// so what they offer there is asserted on its own: every command a person is
// shown, the root's flags, and nothing that is hidden.
test('offers commands and root flags for the first word, and nothing hidden', async () => {
  const program = buildProgram('test');
  const first = await completionCandidates(program, ['']);
  for (const name of ['connect', 'start', 'run', 'status', 'watch', 'serve', 'completion']) assert.ok(first.includes(name), name);
  for (const hidden of ['hub', 'help', '__complete', '__run-detached']) assert.ok(!first.includes(hidden), hidden);
  assert.deepEqual(await completionCandidates(program, []), first, 'no words at all is a fresh first word');
  assert.deepEqual(await completionCandidates(program, ['sta']), ['start', 'status', 'stats']);

  assert.deepEqual(await completionCandidates(program, ['--']), ['--version', '--update', '--json', '--help']);
  assert.deepEqual(await completionCandidates(program, ['--j']), ['--json']);

  for (const shell of ['bash', 'zsh', 'powershell'] as const) {
    const script = generateCompletion(program, shell);
    assert.match(script, /\bstatus\b.* --update --json --help/, `${shell} offers the root flags for the first word`);
    assert.doesNotMatch(script, /\bhub\b/, `${shell} does not advertise a hidden command`);
  }
});

// `relay hub` dispatches to commands of its own, and a hidden command is still
// one that can be completed into by somebody who typed its name.
test('completes the subcommands of a command that has them', async () => {
  const program = buildProgram('test');
  assert.deepEqual(await completionCandidates(program, ['hub', '']), ['serve', 'token']);
  assert.deepEqual(await completionCandidates(program, ['hub', 'to']), ['token']);
  assert.deepEqual(await completionCandidates(program, ['hub', 'token', '--']), ['--user', '--runner', '-h', '--help'].filter((flag) => flag.startsWith('--')));
  // A leaf command has none, so it is still asked for its own arguments.
  assert.deepEqual(await completionCandidates(program, ['run', '--planner', '']), [...AGENT_PROVIDERS]);
});

test('does not offer a flag that is hidden from the help', async () => {
  const program = buildProgram('test');
  assert.deepEqual(await completionCandidates(program, ['run', '--tu']), []);
  assert.ok((await completionCandidates(program, ['run', '--'])).includes('--prompt'));
  assert.ok((await completionCandidates(program, ['run', '--'])).includes('--help'));
});

/**
 * Runs the generated zsh function the way the shell would, against a `relay`
 * of the test's choosing, and returns what it handed to `compadd`.
 *
 * `compdef` and `compadd` only exist inside zsh's completion system, which a
 * non-interactive shell has not loaded. Standing in for the two of them is
 * all it takes to call `_relay` directly — with `words` and `CURRENT` set by
 * hand, exactly as the completion system sets them.
 */
function zshCompletes(relayStub: string, words: readonly string[]): { status: number | null; offered: string[]; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'relay-zsh-'));
  try {
    writeFileSync(join(dir, 'relay'), relayStub, { mode: 0o755 });
    const script = [
      'compdef() { : }',
      'compadd() { [[ "$1" == "--" ]] && shift; print -rl -- "$@" }',
      generateCompletion(buildProgram('test'), 'zsh'),
      `words=(${words.map((word) => `'${word}'`).join(' ')})`,
      `CURRENT=${words.length}`,
      '_relay',
    ].join('\n');
    const result = spawnSync('zsh', ['-f', '-c', script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env['PATH'] ?? ''}`, NODE_TEST_CONTEXT: undefined },
    });
    return { status: result.status, offered: result.stdout.split('\n').filter((line) => line.length > 0), stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function zshMissing(): string | false {
  return spawnSync('zsh', ['--version'], { encoding: 'utf8' }).error === undefined
    ? false
    : 'zsh is not installed; its completion was not exercised';
}

// The word under the cursor is empty whenever it is a fresh one, and unquoted
// zsh drops an empty word on its way to a command. Dropped, `relay status
// <TAB>` asked for runs named "status" and was offered nothing — so this
// checks the argument list Relay actually receives, not the script's text.
test('zsh hands relay the empty word a fresh completion is asking about', { skip: zshMissing() }, () => {
  const echo = '#!/bin/sh\nfor word in "$@"; do printf "<%s>\\n" "$word"; done\n';
  const fresh = zshCompletes(echo, ['relay', 'status', '']);
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.deepEqual(fresh.offered, ['<__complete>', '<status>', '<>']);

  const partial = zshCompletes(echo, ['relay', 'run', '--planner', 'cl']);
  assert.deepEqual(partial.offered, ['<__complete>', '<run>', '<--planner>', '<cl>']);
});

test('zsh completes a fresh word against the real command tree', { skip: zshMissing() }, () => {
  const entry = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts');
  const relay = `#!/bin/sh\nexec "${process.execPath}" --experimental-strip-types "${entry}" "$@"\n`;

  const subcommands = zshCompletes(relay, ['relay', 'hub', '']);
  assert.equal(subcommands.status, 0, subcommands.stderr);
  assert.deepEqual(subcommands.offered, ['serve', 'token']);

  assert.deepEqual(zshCompletes(relay, ['relay', 'run', '--planner', '']).offered, [...AGENT_PROVIDERS]);

  // The first word never reaches relay: the script answers it by itself.
  const first = zshCompletes('#!/bin/sh\nexit 1\n', ['relay', '']);
  assert.ok(first.offered.includes('run') && first.offered.includes('--json'), first.offered.join(' '));
  assert.ok(!first.offered.includes('hub'));
});
