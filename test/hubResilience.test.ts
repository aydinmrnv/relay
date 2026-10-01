import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { keepServing } from '../src/cli/commands/hub.ts';
import { FrameError, parseHubFrame, parseRunnerFrame } from '../src/cloud/frames.ts';
import { mintRunnerToken } from '../src/cloud/hub/auth.ts';
import { Fleet } from '../src/cloud/hub/fleet.ts';
import { createHub, StaticVerifier, type Hub, type HubLogEntry } from '../src/cloud/hub/server.ts';
import { parseRequestTarget } from '../src/studio/router.ts';
import { StudioRuns } from '../src/studio/runs.ts';
import { createCompanion } from '../src/studio/server.ts';

/**
 * Nothing a caller sends may take the hub down (B-12, CLOUD-01).
 *
 * Every test here sends something the hub used to die on, and then asks the
 * same hub a plain question. node:test fails a test on an unhandled rejection
 * or an uncaught exception in this process, so "the process survived" is
 * checked twice: by the question, and by the runner itself.
 */

const SECRET = 'hub-secret-'.padEnd(48, 'x');
const STUDIO_TOKEN = 'studio-token-0123456789';
const ADMIN_TOKEN = 'admin-token-0123456789';
const USER = 'user_test';
const ORIGIN = 'https://studio.example';

/** One raw HTTP exchange, for request lines `fetch` would tidy up before sending. */
function raw(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let answer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (answer += chunk));
    socket.on('error', reject);
    socket.on('close', () => resolve(answer));
    socket.on('connect', () => socket.write(request));
    setTimeout(() => socket.destroy(), 3_000).unref();
  });
}

function statusOf(answer: string): number {
  return Number(answer.match(/^HTTP\/1\.1 (\d{3})/)?.[1] ?? 0);
}

