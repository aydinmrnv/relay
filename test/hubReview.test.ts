import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mintRunnerToken } from '../src/cloud/hub/auth.ts';
import type { CloudDriver, CloudMachine, MachineSpec, RegionCapacity } from '../src/cloud/hub/driver.ts';
import { Fleet, runnerName, type FleetLink } from '../src/cloud/hub/fleet.ts';
import { createHub, type SessionVerifier } from '../src/cloud/hub/server.ts';

/**
 * Defects a review of the hardening found, each with the sequence that showed it.
 */

const SECRET = 's'.repeat(40);
const USER = 'user_1';
const NAME = runnerName('relay', USER);
const IDLE = { runs: 0, queued: 0, logins: 0 };
const POSIX = process.platform !== 'win32';
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A cloud that keeps what it is told, and can hold a `create` open until the test lets it land. */
class MemoryCloud implements CloudDriver {
  readonly machines = new Map<string, CloudMachine>();
  readonly calls: string[] = [];
  private gate: Promise<void> | null = null;

  holdCreate(until: Promise<void>): void {
    this.gate = until;
  }
  async list(): Promise<CloudMachine[]> {
    return [...this.machines.values()].map((machine) => ({ ...machine }));
  }
  async create(spec: MachineSpec): Promise<void> {
    this.calls.push(`create ${spec.name}`);
    if (this.gate !== null) await this.gate;
    this.machines.set(spec.name, { name: spec.name, userId: spec.userId, region: spec.region, power: 'running', provisioning: 'succeeded', createdAt: Date.now(), tokenId: spec.tokenId });
  }
  async rotateToken(machine: Pick<CloudMachine, 'name'>, token: { id: string }): Promise<void> {
    this.machines.get(machine.name)!.tokenId = token.id;
  }
  async start(machine: Pick<CloudMachine, 'name'>): Promise<void> {
    this.machines.get(machine.name)!.power = 'running';
  }
  async restart(): Promise<void> {}
  async deallocate(machine: Pick<CloudMachine, 'name'>): Promise<void> {
    this.calls.push(`deallocate ${machine.name}`);
    const found = this.machines.get(machine.name);
    if (found !== undefined) found.power = 'deallocated';
  }
  async remove(machine: Pick<CloudMachine, 'name'>): Promise<void> {
    this.calls.push(`remove ${machine.name}`);
    this.machines.delete(machine.name);
  }
  async capacity(): Promise<RegionCapacity> {
    return { usedCores: 0, limitCores: 100 };
  }
}

function setup(admitted: { value: boolean } = { value: true }) {
  let issued = 0;
  const cloud = new MemoryCloud();
  const tokens: Array<{ token: string; id: string }> = [];
  const fleet = new Fleet({
    driver: cloud,
    regions: ['northcentralus'],
    coresPerRunner: 2,
    tokenFor: () => {
      const token = { token: `token-${(issued += 1)}`, id: `id-${issued}-0123456789abcdef` };
      tokens.push(token);
      return token;
    },
    admit: () => (admitted.value ? null : 'no longer admitted'),
  });
  const link = (): FleetLink & { closed: number[] } => {
    const closed: number[] = [];
    return { closed, close: (code) => closed.push(code) };
  };
  const managed = () => ({ kind: 'managed' as const, runner: NAME, userId: USER, id: tokens.at(-1)!.id });
  return { cloud, fleet, link, managed };
}

