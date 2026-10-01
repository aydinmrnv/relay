import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { buildProgram } from '../dist/cli/program.js';
import { generateManPage } from '../dist/cli/man/generate.js';

// The page says which release it documents, read from the manifest being
// packed rather than typed here, so it cannot fall behind it.
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

await mkdir(new URL('../man/', import.meta.url), { recursive: true });
await writeFile(new URL('../man/relay.1', import.meta.url), generateManPage(buildProgram(version), { version }));