describe('the hub, sent things it cannot read', () => {
  let hub: Hub;
  let base: string;
  let port: number;
  const logs: HubLogEntry[] = [];

  const alive = async (): Promise<void> => {
    const response = await fetch(`${base}/healthz`);
    assert.equal(response.status, 200, 'the hub still answers');
  };

  const runnerSocket = (): WebSocket =>
    new WebSocket(`${base.replace('http:', 'ws:')}/v1/runner/connect`, { headers: { authorization: `Bearer ${mintRunnerToken(SECRET, { runner: 'relay-test', userId: USER })}` } } as unknown as string[]);

  /** Opens a runner connection, sends the frames, and resolves with the close code. */
  async function closeCodeAfter(frames: string[]): Promise<number> {
    const ws = runnerSocket();
    const closed = new Promise<number>((resolve) => ws.addEventListener('close', (event) => resolve(event.code)));
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', () => reject(new Error('the hub refused the runner')));
    });
    for (const frame of frames) ws.send(frame);
    const giveUp = setTimeout(() => ws.close(), 4_000);
    try {
      return await closed;
    } finally {
      clearTimeout(giveUp);
    }
  }

  const HELLO = JSON.stringify({ t: 'hello', hello: { product: 'relay', protocol: 1, authorized: true, capabilities: ['agents'] }, activity: { runs: 0, queued: 0, logins: 0 } });

  before(async () => {
    const fleet = new Fleet({ driver: null, regions: [], coresPerRunner: 2, tokenFor: () => '' });
    hub = createHub({
      fleet,
      secret: SECRET,
      sessions: new StaticVerifier([[STUDIO_TOKEN, USER]]),
      origins: [ORIGIN],
      version: 'test',
      adminToken: ADMIN_TOKEN,
      log: (entry) => logs.push(entry),
    });
    port = await hub.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await hub.close();
  });

  it('answers 400 to `GET //` and to other request lines that are not a path', async () => {
    for (const target of ['//', '//admin/v1/fleet', '/\\evil/v1/hello', 'http://elsewhere.example/v1/hello']) {
      const answer = await raw(port, `GET ${target} HTTP/1.1\r\nHost: hub\r\nConnection: close\r\n\r\n`);
      assert.equal(statusOf(answer), 400, target);
      assert.match(answer, /not a path/);
    }
    await alive();
  });

  it('answers 400 to an upgrade on a path it cannot read, and 404 to one on the wrong path', async () => {
    const upgrade = (target: string) =>
      raw(port, `GET ${target} HTTP/1.1\r\nHost: hub\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    assert.equal(statusOf(await upgrade('//')), 400);
    assert.equal(statusOf(await upgrade('/nope')), 404);
    await alive();
  });

  it('answers 400 to percent-encoding that is not, on the studio routes and the operator routes', async () => {
    const studio = await fetch(`${base}/v1/runs/%zz/events`, { headers: { authorization: `Bearer ${STUDIO_TOKEN}` } });
    assert.equal(studio.status, 400);
    const admin = await fetch(`${base}/admin/v1/runners/%zz`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    assert.equal(admin.status, 400);
    const nullBody = await fetch(`${base}/admin/v1/tokens`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' }, body: 'null' });
    assert.equal(nullBody.status, 400);
    assert.equal((await fetch(`${base}/v1/agents`, { method: 'PUT', headers: { authorization: `Bearer ${STUDIO_TOKEN}` } })).status, 405);
    await alive();
  });

  it('closes a runner that sends a malformed frame, and only that runner', async () => {
    const malformed = [
      'not json',
      'null',
      '[]',
      '{"t":"hello"}',
      '{"t":"hello","hello":null,"activity":{"runs":0,"queued":0,"logins":0}}',
      '{"t":"hello","hello":{"product":"relay","protocol":1},"activity":{"runs":"many"}}',
    ];
    for (const frame of malformed) {
      assert.equal(await closeCodeAfter([frame]), 1007, frame);
      await alive();
    }
    // The same, once greeted: these used to be read field by field, with nothing there.
    for (const frame of ['{"t":"activity"}', '{"t":"activity","activity":{"runs":-1,"queued":0,"logins":0}}', '{"t":"record","id":"x"}', '{"t":"record","id":"x","record":{"seq":0,"type":"exit","code":"0","error":null}}', '{"t":"res","id":"x","status":"teapot"}', '{"t":"res","id":"x","status":99}', '{"t":"res","status":200}']) {
      assert.equal(await closeCodeAfter([HELLO, frame]), 1007, frame);
      await alive();
    }
    assert.ok(logs.some((entry) => entry.msg === 'closed a runner that sent a malformed frame'));
    assert.ok(!logs.some((entry) => entry.level === 'error'), 'nothing was an unexpected failure');
  });

  it('ignores a frame type it does not know, so a newer runner is not cut off', async () => {
    const ws = runnerSocket();
    const welcomed = new Promise<string>((resolve) => ws.addEventListener('message', (event) => resolve(String(event.data))));
    await new Promise((resolve) => ws.addEventListener('open', resolve));
    ws.send('{"t":"something-from-the-future","value":1}');
    ws.send(HELLO);
    assert.deepEqual(JSON.parse(await welcomed), { t: 'welcome', runner: 'relay-test' });
    const closed = new Promise((resolve) => ws.addEventListener('close', resolve));
    ws.close(1000, 'done');
    await closed;
    await alive();
  });
});

describe('reading a request line and a frame', () => {
  it('takes a plain path and refuses anything that names another host or cannot be parsed', () => {
    assert.equal(parseRequestTarget('/v1/hello?x=1')?.pathname, '/v1/hello');
    assert.equal(parseRequestTarget('/v1/../admin/v1/fleet')?.pathname, '/admin/v1/fleet');
    assert.equal(parseRequestTarget(undefined)?.pathname, '/');
    for (const bad of ['//', '//x/y', '/\\x', 'http://x/y', 'http://[']) assert.equal(parseRequestTarget(bad), null, bad);
  });

  it('rebuilds a greeting from its fields, keeping only what has the type it claims', () => {
    const frame = parseRunnerFrame(
      JSON.stringify({
        t: 'hello',
        hello: { product: 'relay', protocol: 1, authorized: false, version: '0.1.0', machine: 42, capabilities: ['agents', 7, 'runs'], repository: 'nope', extra: { nested: true } },
        activity: { runs: 1, queued: 0, logins: 2, more: 'ignored' },
      }),
    );
    assert.deepEqual(frame, {
      t: 'hello',
      hello: { product: 'relay', protocol: 1, authorized: true, version: '0.1.0', capabilities: ['agents', 'runs'], repository: null },
      activity: { runs: 1, queued: 0, logins: 2 },
    });
  });

  it('returns null for an unknown type and throws for a known one with the wrong shape', () => {
    assert.equal(parseRunnerFrame('{"t":"later"}'), null);
    assert.equal(parseHubFrame('{"t":"later"}'), null);
    assert.deepEqual(parseRunnerFrame('{"t":"res","id":"a","status":200,"stream":true}'), { t: 'res', id: 'a', status: 200, stream: true });
    assert.deepEqual(parseRunnerFrame('{"t":"record","id":"a","record":{"seq":3,"type":"engine","data":{"type":"note"}}}'), { t: 'record', id: 'a', record: { seq: 3, type: 'engine', data: { type: 'note' } } });
    assert.deepEqual(parseHubFrame('{"t":"req","id":"a","method":"GET","url":"/v1/agents"}'), { t: 'req', id: 'a', method: 'GET', url: '/v1/agents' });
    for (const bad of ['{"t":"res","id":"","status":200}', `{"t":"res","id":"${'x'.repeat(65)}","status":200}`, '{"t":"record","id":"a","record":{"seq":1.5,"type":"ping"}}', '{"t":"record","id":"a","record":{"seq":1,"type":"engine","data":[]}}']) {
      assert.throws(() => parseRunnerFrame(bad), FrameError, bad);
    }
    for (const bad of ['{"t":"req","id":"a","method":7,"url":"/x"}', '{"t":"req","id":"a","method":"GET"}', '{"t":"unfollow"}', '"text"']) {
      assert.throws(() => parseHubFrame(bad), FrameError, bad);
    }
  });
});

describe('the companion, sent things it cannot read', () => {
  it('answers 400, not 500, to a `null` JSON body and to a path it cannot read', async () => {
    const events: string[] = [];
    const companion = createCompanion({
      token: 'secret-token',
      origins: ['https://studio.example'],
      version: 'test',
      repository: { root: tmpdir(), owner: 'acme', name: 'api', defaultBranch: 'main' },
      // Never started: it is here so the companion offers `install`, which needs somewhere to run.
      runs: new StudioRuns(tmpdir(), { command: process.execPath, args: [] }),
      installFiles: async () => {
        throw new Error('reached the installer');
      },
      log: (event) => events.push(`${event.kind}: ${event.message}`),
    });
    const port = await companion.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const headers = { authorization: 'Bearer secret-token', 'content-type': 'application/json' };
    try {
      for (const path of ['/v1/install', '/v1/logins/abc/code', '/v1/agents/claude/login']) {
        for (const body of ['null', '[]', '"text"', '7']) {
          const response = await fetch(`${base}${path}`, { method: 'POST', headers, body });
          assert.equal(response.status, 400, `${path} ${body}`);
          assert.match(((await response.json()) as { error: string }).error, /JSON object/);
        }
      }
      const answer = await raw(port, `GET // HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer secret-token\r\nConnection: close\r\n\r\n`);
      assert.equal(statusOf(answer), 400);
      assert.deepEqual(events.filter((event) => event.startsWith('error')), [], 'none of it was an unexpected failure');
      assert.equal((await fetch(`${base}/v1/hello`)).status, 200);
    } finally {
      await companion.close();
    }
  });
});