describe('a runner of someone’s own, and the machine the hub manages for them', () => {
  const own = { kind: 'own' as const, runner: 'my-server', userId: USER, id: 'x'.repeat(22) };

  it('is not let in beside a managed machine, so it cannot take the machine out of the hub’s hands', async () => {
    const admitted = { value: true };
    const { cloud, fleet, link, managed } = setup(admitted);
    await fleet.wake(USER);
    const real = link();
    assert.equal(fleet.connected(managed(), real, IDLE), true);

    // It used to be admitted, close the managed machine's link, and mark the machine unmanaged:
    // out of reach of the allow-list, the limits and the idle timeout while the VM stayed awake.
    const refused = fleet.admits(own);
    assert.equal(refused.ok === false && refused.status, 409);
    assert.equal(fleet.connected(own, link(), IDLE), false);
    assert.deepEqual(real.closed, []);
    assert.equal(fleet.status(USER).managed, true);

    admitted.value = false;
    await fleet.tick();
    assert.ok(cloud.calls.includes(`deallocate ${NAME}`), 'the machine is still the hub’s to put to sleep');
    assert.equal(fleet.refusal(USER), 'no longer admitted');
  });

  it('is let go when the hub learns the person has a managed machine after all', async () => {
    const { cloud, fleet, link } = setup();
    await fleet.reconcile();
    const mine = link();
    assert.deepEqual(fleet.admits(own), { ok: true });
    assert.equal(fleet.connected(own, mine, IDLE), true);
    assert.equal(fleet.status(USER).managed, false);

    cloud.machines.set(NAME, { name: NAME, userId: USER, region: 'northcentralus', power: 'deallocated', provisioning: 'succeeded', createdAt: 0, tokenId: 'id-from-an-earlier-hub' });
    await fleet.reconcile();
    assert.deepEqual(mine.closed, [4409]);
    assert.deepEqual([fleet.status(USER).managed, fleet.status(USER).state], [true, 'asleep']);
    assert.equal(fleet.admits(own).ok, false);
  });
});

describe('removing a machine', () => {
  it('is not undone by a create that was already on its way', async () => {
    const { cloud, fleet, managed } = setup();
    let land: () => void = () => undefined;
    cloud.holdCreate(new Promise<void>((resolve) => (land = resolve)));
    const waking = fleet.wake(USER);
    await pause(20);

    assert.equal((await fleet.remove(USER)).state, 'deleting');
    land();
    await waking;
    assert.equal(cloud.machines.size, 0, 'what the create made was deleted when it landed');
    assert.deepEqual(cloud.calls.filter((call) => call.startsWith('remove')), [`remove ${NAME}`, `remove ${NAME}`]);
    assert.equal(fleet.admits(managed()).ok, false);
    await fleet.reconcile();
    assert.equal(fleet.status(USER).state, 'none');
  });

  it('is not undone by a runner that opened its socket before the removal and says hello after it', async () => {
    const { fleet, link, managed } = setup();
    await fleet.wake(USER);
    const token = managed();
    const real = link();
    fleet.connected(token, real, IDLE);
    assert.equal(fleet.admits(token).ok, true, 'a second socket, let in while the machine still existed');

    await fleet.remove(USER);
    fleet.disconnected(USER, real);
    await fleet.reconcile();
    assert.equal(fleet.status(USER).state, 'none');
    // The machine is forgotten. A managed name with nothing behind it used to be tracked afresh, as ready.
    assert.equal(fleet.connected(token, link(), IDLE), false);
    assert.deepEqual([fleet.status(USER).state, fleet.isReady(USER)], ['none', false]);
  });
});

/* ------------------------------------------------------------------ */
/* The hub, over real sockets                                          */
/* ------------------------------------------------------------------ */

function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  const mask = randomBytes(4);
  let header: Buffer;
  if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
  else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) masked[index]! ^= mask[index % 4]!;
  return Buffer.concat([header, mask, masked]);
}

