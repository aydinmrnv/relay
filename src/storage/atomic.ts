import { mkdir, writeFile, readFile, open } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';

import { replaceFile } from '../util/fs.ts';
import { shortId } from '../util/ids.ts';

/**
 * Writes via a temporary file in the same directory, then renames. Rename is
 * atomic within a filesystem, so an interrupted Relay leaves either the old
 * state or the new one — never a half-written `state.json`.
 *
 * The replace is where Windows differs: it cannot overwrite a file another
 * process has open, and `state.json` is read by every `relay watch` and
 * `relay status` while the engine writes it. `replaceFile` waits that out.
 */
export async function atomicWriteFile(path: string, contents: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });

  const tempPath = join(dir, `.${basename(path)}.${shortId(8)}.tmp`);
  const handle = await open(tempPath, 'w');
  try {
    await handle.writeFile(contents, 'utf8');
    // Flush to disk before the rename so a crash cannot leave a renamed but
    // empty file behind.
    await handle.sync();
  } finally {
    await handle.close();
  }
  await replaceFile(tempPath, path);
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Append-only writes for the event log; no read-modify-write to corrupt. */
export async function appendLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${line}\n`, { encoding: 'utf8', flag: 'a' });
}
