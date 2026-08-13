import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireLock } from '../src/git/lock.ts';

test('repository lock serializes holders and reclaims a dead pid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-lock-'));
  const first = await acquireLock(root, 'delivery');
  const waiting = acquireLock(root, 'delivery', { timeoutMs: 1000 });
  await new Promise((resolve) => setTimeout(resolve, 75));
  await first.release();
  const second = await waiting;
  assert.equal(JSON.parse(await readFile(second.path, 'utf8')).pid, process.pid);
  await second.release();

  await writeFile(join(root, '.relay', 'delivery.lock'), JSON.stringify({ token: 'dead', pid: 99999999, at: new Date().toISOString() }));
  const recovered = await acquireLock(root, 'delivery', { timeoutMs: 1000 });
  await recovered.release();
});