describe('a run stream waiting for its runner', () => {
  /**
   * In a process of its own, with a time limit: the defect was the event loop
   * never turning again, and a test in this process could not have failed on
   * that. It could only have hung.
   */
  it('does not freeze the hub when the runner comes back and its connection is closed in the same breath', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relay-hub-freeze-'));
    const source = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
    const script = `
import net from 'node:net';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
const { createHub, StaticVerifier } = await import(${source('../src/cloud/hub/server.ts')});
const { Fleet } = await import(${source('../src/cloud/hub/fleet.ts')});
const { mintRunnerToken } = await import(${source('../src/cloud/hub/auth.ts')});
const frame = ${frame.toString()};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const secret = 's'.repeat(40);
const fleet = new Fleet({ driver: null, regions: [], coresPerRunner: 2, tokenFor: () => ({ token: '', id: '' }) });
const hub = createHub({ fleet, secret, sessions: new StaticVerifier([['browser-token-0123456789', 'user_1']]), origins: ['https://studio.example'], version: 't' });
const port = await hub.listen(0, '127.0.0.1');
const token = mintRunnerToken(secret, { runner: 'dev', userId: 'user_1' }).token;
const runner = () => new Promise((resolve) => {
  const socket = net.connect(port, '127.0.0.1', () => socket.write('GET /v1/runner/connect HTTP/1.1\\r\\nHost: x\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: ' + randomBytes(16).toString('base64') + '\\r\\nAuthorization: Bearer ' + token + '\\r\\n\\r\\n'));
  socket.once('data', () => resolve(socket));
  socket.on('error', () => undefined);
});
const hello = JSON.stringify({ t: 'hello', hello: { product: 'relay', protocol: 1, capabilities: ['runs'] }, activity: { runs: 0, queued: 0, logins: 0 } });

const first = await runner();
let seen = Buffer.alloc(0);
first.on('data', (chunk) => {
  seen = Buffer.concat([seen, chunk]);
  const asked = /"t":"req","id":"([^"]+)"/.exec(seen.toString('latin1'));
  if (asked) { seen = Buffer.alloc(0); first.write(frame(JSON.stringify({ t: 'res', id: asked[1], status: 200, stream: true }))); }
});
first.write(frame(hello));
await pause(200);
http.get({ port, host: '127.0.0.1', path: '/v1/runs/sr_x/events', headers: { authorization: 'Bearer browser-token-0123456789' } }, (response) => response.on('data', () => undefined));
await pause(300);
first.destroy(); // the runner drops; the stream now waits for it
await pause(300);

// It comes back, and sends a frame the hub closes it for, in the same write as its hello.
const second = await runner();
second.write(Buffer.concat([frame(hello), frame('{"t":"res"}')]));
await pause(150);
console.log('ready after the close:', fleet.isReady('user_1'));
const health = await fetch('http://127.0.0.1:' + port + '/healthz');
console.log('healthz', health.status);
process.exit(0);
`;
    const path = join(dir, 'freeze.mjs');
    await writeFile(path, script);
    try {
      const ran = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path], { timeout: 20_000, encoding: 'utf8' });
      assert.equal(ran.signal, null, 'the hub’s event loop kept turning (it was killed by the time limit when it did not)');
      assert.equal(ran.status, 0, ran.stderr);
      assert.match(ran.stdout, /healthz 200/);
      // And the machine is not called ready while the only connection to it is one the hub has closed.
      assert.match(ran.stdout, /ready after the close: false/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function hubWith(sessions: SessionVerifier, extra: { tarballPath?: string; maxStreamsPerUser?: number } = {}) {
  const fleet = new Fleet({ driver: null, regions: [], coresPerRunner: 2, tokenFor: () => ({ token: '', id: '' }) });
  const hub = createHub({ fleet, secret: SECRET, sessions, origins: ['https://studio.example'], version: 't', ...extra });
  const port = await hub.listen(0, '127.0.0.1');
  return { hub, port };
}

describe('a browser that leaves early', () => {
  it('does not keep a run stream’s place when it went while its session was still being checked', async () => {
    let delay = 0;
    const sessions: SessionVerifier = {
      verify: async () => {
        await pause(delay);
        return { userId: USER, sessionId: null, expiresAt: Date.now() + 60_000 };
      },
    };
    const { hub, port } = await hubWith(sessions, { maxStreamsPerUser: 2 });
    const runner = new WebSocket(`ws://127.0.0.1:${port}/v1/runner/connect`, { headers: { authorization: `Bearer ${mintRunnerToken(SECRET, { runner: 'dev', userId: USER }).token}` } } as unknown as string[]);
    let follows = 0;
    runner.addEventListener('message', (event) => {
      const sent = JSON.parse(String(event.data)) as { t: string; id: string };
      if (sent.t !== 'req') return;
      follows += 1;
      runner.send(JSON.stringify({ t: 'res', id: sent.id, status: 200, stream: true }));
    });
    try {
      await new Promise((resolve) => runner.addEventListener('open', resolve));
      runner.send(JSON.stringify({ t: 'hello', hello: { product: 'relay', protocol: 1, capabilities: ['runs'] }, activity: IDLE }));
      await pause(100);

      delay = 250;
      for (let index = 0; index < 2; index += 1) {
        const socket = connect(port, '127.0.0.1');
        socket.on('error', () => undefined);
        socket.write('GET /v1/runs/sr_x/events HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer anything\r\n\r\n');
        await pause(80);
        socket.destroy(); // gone before the session check finishes
      }
      await pause(600);
      assert.equal(follows, 0, 'the runner is not asked to follow a run for nobody');

      // Both places used to be held for good, and this third stream was refused with a 429.
      delay = 0;
      const status = await new Promise<number>((resolve) => {
        get({ port, host: '127.0.0.1', path: '/v1/runs/sr_x/events', headers: { authorization: 'Bearer anything' } }, (response) => {
          resolve(response.statusCode ?? 0);
          response.destroy();
        });
      });
      assert.equal(status, 200);
    } finally {
      runner.close();
      await hub.close();
    }
  });

  it('does not leave the runner package open behind an abandoned download', { skip: !POSIX }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relay-hub-package-'));
    const tarball = join(dir, 'relay.tgz');
    await writeFile(tarball, randomBytes(4 * 1024 * 1024));
    const { hub, port } = await hubWith({ verify: async () => ({ userId: USER, sessionId: null, expiresAt: 0 }) }, { tarballPath: tarball });
    const descriptors = (): number => readdirSync('/dev/fd').length;
    try {
      const before = descriptors();
      for (let index = 0; index < 25; index += 1) {
        await new Promise<void>((resolve) => {
          const request = get({ port, host: '127.0.0.1', path: '/runner/relay.tgz' }, (response) => {
            response.once('data', () => {
              response.destroy();
              resolve();
            });
          });
          request.on('error', () => resolve());
        });
      }
      await pause(500);
      // One descriptor per abandoned request used to stay open, from a route that needs no sign-in.
      assert.ok(descriptors() - before < 5, `descriptors went from ${before} to ${descriptors()}`);
    } finally {
      await hub.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('two connections holding one runner token', () => {
  it('is said in the log, because it is also what a copied token looks like', async () => {
    const logs: string[] = [];
    const fleet = new Fleet({ driver: null, regions: [], coresPerRunner: 2, tokenFor: () => ({ token: '', id: '' }) });
    const hub = createHub({ fleet, secret: SECRET, sessions: { verify: async () => ({ userId: USER, sessionId: null, expiresAt: 0 }) }, origins: ['https://studio.example'], version: 't', log: (entry) => logs.push(`${entry.level}: ${entry.msg}`) });
    const port = await hub.listen(0, '127.0.0.1');
    const token = mintRunnerToken(SECRET, { runner: 'dev', userId: USER }).token;
    const dial = async (): Promise<WebSocket> => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/runner/connect`, { headers: { authorization: `Bearer ${token}` } } as unknown as string[]);
      await new Promise((resolve) => ws.addEventListener('open', resolve));
      const welcomed = new Promise((resolve) => ws.addEventListener('message', resolve, { once: true }));
      ws.send(JSON.stringify({ t: 'hello', hello: { product: 'relay', protocol: 1 }, activity: IDLE }));
      await welcomed;
      return ws;
    };
    try {
      const first = await dial();
      assert.ok(!logs.some((line) => line.startsWith('warn')));
      const second = await dial();
      assert.ok(logs.includes('warn: a runner connected while its earlier connection was still open; the earlier one is closed'), logs.join('\n'));
      first.close();
      second.close();
    } finally {
      await hub.close();
    }
  });
});

describe('the runner’s memory and Node’s debugger', { skip: !POSIX }, () => {
  /** Starts a Node process, sends it SIGUSR1 once it says it is ready, and returns what it wrote to stderr. */
  async function signalled(program: string): Promise<string> {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', program], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += String(chunk)));
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
    process.kill(child.pid!, 'SIGUSR1');
    await pause(700);
    const alive = child.exitCode === null && child.signalCode === null;
    child.kill('SIGKILL');
    assert.ok(alive, 'the signal did not end the process');
    return stderr;
  }

  it('is not opened by a SIGUSR1 from another process of the same user', async () => {
    const idle = 'console.log("ready"); setInterval(() => {}, 1000);';
    const module = JSON.stringify(new URL('../src/cloud/runner.ts', import.meta.url).href);
    const guarded = await signalled(`const { refuseInspector } = await import(${module}); refuseInspector(); ${idle}`);
    assert.ok(!/Debugger listening/.test(guarded), guarded);

    // What happens without it, on a Node that has an inspector: a debugger port any local process can attach to.
    const plain = await signalled(idle);
    if (!/Debugger listening/.test(plain)) return;
    assert.match(plain, /Debugger listening on ws:\/\/127\.0\.0\.1/);
  });
});
