import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { relayDir } from '../storage/config.ts';
import { shortId } from '../util/ids.ts';
import { RelayError } from '../util/errors.ts';

interface LockRecord { token: string; pid: number; runId?: string; at: string }
export interface LockHandle { path: string; release(): Promise<void> }

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

const delay = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new Error('Aborted'));
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('Aborted')); }, { once: true });
});

async function readRecord(path: string): Promise<LockRecord | undefined | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<LockRecord>;
    return typeof value.token === 'string' && Number.isInteger(value.pid) && typeof value.at === 'string' ? value as LockRecord : null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null;
  }
}

export async function acquireLock(
  repoRoot: string,
  name: string,
  options: { signal?: AbortSignal; timeoutMs?: number; runId?: string } = {},
): Promise<LockHandle> {
  const path = join(relayDir(repoRoot), `${name}.lock`);
  const record: LockRecord = { token: shortId(), pid: process.pid, ...(options.runId ? { runId: options.runId } : {}), at: new Date().toISOString() };
  const tmp = `${path}.${record.token}.tmp`;
  const started = Date.now();
  await mkdir(relayDir(repoRoot), { recursive: true });
  await writeFile(tmp, JSON.stringify(record), { flag: 'wx' });
  try {
    for (;;) {
      if (options.timeoutMs !== undefined && Date.now() - started >= options.timeoutMs) {
        throw new RelayError(`Timed out waiting for repository ${name} lock.`, { code: 'LOCK_TIMEOUT' });
      }
      try { await link(tmp, path); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const holder = await readRecord(path);
        if (holder !== undefined && holder !== null && !alive(holder.pid)) {
          const confirmed = await readRecord(path);
          if (confirmed !== null && confirmed !== undefined && JSON.stringify(confirmed) === JSON.stringify(holder)) {
            try { await unlink(path); } catch (unlinkError) { if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError; }
            continue;
          }
        }
        await delay(50, options.signal);
      }
    }
  } finally { await unlink(tmp).catch(() => undefined); }

  return { path, async release() { const current = await readRecord(path); if (current?.token === record.token) await unlink(path).catch(() => undefined); } };
}
