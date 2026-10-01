#!/usr/bin/env node
// Thin launcher. Prefers the compiled build, which is what an installed package
// has and what runs on every supported Node (>= 22.6). A checkout with no build
// falls back to running the TypeScript sources directly, which needs a Node
// that strips types without being asked to: 22.18 or newer.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const compiled = join(here, '..', 'dist', 'index.js');
const sources = join(here, '..', 'src', 'index.ts');

const entry = existsSync(compiled) ? compiled : sources;

try {
  await import(entry);
} catch (error) {
  if (entry === sources && error && error.code === 'ERR_UNKNOWN_FILE_EXTENSION') {
    process.stderr.write(
      'relay: no compiled build found, and this Node version cannot run TypeScript sources directly.\n' +
        `Run \`npm run build\` inside the relay checkout, or use Node 22.18 or newer (this is ${process.version}).\n`,
    );
    process.exit(1);
  }
  throw error;
}