describe('an error nothing caught', () => {
  it('is logged with its stack, and the handlers come off again', () => {
    const target = new EventEmitter();
    const logs: HubLogEntry[] = [];
    const stop = keepServing((entry) => logs.push(entry), target as unknown as NodeJS.Process);
    target.emit('unhandledRejection', new Error('boom'), Promise.resolve());
    target.emit('uncaughtException', new Error('bang'), 'uncaughtException');
    target.emit('unhandledRejection', 'a string', Promise.resolve());
    assert.deepEqual(logs.map((entry) => [entry.level, entry.msg, entry['error']]), [
      ['error', 'unhandled rejection; the hub keeps serving', 'boom'],
      ['error', 'uncaught exception; the hub keeps serving', 'bang'],
      ['error', 'unhandled rejection; the hub keeps serving', 'a string'],
    ]);
    assert.match(String(logs[0]?.['stack']), /Error: boom/);
    stop();
    assert.equal(target.listenerCount('unhandledRejection') + target.listenerCount('uncaughtException'), 0);
  });

  it('does not end the process: a real one, with a real rejection and a real throw', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relay-keep-serving-'));
    const script = join(dir, 'main.mjs');
    const module = new URL('../src/cli/commands/hub.ts', import.meta.url).href;
    await writeFile(
      script,
      `import { keepServing } from ${JSON.stringify(module)};
keepServing((entry) => console.log(entry.msg + ': ' + entry.error));
Promise.reject(new Error('boom'));
setTimeout(() => { throw new Error('bang'); }, 20);
setTimeout(() => { console.log('still serving'); process.exit(0); }, 250);
`,
    );
    try {
      const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += String(chunk)));
      child.stderr.on('data', (chunk: Buffer) => (stderr += String(chunk)));
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
      assert.equal(code, 0, stderr);
      assert.deepEqual(stdout.trim().split(/\r?\n/), ['unhandled rejection; the hub keeps serving: boom', 'uncaught exception; the hub keeps serving: bang', 'still serving']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
