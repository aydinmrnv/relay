import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { buildProgram } from '../src/cli/program.ts';
import { completionCandidates } from '../src/cli/completion/complete.ts';
import { generateCompletion } from '../src/cli/completion/generate.ts';
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
  for (const shell of ['bash', 'zsh', 'fish'] as const) {
    const script = generateCompletion(program, shell);
    assert.match(script, /relay __complete/);
    assert.match(script, /completion/);
  }
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
