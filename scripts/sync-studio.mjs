#!/usr/bin/env node
// Copies the files the engine and the studio must agree on into the studio.
//
// The two are separate packages: the CLI is built from `src/`, the studio is a
// Next.js app deployed from `web/`, and neither can import the other. What a
// Condition decides, and which steps a real run performs, has to be the same
// in both, so those files live in `src/graph/` and the studio holds a
// byte-for-byte copy. `npm run sync:studio` writes the copies; a test in each
// package fails when one has drifted (`--check` is what they run).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const SHARED = [
  ['src/graph/expression.ts', 'web/src/lib/workflow/engine/expression.ts'],
  ['src/graph/support.ts', 'web/src/lib/workflow/engine/support.ts'],
];

const check = process.argv.includes('--check');
let drifted = 0;
for (const [from, to] of SHARED) {
  const source = await readFile(join(root, from), 'utf8');
  const existing = await readFile(join(root, to), 'utf8').catch(() => null);
  if (existing === source) continue;
  if (check) {
    drifted += 1;
    console.error(`${to} differs from ${from}. Run: npm run sync:studio`);
    continue;
  }
  await mkdir(dirname(join(root, to)), { recursive: true });
  await writeFile(join(root, to), source);
  console.log(`${from} -> ${to}`);
}
if (check && drifted > 0) process.exitCode = 1;
