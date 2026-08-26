#!/usr/bin/env node
/**
 * A coding CLI that always says the same thing.
 *
 * The end-to-end test of the unattended path has to drive a whole run —
 * planning, plan review, implementation, code review, tests, delivery — without
 * a model, a network or a credential anywhere in CI. This is the CLI that makes
 * that possible: it plugs in through the config-harness seam (`harnesses` in
 * .relay/config.json), reads a prompt on stdin, and writes one JSON object per
 * line on stdout, exactly like the real ones.
 *
 * It decides which turn it is being asked for from the prompt itself, which is
 * the only signal a real CLI gets either. Nothing about the pipeline is stubbed
 * out — every phase runs, the reviewers really do run read-only, the diff is a
 * real diff, and the tests are a real test command.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const readOnly = process.argv.includes('--read-only');

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdin += chunk;
});
process.stdin.on('end', () => {
  // Every turn is recorded, so the verifier can assert that the reviewers ran
  // read-only and that the pipeline really did take every phase.
  const log = process.env.RELAY_FIXTURE_AGENT_LOG;
  if (log !== undefined) {
    mkdirSync(dirname(log), { recursive: true });
    appendFileSync(log, `${JSON.stringify({ readOnly, turn: turnOf(stdin) })}\n`, 'utf8');
  }

  const turn = turnOf(stdin);
  const text =
    turn === 'implement'
      ? implement()
      : turn === 'inline'
        ? `${plan()}\n\n${implement()}`
        : turn === 'review'
          ? review()
          : plan();

  emit({ session_id: `fixture-${turn}`, message: text, usage: { input_tokens: 1200, output_tokens: 300, cost_usd: 0.01 } });
  process.exit(0);
});

function emit(line) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/** Which turn this is, from what the prompt asks for. */
function turnOf(prompt) {
  // Checked most specific first: the inline prompt asks for a plan *and* an
  // implementation, and matching it on the plan marker alone would produce a
  // turn that wrote nothing — which is exactly the bug this ordering avoids.
  if (prompt.includes('Task: implement the approved plan')) return 'implement';
  if (prompt.includes('plan this issue and implement it')) return 'inline';
  if (prompt.includes('===RELAY:BEGIN REVIEW===')) return 'review';
  if (prompt.includes('===RELAY:BEGIN PLAN===')) return 'plan';
  // A priming turn: speculative reading with nothing required of it.
  return 'prime';
}

function plan() {
  return [
    '===RELAY:BEGIN PLAN===',
    '## Approach',
    '',
    'Add the greeting helper the issue asks for, and a test that proves it.',
    '',
    '## Files',
    '',
    '- `src/greet.js` — the helper.',
    '- `test/greet.test.js` — the test.',
    '',
    '## Risks',
    '',
    'None: the module is new and nothing imports it yet.',
    '===RELAY:END PLAN===',
  ].join('\n');
}

function review() {
  return [
    'Nothing here needs changing.',
    '',
    '===RELAY:BEGIN REVIEW===',
    JSON.stringify({ decision: 'approve', summary: 'The change matches the plan and is covered by a test.', findings: [] }),
    '===RELAY:END REVIEW===',
  ].join('\n');
}

/**
 * The one turn that writes. It is a real edit to a real worktree: git sees it,
 * the diff is genuine, and the test command that runs afterwards runs against
 * what this wrote.
 */
function implement() {
  if (readOnly) {
    return 'I was asked to implement, but I am running read-only, so I changed nothing.';
  }
  const cwd = process.cwd();
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'test'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'greet.js'), 'export function greet(name) {\n  return `Hello, ${name}!`;\n}\n', 'utf8');
  writeFileSync(
    join(cwd, 'test', 'greet.test.js'),
    [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "import { greet } from '../src/greet.js';",
      '',
      "test('greets by name', () => {",
      "  assert.equal(greet('world'), 'Hello, world!');",
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  // Prove the worktree really is a checkout of the fixture repository: reading
  // a file that only exists there would fail loudly if it were not.
  readFileSync(join(cwd, 'package.json'), 'utf8');

  return [
    '===RELAY:BEGIN NOTES===',
    '- Added `src/greet.js` with the helper from the plan.',
    '- Added `test/greet.test.js` covering it.',
    '- No deviations.',
    '===RELAY:END NOTES===',
  ].join('\n');
}
