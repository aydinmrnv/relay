import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');

async function sources(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'fixtures') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sources(path)));
    else if (entry.name.endsWith('.ts') && path !== SELF) found.push(path);
  }
  return found;
}

/**
 * `engines` promises Node 22.6, whose type stripper is older than the one on
 * every developer's machine. `tsc` accepts these and so does a current Node;
 * 22.6.0 fails at parse time, in every file that imports the offender.
 */
const UNSTRIPPABLE: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /\b(?:let|var)\s+[A-Za-z_$][\w$]*!\s*[:;,]/, what: 'a definite-assignment assertion on a variable (`let x!: T`): initialise it instead' },
  { pattern: /^\s*(?:(?:private|public|protected|readonly|static|declare)\s+)*[A-Za-z_$][\w$]*!\s*:/, what: 'a definite-assignment assertion on a field (`x!: T`): initialise it instead' },
];

describe('syntax the oldest supported Node can run', () => {
  it('has nothing Node 22.6 cannot strip', async () => {
    const offences: string[] = [];
    for (const file of [...(await sources(join(ROOT, 'src'))), ...(await sources(join(ROOT, 'test')))]) {
      const lines = (await readFile(file, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        for (const { pattern, what } of UNSTRIPPABLE) {
          if (pattern.test(line)) offences.push(`${relative(ROOT, file)}:${index + 1}: ${what}`);
        }
      });
    }

    assert.deepEqual(offences, []);
  });
});
