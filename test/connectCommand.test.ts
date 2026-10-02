import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `relay connect --json`, as a program reading its stdout sees it (CLOUD-10).
 *
 * The pairing link holds the token a studio presents, so it must not be in a
 * line that goes to another program and its logs; and a studio on this
 * machine is listed as allowed only when development is switched on, which is
 * when the companion answers one.
 */

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts');
const windows = process.platform === 'win32';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

interface Listening {
  type: string;
  port: number;
  origins: string[];
  [key: string]: unknown;
}

async function listen(env: Record<string, string>, args: string[] = []): Promise<{ line: Listening; raw: string; secret: string; stop: (signal?: NodeJS.Signals) => Promise<number | null> }> {
  const home = await mkdtemp(join(tmpdir(), 'relay-connect-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', ENTRY, 'connect', '--json', '--no-open', '--port', String(port), ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, RELAY_HOME: join(home, '.relay'), NO_COLOR: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let raw = '';
  const line = await new Promise<Listening>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`relay connect printed no listening line. stdout so far: ${raw}`)), 20_000);
    child.stdout.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
      for (const text of raw.split('\n')) {
        if (!text.includes('"listening"')) continue;
        try {
          const parsed = JSON.parse(text) as Listening;
          clearTimeout(timer);
          resolve(parsed);
          return;
        } catch {
          // A partial line: the rest arrives with the next chunk.
        }
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`relay connect exited with ${code} before listening. stdout: ${raw}`));
    });
  });
  const stop = (signal: NodeJS.Signals = 'SIGTERM'): Promise<number | null> =>
    new Promise((resolve) => {
      child.once('exit', (code) => {
        void rm(home, { recursive: true, force: true }).then(() => resolve(code));
      });
      child.kill(signal);
    });
  const secret = await readFile(join(home, '.relay', 'studio.json'), 'utf8').catch(() => '');
  return { line, raw, secret, stop };
}

describe('relay connect --json', { skip: windows ? 'signals end the process differently on Windows' : false }, () => {
  it('does not print the pairing link, its token, or the machine secret', async () => {
    const companion = await listen({});
    try {
      assert.equal(companion.line.type, 'listening');
      assert.ok(!('pairUrl' in companion.line), 'the pairing link is not in the line');
      assert.doesNotMatch(companion.raw, /token=/, 'no token in a fragment or anywhere else');
      const saved = (JSON.parse(companion.secret || '{}') as { token?: string }).token;
      if (saved !== undefined) assert.ok(!companion.raw.includes(saved), 'the machine secret is not printed');
    } finally {
      assert.equal(await companion.stop(), 0, 'SIGTERM stops it cleanly');
    }
  });

  it('lists a studio on this machine only in development', async () => {
    const hosted = await listen({ RELAY_STUDIO_DEV: '' });
    try {
      assert.ok(!hosted.line.origins.some((origin) => /localhost|127\.0\.0\.1/.test(origin)), `no local origin: ${hosted.line.origins.join(', ')}`);
    } finally {
      await hosted.stop();
    }
    const dev = await listen({ RELAY_STUDIO_DEV: '1' });
    try {
      assert.ok(dev.line.origins.includes('http://localhost:3000'));
    } finally {
      await dev.stop();
    }
  });

  it('stops when its terminal goes away', async () => {
    const companion = await listen({});
    const port = companion.line.port;
    const before = await fetch(`http://127.0.0.1:${port}/v1/hello`).then((response) => response.status);
    assert.equal(before, 200);
    // What a closed terminal sends. Unhandled, it would kill the process with runs still going.
    assert.equal(await companion.stop('SIGHUP'), 0);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/hello`, { signal: AbortSignal.timeout(2_000) }));
  });
});
