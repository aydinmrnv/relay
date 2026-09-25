import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';
import { createServer } from 'node:http';

import { acceptWebSocket, isWebSocketUpgrade, refuseUpgrade, type WsConnection } from '../src/cloud/ws.ts';
import { backoffDelay } from '../src/cloud/dialout.ts';
import { runnerSocketUrl } from '../src/cloud/frames.ts';
import { AuthError, ClerkVerifier, clerkIssuerFromPublishableKey, mintRunnerToken, verifyRunnerToken } from '../src/cloud/hub/auth.ts';
import { AzureDriver, classifyArmError, machineFromArm, vmFamilyUsageName } from '../src/cloud/hub/azure.ts';
import { runnerCloudInit } from '../src/cloud/hub/cloudInit.ts';
import { CloudError, type CloudDriver, type CloudMachine, type MachineSpec, type RegionCapacity } from '../src/cloud/hub/driver.ts';
import { Fleet, runnerName, type FleetLink } from '../src/cloud/hub/fleet.ts';
import { readHubConfig } from '../src/cli/commands/hub.ts';

/* ------------------------------------------------------------------ */
/* The WebSocket server                                                */
/* ------------------------------------------------------------------ */

async function wsServer(onConnection: (ws: WsConnection) => void, maxPayload?: number): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => response.writeHead(404).end());
  server.on('upgrade', (request, socket, head) => {
    if (!isWebSocketUpgrade(request)) return refuseUpgrade(socket, 426, 'no');
    if (request.headers.authorization !== 'Bearer ok') return refuseUpgrade(socket, 401, 'no token');
    onConnection(acceptWebSocket(request, socket, head, maxPayload === undefined ? {} : { maxPayload }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    url: `ws://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function client(url: string, token = 'ok'): WebSocket {
  return new WebSocket(url, { headers: { authorization: `Bearer ${token}` } } as unknown as string[]);
}

describe('the hub’s WebSocket server', () => {
  it('speaks to Node’s own client: text both ways, small and large, and a clean close', async () => {
    const server = await wsServer((ws) => ws.onMessage((text) => ws.send(`echo:${text.length}:${text.slice(0, 5)}`)));
    try {
      const ws = client(server.url);
      const answers: string[] = [];
      const done = new Promise<void>((resolve) => {
        ws.addEventListener('message', (event) => {
          answers.push(String(event.data));
          if (answers.length === 3) ws.close(1000, 'bye');
        });
        ws.addEventListener('close', () => resolve());
      });
      await new Promise((resolve) => ws.addEventListener('open', resolve));
      ws.send('hello');
      ws.send('x'.repeat(70_000)); // a 64-bit length
      ws.send('y'.repeat(300)); // a 16-bit length
      await done;
      assert.deepEqual(answers, ['echo:5:hello', 'echo:70000:xxxxx', 'echo:300:yyyyy']);
    } finally {
      await server.close();
    }
  });

  it('refuses an upgrade without the token, and closes on a message over the limit', async () => {
    let closedWith: number | null = null;
    const server = await wsServer((ws) => ws.onClose((code) => (closedWith = code)), 1024);
    try {
      const refused = client(server.url, 'wrong');
      await new Promise<void>((resolve) => refused.addEventListener('close', () => resolve()));
      assert.equal(refused.readyState, WebSocket.CLOSED);

      const ws = client(server.url);
      await new Promise((resolve) => ws.addEventListener('open', resolve));
      const closed = new Promise<number>((resolve) => ws.addEventListener('close', (event) => resolve(event.code)));
      ws.send('z'.repeat(5000));
      assert.equal(await closed, 1009);
      assert.ok(closedWith !== null);
    } finally {
      await server.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

describe('runner tokens', () => {
  const secret = 's'.repeat(40);

  it('carry the machine and its owner, and nothing but the hub’s secret makes one', () => {
    const token = mintRunnerToken(secret, { runner: 'relay-abc', userId: 'user_1' });
    assert.deepEqual(verifyRunnerToken(secret, token), { runner: 'relay-abc', userId: 'user_1' });
    assert.equal(verifyRunnerToken('t'.repeat(40), token), null);
    const [version, payload, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ r: 'relay-abc', u: 'user_2' })).toString('base64url');
    assert.equal(verifyRunnerToken(secret, `${version}.${forged}.${signature}`), null);
    assert.equal(verifyRunnerToken(secret, `${version}.${payload}`), null);
    assert.equal(verifyRunnerToken(secret, null), null);
  });
});

describe('Clerk session tokens', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const issuer = 'https://clever-cat-1.clerk.accounts.dev';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };

  function jwt(claims: Record<string, unknown>, key: KeyObject = privateKey, kid = 'k1'): string {
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key).toString('base64url');
    return `${head}.${body}.${signature}`;
  }

  function verifier(now = 1_800_000_000_000): { verifier: ClerkVerifier; fetches: () => number } {
    let fetches = 0;
    const fetchImpl = (async () => {
      fetches += 1;
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    }) as unknown as typeof fetch;
    return { verifier: new ClerkVerifier({ issuer, authorizedParties: ['https://studio.example'], fetchImpl, now: () => now }), fetches: () => fetches };
  }

  const valid = { sub: 'user_42', sid: 'sess_1', iss: issuer, azp: 'https://studio.example', exp: 1_800_000_060, nbf: 1_799_999_990 };

  it('finds the issuer in a publishable key', () => {
    const key = `pk_test_${Buffer.from('clever-cat-1.clerk.accounts.dev$').toString('base64')}`;
    assert.equal(clerkIssuerFromPublishableKey(key), issuer);
    assert.throws(() => clerkIssuerFromPublishableKey('sk_test_nope'));
  });

  it('accepts a live token from this instance and says whose it is', async () => {
    const { verifier: v, fetches } = verifier();
    const claims = await v.verify(jwt(valid));
    assert.equal(claims.userId, 'user_42');
    await v.verify(jwt(valid));
    assert.equal(fetches(), 1);
  });

  it('refuses expired, foreign, mis-signed and malformed tokens', async () => {
    const { verifier: v } = verifier();
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    await assert.rejects(v.verify(jwt({ ...valid, exp: 1_799_999_000 })), AuthError);
    await assert.rejects(v.verify(jwt({ ...valid, iss: 'https://other.clerk.accounts.dev' })), AuthError);
    await assert.rejects(v.verify(jwt({ ...valid, azp: 'https://evil.example' })), AuthError);
    await assert.rejects(v.verify(jwt(valid, other)), AuthError);
    await assert.rejects(v.verify(jwt(valid, privateKey, 'unknown')), AuthError);
    await assert.rejects(v.verify('not.a.jwt'), AuthError);
    await assert.rejects(v.verify(null), AuthError);
  });
});

/* ------------------------------------------------------------------ */
/* The fleet                                                           */
/* ------------------------------------------------------------------ */

class FakeCloud implements CloudDriver {
  readonly machines = new Map<string, CloudMachine>();
  readonly calls: string[] = [];
  readonly limits = new Map<string, number>();
  /** Cores used in a region by things that are not runners. */
  readonly other = new Map<string, number>();
  failCreate: CloudError | null = null;
  now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  private cores(region: string): number {
    let used = this.other.get(region) ?? 0;
    for (const machine of this.machines.values()) {
      if (machine.region === region && machine.power !== 'deallocated') used += 2;
    }
    return used;
  }

  private room(region: string): void {
    if (this.cores(region) + 2 > (this.limits.get(region) ?? 6)) throw new CloudError('quota', `Operation could not be completed as it results in exceeding approved Total Regional Cores quota in ${region}.`);
  }

  async list(): Promise<CloudMachine[]> {
    return [...this.machines.values()].map((machine) => ({ ...machine }));
  }
  async create(spec: MachineSpec): Promise<void> {
    this.calls.push(`create ${spec.name} ${spec.region}`);
    if (this.failCreate !== null) throw this.failCreate;
    this.room(spec.region);
    this.machines.set(spec.name, { name: spec.name, userId: spec.userId, region: spec.region, power: 'running', provisioning: 'succeeded', createdAt: this.now() });
  }
  async start(machine: Pick<CloudMachine, 'name' | 'region'>): Promise<void> {
    this.calls.push(`start ${machine.name}`);
    this.room(machine.region);
    this.machines.get(machine.name)!.power = 'running';
  }
  async restart(machine: Pick<CloudMachine, 'name'>): Promise<void> {
    this.calls.push(`restart ${machine.name}`);
  }
  async deallocate(machine: Pick<CloudMachine, 'name'>): Promise<void> {
    this.calls.push(`deallocate ${machine.name}`);
    const found = this.machines.get(machine.name);
    if (found !== undefined) found.power = 'deallocated';
  }
  async remove(machine: Pick<CloudMachine, 'name'>): Promise<void> {
    this.calls.push(`remove ${machine.name}`);
    this.machines.delete(machine.name);
  }
  async capacity(region: string): Promise<RegionCapacity> {
    return { usedCores: this.cores(region), limitCores: this.limits.get(region) ?? 6 };
  }
}

function fakeLink(): FleetLink & { closed: Array<[number, string]> } {
  const closed: Array<[number, string]> = [];
  return { closed, close: (code, reason) => closed.push([code, reason]) };
}

function setup(options: { regions?: string[]; idleMs?: number; admit?: (userId: string) => string | null } = {}) {
  let time = 1_000_000;
  const clock = { now: () => time, advance: (ms: number) => (time += ms) };
  const cloud = new FakeCloud(clock.now);
  const fleet = new Fleet({
    driver: cloud,
    regions: options.regions ?? ['northcentralus', 'spaincentral'],
    coresPerRunner: 2,
    tokenFor: (runner, userId) => `token:${runner}:${userId}`,
    idleMs: options.idleMs ?? 10 * 60_000,
    pressureIdleMs: 2 * 60_000,
    bootTimeoutMs: 6 * 60_000,
    firstBootTimeoutMs: 25 * 60_000,
    now: clock.now,
    ...(options.admit === undefined ? {} : { admit: options.admit }),
  });
  return { clock, cloud, fleet };
}

const IDLE = { runs: 0, queued: 0, logins: 0 };

describe('the fleet', () => {
  it('names machines stably, and without saying whose they are', () => {
    const name = runnerName('relay', 'user_2abcDEF');
    assert.match(name, /^relay-[a-z2-7]{12}$/);
    assert.equal(runnerName('relay', 'user_2abcDEF'), name);
    assert.notEqual(runnerName('relay', 'user_2abcDEG'), name);
    assert.ok(!name.includes('2abc'));
  });

  it('makes a first machine in the region with the most room, and is ready once it dials in', async () => {
    const { cloud, fleet } = setup();
    cloud.other.set('northcentralus', 2); // the hub lives there
    const status = await fleet.wake('user_a');
    assert.equal(status.state, 'creating');
    assert.equal(status.region, 'spaincentral');
    const name = runnerName('relay', 'user_a');
    assert.deepEqual(cloud.calls, [`create ${name} spaincentral`]);

    fleet.connected({ runner: name, userId: 'user_a' }, fakeLink(), IDLE);
    assert.equal(fleet.status('user_a').state, 'ready');
    assert.equal(await fleet.whenReady('user_a', 10), true);
  });

  it('never wakes a machine for a read, and reports none for someone who has no machine', async () => {
    const { cloud, fleet } = setup();
    assert.equal(fleet.status('user_z').state, 'none');
    await fleet.tick();
    assert.deepEqual(cloud.calls, []);
  });

  it('puts an idle machine to sleep, and keeps a busy one awake', async () => {
    const { clock, cloud, fleet } = setup();
    await fleet.wake('user_a');
    const name = runnerName('relay', 'user_a');
    const link = fakeLink();
    fleet.connected({ runner: name, userId: 'user_a' }, link, IDLE);

    fleet.reportActivity('user_a', { runs: 1, queued: 0, logins: 0 });
    clock.advance(30 * 60_000);
    await fleet.tick();
    assert.equal(fleet.status('user_a').state, 'ready');

    fleet.reportActivity('user_a', IDLE);
    clock.advance(9 * 60_000);
    await fleet.tick();
    assert.equal(fleet.status('user_a').state, 'ready');

    const release = fleet.use('user_a');
    clock.advance(20 * 60_000);
    await fleet.tick();
    assert.equal(fleet.status('user_a').state, 'ready', 'a request in flight keeps it awake');
    release();

    clock.advance(11 * 60_000);
    await fleet.tick();
    assert.equal(fleet.status('user_a').state, 'stopping');
    assert.ok(cloud.calls.includes(`deallocate ${name}`));
    assert.deepEqual(link.closed[0]?.[0], 4000);

    fleet.disconnected('user_a', link);
    clock.advance(2 * 60_000);
    await fleet.reconcile();
    assert.equal(fleet.status('user_a').state, 'asleep');

    // Waking it again starts the same machine; it is not made twice.
    const again = await fleet.wake('user_a');
    assert.equal(again.state, 'starting');
    assert.equal(cloud.calls.filter((call) => call.startsWith('create')).length, 1);
    assert.ok(cloud.calls.includes(`start ${name}`));
  });

  it('does not count a status check as use, so an open studio tab lets the machine sleep', async () => {
    const { clock, fleet } = setup();
    await fleet.wake('user_a');
    fleet.connected({ runner: runnerName('relay', 'user_a'), userId: 'user_a' }, fakeLink(), IDLE);
    for (let minute = 0; minute < 11; minute += 1) {
      clock.advance(60_000);
      fleet.use('user_a', { touch: false })();
      await fleet.tick();
    }
    assert.equal(fleet.status('user_a').state, 'stopping');
  });

  it('queues a wake when the region is full, lets an idle machine give up its place, and starts the queue in order', async () => {
    const { clock, cloud, fleet } = setup({ regions: ['northcentralus'] });
    cloud.limits.set('northcentralus', 4); // two runners at once
    const links = new Map<string, FleetLink>();
    for (const user of ['user_a', 'user_b']) {
      await fleet.wake(user);
      links.set(user, fakeLink());
      fleet.connected({ runner: runnerName('relay', user), userId: user }, links.get(user)!, IDLE);
    }
    fleet.reportActivity('user_b', { runs: 1, queued: 0, logins: 0 });

    const waiting = await fleet.wake('user_c');
    assert.equal(waiting.state, 'queued');
    assert.equal(waiting.position, 1);
    assert.equal(cloud.calls.filter((call) => call.startsWith('deallocate')).length, 0, 'user_a was used moments ago');

    // After the pressure grace, the idle machine (not the busy one) gives way.
    clock.advance(3 * 60_000);
    await fleet.tick();
    assert.ok(cloud.calls.includes(`deallocate ${runnerName('relay', 'user_a')}`));
    assert.ok(!cloud.calls.includes(`deallocate ${runnerName('relay', 'user_b')}`));
    // Its runner dials straight back in before the power goes; that is not "awake".
    assert.equal(fleet.connected({ runner: runnerName('relay', 'user_a'), userId: 'user_a' }, fakeLink(), IDLE), false);
    fleet.disconnected('user_a', links.get('user_a')!);

    clock.advance(2 * 60_000);
    await fleet.reconcile();
    await fleet.tick();
    assert.equal(fleet.status('user_c').state, 'creating');
    assert.equal(fleet.status('user_a').state, 'asleep');
  });

  it('restarts a machine that never dials in once, then stops it with an error the person sees', async () => {
    const { clock, cloud, fleet } = setup();
    await fleet.wake('user_a');
    const name = runnerName('relay', 'user_a');
    clock.advance(26 * 60_000);
    await fleet.tick();
    assert.ok(cloud.calls.includes(`restart ${name}`));
    assert.equal(fleet.status('user_a').state, 'creating');

    clock.advance(7 * 60_000);
    await fleet.tick();
    const status = fleet.status('user_a');
    assert.equal(status.state, 'failed');
    assert.match(status.error ?? '', /could not reach it/);
    assert.ok(cloud.calls.includes(`deallocate ${name}`));

    // Pressing Start again tries again.
    clock.advance(2 * 60_000);
    await fleet.reconcile();
    const retried = await fleet.wake('user_a');
    assert.equal(retried.state, 'starting');
  });

  it('deallocates a machine that was shut down from inside, since a stopped VM is still billed', async () => {
    const { clock, cloud, fleet } = setup();
    await fleet.wake('user_a');
    const name = runnerName('relay', 'user_a');
    cloud.machines.get(name)!.power = 'stopped';
    clock.advance(2 * 60_000);
    await fleet.reconcile();
    await fleet.tick();
    assert.ok(cloud.calls.includes(`deallocate ${name}`));
  });

  it('rebuilds everything from the cloud after a restart', async () => {
    const first = setup();
    await first.fleet.wake('user_a');
    await first.fleet.wake('user_b');
    const bName = runnerName('relay', 'user_b');
    first.cloud.machines.get(bName)!.power = 'deallocated';

    const fresh = new Fleet({ driver: first.cloud, regions: ['northcentralus', 'spaincentral'], coresPerRunner: 2, tokenFor: () => 't', now: first.clock.now });
    await fresh.reconcile();
    assert.equal(fresh.status('user_a').state, 'creating');
    assert.equal(fresh.status('user_b').state, 'asleep');
    assert.equal(fresh.ownerOf(bName), 'user_b');
  });

  it('turns people away when they are not admitted or the fleet is full', async () => {
    const { cloud, fleet } = setup({ admit: (userId) => (userId === 'user_ok' ? null : 'Invite only.') });
    const refused = await fleet.wake('user_no');
    assert.equal(refused.state, 'none');
    assert.equal(refused.error, 'Invite only.');
    assert.deepEqual(cloud.calls, []);
    assert.equal((await fleet.wake('user_ok')).state, 'creating');
  });

  it('remakes a machine Azure failed to make', async () => {
    const { clock, cloud, fleet } = setup();
    await fleet.wake('user_a');
    const name = runnerName('relay', 'user_a');
    cloud.machines.get(name)!.provisioning = 'failed';
    clock.advance(2 * 60_000);
    await fleet.reconcile();
    assert.equal(fleet.status('user_a').state, 'failed');
    await fleet.wake('user_a');
    assert.ok(cloud.calls.includes(`remove ${name}`));
    await fleet.reconcile();
    await fleet.tick();
    assert.equal(cloud.calls.filter((call) => call.startsWith('create')).length, 2);
    assert.equal(fleet.status('user_a').state, 'creating');
  });

  it('routes to a runner someone started themselves, and never tries to start or stop it', async () => {
    const { cloud, fleet } = setup();
    const link = fakeLink();
    fleet.connected({ runner: 'my-server', userId: 'user_self' }, link, IDLE);
    assert.equal(fleet.status('user_self').state, 'ready');
    assert.equal(fleet.status('user_self').managed, false);
    fleet.disconnected('user_self', link);
    assert.equal(fleet.status('user_self').state, 'offline');
    await fleet.wake('user_self');
    assert.deepEqual(cloud.calls, []);
  });
});

/* ------------------------------------------------------------------ */
/* Azure                                                               */
/* ------------------------------------------------------------------ */

describe('the Azure driver', () => {
  it('reads a runner VM, its owner and its power state from Azure’s two lists', () => {
    // As Azure answers: the resource group's list has the tags, the subscription's statusOnly list the power state.
    const id = '/subscriptions/sub/resourceGroups/relay-cloud/providers/Microsoft.Compute/virtualMachines/relay-abc';
    const machine = machineFromArm(
      { id, name: 'relay-abc', location: 'spaincentral', tags: { 'relay-role': 'runner', 'relay-user': 'user_1' }, properties: { provisioningState: 'Succeeded', timeCreated: '2026-09-25T10:00:00Z' } },
      { id: id.toUpperCase(), name: 'relay-abc', location: 'SpainCentral', tags: null, properties: { provisioningState: 'Succeeded', instanceView: { statuses: [{ code: 'ProvisioningState/succeeded' }, { code: 'PowerState/deallocated' }] } } },
    );
    assert.deepEqual(machine, { name: 'relay-abc', userId: 'user_1', region: 'spaincentral', power: 'deallocated', provisioning: 'succeeded', createdAt: Date.parse('2026-09-25T10:00:00Z') });
    assert.equal(machineFromArm({ name: 'hub', location: 'x', tags: { 'relay-role': 'hub' } }), null);
    assert.equal(machineFromArm({ name: 'relay-abc', location: 'SpainCentral', tags: { 'relay-role': 'runner', 'relay-user': 'u' } })?.power, 'unknown');
  });

  it('lists runners without asking Azure for what it refuses, and matches statuses whatever their case', async () => {
    const urls: string[] = [];
    const id = '/subscriptions/sub/resourceGroups/relay-cloud/providers/Microsoft.Compute/virtualMachines/relay-abc';
    const fetchImpl = (async (url: string) => {
      if (url.startsWith('http://169.254.169.254')) return new Response(JSON.stringify({ access_token: 'arm', expires_on: String(Math.floor(Date.now() / 1000) + 3600) }));
      urls.push(url);
      if (url.includes('$expand')) return new Response(JSON.stringify({ error: { code: 'BadRequest', message: 'Expand Instance View is only supported when Virtual Machine Scale Set resource filter is applied' } }), { status: 400 });
      if (url.includes('statusOnly=true')) {
        return new Response(JSON.stringify({ value: [{ id: id.toUpperCase(), name: 'relay-abc', properties: { instanceView: { statuses: [{ code: 'PowerState/running' }] } } }, { id: '/subscriptions/sub/resourceGroups/relay-dev/providers/Microsoft.Compute/virtualMachines/other', name: 'other' }] }));
      }
      return new Response(JSON.stringify({ value: [{ id, name: 'relay-abc', location: 'spaincentral', tags: { 'relay-role': 'runner', 'relay-user': 'user_1' }, properties: { provisioningState: 'Succeeded' } }] }));
    }) as unknown as typeof fetch;
    const driver = new AzureDriver({
      subscriptionId: 'sub', resourceGroup: 'relay-cloud', credential: 'managed-identity', vmSize: 'Standard_B2ats_v2', image: 'Canonical:ubuntu-24_04-lts:server:latest',
      osDiskType: 'StandardSSD_LRS', osDiskGb: 32, adminUser: 'relay', sshPublicKey: 'ssh-ed25519 AAAA test', customData: () => '', fetchImpl,
    });
    const machines = await driver.list();
    assert.deepEqual(machines.map((machine) => [machine.name, machine.power]), [['relay-abc', 'running']]);
    assert.ok(urls.every((url) => !url.includes('$expand')));
  });

  it('sorts Azure’s refusals into what the fleet can act on', () => {
    assert.equal(classifyArmError(409, 'OperationNotAllowed', 'Operation could not be completed as it results in exceeding approved Total Regional Cores quota.'), 'quota');
    assert.equal(classifyArmError(409, 'AllocationFailed', 'Allocation failed.'), 'capacity');
    assert.equal(classifyArmError(404, 'ResourceNotFound', 'gone'), 'not-found');
    assert.equal(classifyArmError(503, 'ServiceUnavailable', 'later'), 'transient');
    assert.equal(classifyArmError(400, 'InvalidParameter', 'nope'), 'fatal');
  });

  it('knows which quota a size is counted against', () => {
    assert.equal(vmFamilyUsageName('Standard_B2ats_v2'), 'standardBASv2Family');
    assert.equal(vmFamilyUsageName('Standard_B2pts_v2'), 'standardBPSv2Family');
    assert.equal(vmFamilyUsageName('Standard_B2s_v2'), 'standardBSv2Family');
    assert.equal(vmFamilyUsageName('Standard_D2s_v5'), null);
  });

  it('makes a VM with no public address, its owner in its tags and its token in user data', async () => {
    const requests: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if (url.startsWith('http://169.254.169.254')) return new Response(JSON.stringify({ access_token: 'arm', expires_on: String(Math.floor(Date.now() / 1000) + 3600) }));
      requests.push({ method: init.method ?? 'GET', url, body: init.body === undefined ? null : (JSON.parse(String(init.body)) as Record<string, unknown>) });
      if (url.includes('/usages')) {
        return new Response(JSON.stringify({ value: [{ name: { value: 'cores' }, currentValue: 2, limit: 6 }, { name: { value: 'standardBasv2Family' }, currentValue: 2, limit: 10 }] }));
      }
      return new Response('{}', { status: 201 });
    }) as unknown as typeof fetch;
    const driver = new AzureDriver({
      subscriptionId: 'sub',
      resourceGroup: 'relay-cloud',
      credential: 'managed-identity',
      vmSize: 'Standard_B2ats_v2',
      image: 'Canonical:ubuntu-24_04-lts:server:latest',
      osDiskType: 'StandardSSD_LRS',
      osDiskGb: 32,
      adminUser: 'relay',
      sshPublicKey: 'ssh-ed25519 AAAA test',
      customData: () => '#cloud-config\n',
      fetchImpl,
    });
    await driver.create({ name: 'relay-abc', userId: 'user_1', region: 'spaincentral', token: 'rr1.x.y' });
    const [nic, vm] = requests;
    assert.equal(nic?.method, 'PUT');
    assert.match(nic?.url ?? '', /networkInterfaces\/relay-abc-nic/);
    const ipConfig = ((nic?.body?.['properties'] as Record<string, unknown>)['ipConfigurations'] as Array<{ properties: Record<string, unknown> }>)[0]!;
    assert.equal(ipConfig.properties['publicIPAddress'], undefined);
    assert.match(String((ipConfig.properties['subnet'] as { id: string }).id), /virtualNetworks\/relay-runners-spaincentral\/subnets\/runners$/);
    const props = vm?.body?.['properties'] as Record<string, Record<string, unknown>>;
    assert.deepEqual(vm?.body?.['tags'], { 'relay-role': 'runner', 'relay-user': 'user_1' });
    assert.equal(Buffer.from(String(props['userData']), 'base64').toString(), 'rr1.x.y');
    assert.equal((props['storageProfile']!['osDisk'] as Record<string, unknown>)['deleteOption'], 'Delete');

    assert.deepEqual(await driver.capacity('spaincentral'), { usedCores: 2, limitCores: 6 });
  });
});

describe('a runner machine’s cloud-init', () => {
  it('is ASCII, names the hub, and runs the runner as its own unprivileged user', () => {
    const text = runnerCloudInit({ hubUrl: 'https://hub.example.com/', maxRuns: 1, adminUser: 'relay' });
    assert.ok(/^[\x00-\x7f]*$/.test(text), 'Azure custom data is Latin-1');
    assert.ok(text.startsWith('#cloud-config\n'));
    assert.match(text, /relay connect --hub https:\/\/hub\.example\.com --token-from azure/);
    assert.match(text, /User=relay/);
    assert.match(text, /hub="https:\/\/hub\.example\.com"/);
    assert.throws(() => runnerCloudInit({ hubUrl: 'https://hub.example.com/$(reboot)', maxRuns: 1, adminUser: 'relay' }));
  });
});

describe('the hub’s configuration', () => {
  it('needs a secret and a way to check sign-ins, and makes machines only when told where', async () => {
    await assert.rejects(readHubConfig({}), /RELAY_HUB_SECRET/);
    const key = `pk_test_${Buffer.from('clever-cat-1.clerk.accounts.dev$').toString('base64')}`;
    const routing = await readHubConfig({ RELAY_HUB_SECRET: 'x'.repeat(40), CLERK_PUBLISHABLE_KEY: key });
    assert.equal(routing.cloud, null);
    assert.deepEqual(routing.sessions, { kind: 'clerk', issuer: 'https://clever-cat-1.clerk.accounts.dev', jwksUrl: null });
    await assert.rejects(readHubConfig({ RELAY_HUB_SECRET: 'x'.repeat(40), RELAY_HUB_DEV_USERS: 'devtoken-0123456789=user_1' }), /development only/);
    await assert.rejects(readHubConfig({ RELAY_HUB_SECRET: 'x'.repeat(40), CLERK_PUBLISHABLE_KEY: key, AZURE_SUBSCRIPTION_ID: 'sub' }), /RELAY_CLOUD_REGIONS/);
    const managed = await readHubConfig({
      RELAY_HUB_SECRET: 'x'.repeat(40),
      CLERK_PUBLISHABLE_KEY: key,
      AZURE_SUBSCRIPTION_ID: 'sub',
      RELAY_CLOUD_REGIONS: 'northcentralus, spaincentral',
      RELAY_HUB_PUBLIC_URL: 'https://hub.example.com',
      RELAY_CLOUD_SSH_KEY: 'ssh-ed25519 AAAA ops',
      RELAY_CLOUD_ALLOWED_USERS: '*',
    });
    assert.deepEqual(managed.cloud?.regions, ['northcentralus', 'spaincentral']);
    assert.equal(managed.cloud?.allowedUsers, '*');
    assert.equal(managed.cloud?.vmSize, 'Standard_B2ats_v2');
  });
});

describe('dialing out', () => {
  it('backs off exponentially, with jitter, up to a ceiling', () => {
    assert.equal(backoffDelay(0, 1000, 30_000, () => 0), 500);
    assert.equal(backoffDelay(0, 1000, 30_000, () => 1), 1000);
    assert.equal(backoffDelay(3, 1000, 30_000, () => 1), 8000);
    assert.equal(backoffDelay(20, 1000, 30_000, () => 1), 30_000);
    assert.ok(backoffDelay(20, 1000, 30_000, () => 0) >= 15_000);
  });

  it('turns a hub address into its runner socket', () => {
    assert.equal(runnerSocketUrl('https://hub.example.com'), 'wss://hub.example.com/v1/runner/connect');
    assert.equal(runnerSocketUrl('http://127.0.0.1:8080/base/'), 'ws://127.0.0.1:8080/base/v1/runner/connect');
    assert.throws(() => runnerSocketUrl('ftp://x'));
  });
});
