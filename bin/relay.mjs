#!/usr/bin/env node
// Thin launcher. Prefers the compiled build; falls back to running TypeScript
// sources directly on Node versions that support type stripping (>= 22.6).
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
      'relay: no compiled build found and this Node version cannot run TypeScript directly.\n' +
        'Run `npm run build` inside the relay checkout, or upgrade to Node >= 22.6.\n',
    );
    process.exit(1);
  }
  throw error;
}
