import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
