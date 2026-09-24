import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

import type { InstallFile, InstallResponse } from './protocol.ts';

/**
 * Writes a studio export into the repository, where the zip would have put it.
 *
 * Only text the export produces, only inside the repository, never under
 * `.git`: a path is checked segment by segment before it is joined, and the
 * directory it lands in is checked again after symlinks are resolved.
 *
 * `.relay/config.json` is merged rather than replaced. The canvas describes
 * the pipeline, the guardrails and delivery; it says nothing about the
 * repository's tracker, its harnesses or its test command, and installing a
 * workflow must not quietly reset what `relay init` or a person wrote there.
 */

const MAX_FILES = 20;
const MAX_BYTES = 1_000_000;
const EXTENSIONS = ['.json', '.yml', '.yaml', '.md'];
const CONFIG_PATH = '.relay/config.json';

export class InstallError extends Error {}

export function checkInstallPath(path: unknown): string[] {
  if (typeof path !== 'string' || path.length === 0 || path.length > 200) throw new InstallError('Every file needs a path under 200 characters.');
  if (path.includes('\\') || path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw new InstallError(`"${path}" is not a path relative to the repository.`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new InstallError(`"${path}" leaves the repository or names nothing.`);
  }
  if (segments[0]?.toLowerCase() === '.git') throw new InstallError(`"${path}" is inside .git, which an export never writes to.`);
  if (!EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension))) {
    throw new InstallError(`"${path}" is not a file an export produces (${EXTENSIONS.join(', ')}).`);
  }
  return segments;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const existing = out[key];
    out[key] = isRecord(existing) && isRecord(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

/**
 * The studio's config over the repository's. Two sections are the
 * repository's unless the workflow actually says something: a null test
 * command means "the canvas did not name one", and of the notification
 * settings the canvas only ever describes the webhook.
 */
export function mergeInstalledConfig(existing: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const over: Record<string, unknown> = { ...incoming };
  const tests = incoming['tests'];
  if (isRecord(tests) && (tests['command'] === null || tests['command'] === undefined)) {
    const rest = { ...tests };
    delete rest['command'];
    over['tests'] = rest;
  }
  const notify = incoming['notify'];
  if (isRecord(notify)) {
    if (typeof notify['webhook'] === 'string' && notify['webhook'].length > 0) over['notify'] = { webhook: notify['webhook'] };
    else delete over['notify'];
  }
  return deepMerge(existing, over);
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function installFiles(root: string, files: unknown): Promise<InstallResponse> {
  if (!Array.isArray(files) || files.length === 0) throw new InstallError('There are no files to install.');
  if (files.length > MAX_FILES) throw new InstallError(`An export has at most ${MAX_FILES} files.`);

  // Everything is checked before anything is written: half an install is worse than none.
  const checked = files.map((file: unknown) => {
    const entry = (file ?? {}) as Partial<InstallFile>;
    const segments = checkInstallPath(entry.path);
    if (typeof entry.content !== 'string') throw new InstallError(`"${String(entry.path)}" has no content.`);
    if (Buffer.byteLength(entry.content) > MAX_BYTES) throw new InstallError(`"${String(entry.path)}" is larger than an export ever is.`);
    if (entry.path === CONFIG_PATH) {
      try {
        if (!isRecord(JSON.parse(entry.content))) throw new Error('not an object');
      } catch {
        throw new InstallError(`${CONFIG_PATH} from the studio is not a JSON object.`);
      }
    }
    return { path: entry.path as string, segments, content: entry.content };
  });

  const realRoot = await realpath(root);
  const results: InstallResponse['files'] = [];
  for (const file of checked) {
    const target = join(realRoot, ...file.segments);
    await mkdir(dirname(target), { recursive: true });
    const parent = await realpath(dirname(target));
    if (parent !== realRoot && !parent.startsWith(realRoot + sep)) {
      throw new InstallError(`"${file.path}" resolves outside the repository through a symlink.`);
    }

    const before = await readText(target);
    let content = file.content;
    if (file.path === CONFIG_PATH && before !== null) {
      try {
        const existing: unknown = JSON.parse(before);
        if (isRecord(existing)) content = JSON.stringify(mergeInstalledConfig(existing, JSON.parse(file.content) as Record<string, unknown>), null, 2) + '\n';
      } catch {
        // An unreadable config is replaced: the engine would refuse it anyway.
      }
    }

    if (before === content) {
      results.push({ path: file.path, status: 'unchanged' });
      continue;
    }
    const temp = `${target}.relay-${process.pid}.tmp`;
    await writeFile(temp, content);
    await rename(temp, target);
    results.push({ path: file.path, status: before === null ? 'created' : 'updated' });
  }
  return { root, files: results };
}
