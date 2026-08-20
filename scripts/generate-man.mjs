import { mkdir, writeFile } from 'node:fs/promises';
import { buildProgram } from '../dist/cli/program.js';
import { generateManPage } from '../dist/cli/man/generate.js';

await mkdir(new URL('../man/', import.meta.url), { recursive: true });
await writeFile(new URL('../man/relay.1', import.meta.url), generateManPage(buildProgram('unknown')));
