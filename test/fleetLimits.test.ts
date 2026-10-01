import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readHubConfig } from '../src/cli/commands/hub.ts';
import type { CloudDriver, CloudMachine, MachineSpec, RegionCapacity } from '../src/cloud/hub/driver.ts';
import { DEFAULT_MAX_MACHINES, Fleet, runnerName, type FleetEvent, type FleetLink } from '../src/cloud/hub/fleet.ts';
import { createHub, StaticVerifier } from '../src/cloud/hub/server.ts';

/**
 * Who may keep a machine, and for how long it stays awake (CLOUD-05, CLOUD-06,
 * CLOUD-08). The cloud is an in-memory stand-in and the clock is the test's.
 */

class MemoryCloud implements CloudDriver {
  readonly machines = new Map<string, CloudMachine>();
  readonly calls: string[] = [];

  async list(): Promise<CloudMachine[]> {
    return [...this.machines.values()].map((machine) => ({ ...machine }));
  }
  async create(spec: MachineSpec): Promise<void> {
    this.calls.push(`create ${spec.name}`);
    this.machines.set(spec.name, { name: spec.name, userId: spec.userId, region: spec.region, power: 'running', provisioning: 'succeeded', createdAt: 0, tokenId: spec.tokenId });
  }
  async rotateToken(machine: Pick<CloudMachine, 'name'>, token: { id: string }): Promise<void> {
    this.machines.get(machine.name)!.tokenId = token.id;
  }
  async start(machine: Pick<CloudMachine, 'name'>): Promise<void> {
    this.calls.push(`start ${machine.name}`);
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
  async capacity(): Promise<RegionCapacity> {
    return { usedCores: 0, limitCores: 1_000 };
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const IDLE = { runs: 0, queued: 0, logins: 0 };
const BUSY = { runs: 1, queued: 0, logins: 0 };
const INVITE_ONLY = 'Relay Cloud is invite-only for now.';

function setup(options: { maxUnattendedMs?: number; dailyAwakeMs?: number; maxMachines?: number } = {}) {
  // Noon UTC, so a test decides for itself whether it crosses midnight.
  let time = Date.parse('2026-10-01T12:00:00Z');
  let issued = 0;
  const allowed = new Set(['user_a', 'user_b']);
  const events: FleetEvent[] = [];
  const clock = { now: () => time, advance: (ms: number) => (time += ms) };
  const cloud = new MemoryCloud();
  const fleet = new Fleet({
    driver: cloud,
    regions: ['northcentralus'],
    coresPerRunner: 2,
    tokenFor: (runner) => ({ token: `token-${runner}`, id: `id-${(issued += 1)}` }),
    admit: (userId) => (allowed.has(userId) ? null : INVITE_ONLY),
    now: clock.now,
    log: (event) => events.push(event),
    ...options,
  });
  const link = (): FleetLink & { closed: number[] } => {
    const closed: number[] = [];
    return { closed, close: (code) => closed.push(code) };
  };
  /** Makes the person's machine and connects its runner. */
  const awake = async (userId: string, activity = IDLE) => {
    await fleet.wake(userId);
    const connection = link();
    assert.equal(fleet.connected({ runner: runnerName('relay', userId), userId }, connection, activity), true);
    return connection;
  };
  /** Moves the clock a tick at a time, as the hub's own timer would. */
  const pass = async (ms: number, each: () => void = () => undefined, step = 10 * MINUTE) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      clock.advance(Math.min(step, ms - elapsed));
      each();
      await fleet.tick();
    }
  };
  return { cloud, clock, fleet, allowed, events, link, awake, pass };
}

describe('someone who is no longer admitted', () => {
  it('cannot start the machine they already have', async () => {
    const { cloud, clock, fleet, allowed, awake } = setup();
    const name = runnerName('relay', 'user_a');
    const connection = await awake('user_a');
    await fleet.sleep('user_a', { force: true });
    fleet.disconnected('user_a', connection);
    clock.advance(2 * MINUTE);
    await fleet.reconcile();
    assert.equal(fleet.status('user_a').state, 'asleep');

    allowed.delete('user_a');
    const refused = await fleet.wake('user_a');
    assert.equal(refused.state, 'asleep');
    assert.equal(refused.error, INVITE_ONLY);
    assert.ok(!cloud.calls.includes(`start ${name}`), 'admission used to be asked only before a first machine was made');
    assert.equal(fleet.refusal('user_a'), INVITE_ONLY);

    allowed.add('user_a');
    assert.equal((await fleet.wake('user_a')).state, 'starting');
  });

  it('has an awake machine put to sleep, with the reason, and listed for the operator to remove', async () => {
    const { cloud, fleet, allowed, events, awake } = setup();
    const name = runnerName('relay', 'user_a');
    const connection = await awake('user_a', BUSY);
    await awake('user_b');
    assert.deepEqual(fleet.revoked(), []);

    allowed.delete('user_a');
    await fleet.tick();
    assert.ok(cloud.calls.includes(`deallocate ${name}`), 'even with a run going: the operator took them off the list');
    assert.deepEqual(connection.closed, [4000]);
    assert.equal(fleet.status('user_a').error, INVITE_ONLY);
    assert.equal(fleet.status('user_b').state, 'ready', 'nobody else is touched');
    assert.deepEqual(fleet.revoked().map((entry) => [entry.userId, entry.runner]), [['user_a', name]]);

    await fleet.tick();
    await fleet.tick();
    assert.equal(events.filter((event) => event.kind === 'revoked').length, 1, 'said once, not every ten seconds');
    assert.ok(!cloud.calls.includes(`remove ${name}`), 'the disk and the sign-ins are not deleted behind the operator’s back');
  });
});

describe('a machine whose runner says it is busy', () => {
  it('is believed past the idle timeout, but not past the limit only a person’s request moves', async () => {
    const { cloud, fleet, awake, pass } = setup({ maxUnattendedMs: 2 * HOUR, dailyAwakeMs: 0 });
    const name = runnerName('relay', 'user_a');
    await awake('user_a', BUSY);

    // Reporting a run every few minutes used to keep a machine awake for ever.
    await pass(HOUR + 50 * MINUTE, () => fleet.reportActivity('user_a', BUSY));
    assert.equal(fleet.status('user_a').state, 'ready', 'a run is a reason to stay awake');

    await pass(20 * MINUTE, () => fleet.reportActivity('user_a', BUSY));
    assert.equal(fleet.status('user_a').state, 'stopping');
    assert.ok(cloud.calls.includes(`deallocate ${name}`));
    assert.match(fleet.status('user_a').error ?? '', /nobody had asked it for anything in 2 hours/);
  });

  it('gets the full time again whenever a person asks it for something', async () => {
    const { fleet, awake, pass } = setup({ maxUnattendedMs: 2 * HOUR, dailyAwakeMs: 0 });
    await awake('user_a', BUSY);
    for (let hour = 0; hour < 5; hour += 1) {
      await pass(HOUR + 30 * MINUTE, () => fleet.reportActivity('user_a', BUSY));
      // A status check is not a person asking for something; a request that does something is.
      fleet.use('user_a', { touch: false })();
      fleet.use('user_a')();
    }
    assert.equal(fleet.status('user_a').state, 'ready');
  });
});

describe('a day’s allowance of awake time', () => {
  it('stops an idle machine at once when it runs out, refuses to start it again, and comes back at midnight UTC', async () => {
    const { cloud, clock, fleet, awake, pass } = setup({ dailyAwakeMs: 3 * HOUR, maxUnattendedMs: 100 * HOUR });
    const name = runnerName('relay', 'user_a');
    const connection = await awake('user_a');

    // Kept busy by a person, so the idle timeout does not get there first.
    await pass(2 * HOUR + 50 * MINUTE, () => fleet.use('user_a')());
    assert.equal(fleet.status('user_a').state, 'ready');
    assert.equal(fleet.refusal('user_a'), null);

    await pass(10 * MINUTE, () => fleet.use('user_a')());
    assert.equal(fleet.awakeToday('user_a'), 3 * HOUR);
    assert.equal(fleet.status('user_a').state, 'stopping');
    assert.match(fleet.status('user_a').error ?? '', /awake for today's 3 hours/);
    assert.match(fleet.refusal('user_a') ?? '', /after midnight UTC/);

    fleet.disconnected('user_a', connection);
    clock.advance(2 * MINUTE);
    await fleet.reconcile();
    const refused = await fleet.wake('user_a');
    assert.equal(refused.state, 'asleep');
    assert.match(refused.error ?? '', /awake for today's 3 hours/);
    assert.equal(cloud.calls.filter((call) => call === `start ${name}`).length, 0);

    clock.advance(12 * HOUR); // past midnight UTC
    assert.equal(fleet.refusal('user_a'), null);
    assert.equal((await fleet.wake('user_a')).state, 'starting');
  });

  it('lets a busy machine finish for half an hour more, and then stops it whatever it says', async () => {
    const { fleet, awake, pass } = setup({ dailyAwakeMs: 3 * HOUR, maxUnattendedMs: 100 * HOUR });
    await awake('user_a', BUSY);
    await pass(3 * HOUR + 20 * MINUTE, () => fleet.reportActivity('user_a', BUSY));
    assert.equal(fleet.status('user_a').state, 'ready', 'over, but still working');
    assert.notEqual(fleet.refusal('user_a'), null, 'and taking no new work');
    await pass(10 * MINUTE, () => fleet.reportActivity('user_a', BUSY));
    assert.equal(fleet.status('user_a').state, 'stopping');
  });
});

describe('how many machines the hub makes', () => {
  it('has one default, in the fleet and in the hub’s configuration', async () => {
    const key = `pk_test_${Buffer.from('clever-cat-1.clerk.accounts.dev$').toString('base64')}`;
    const config = await readHubConfig({
      RELAY_HUB_SECRET: 'x'.repeat(40),
      CLERK_PUBLISHABLE_KEY: key,
      AZURE_SUBSCRIPTION_ID: 'sub',
      RELAY_CLOUD_REGIONS: 'northcentralus',
      RELAY_HUB_PUBLIC_URL: 'https://hub.example.com',
      RELAY_CLOUD_SSH_KEY: 'ssh-ed25519 AAAA ops',
      RELAY_HUB_TARBALL: '/opt/relay/relay.tgz',
    });
    assert.equal(config.cloud?.maxMachines, DEFAULT_MAX_MACHINES);
    assert.equal(config.cloud?.maxUnattendedMinutes, 360);
    assert.equal(config.cloud?.dailyHours, 12);

    const cloud = new MemoryCloud();
    const fleet = new Fleet({ driver: cloud, regions: ['northcentralus'], coresPerRunner: 2, tokenFor: () => ({ token: 't', id: 'i' }) });
    for (let index = 0; index < DEFAULT_MAX_MACHINES; index += 1) assert.equal((await fleet.wake(`user_${index}`)).error, null);
    const full = await fleet.wake('user_one_too_many');
    assert.equal(full.state, 'none');
    assert.match(full.error ?? '', /full right now/);
    assert.equal(cloud.calls.filter((call) => call.startsWith('create')).length, DEFAULT_MAX_MACHINES);
  });
});

describe('the hub, asked to start something for someone it should not', () => {
  it('refuses the request with the reason, and still lets them read and remove', async () => {
    const context = setup();
    const { fleet, allowed } = context;
    const hub = createHub({ fleet, secret: 's'.repeat(40), sessions: new StaticVerifier([['studio-token-0123456789', 'user_a']]), origins: ['https://studio.example'], version: 'test', adminToken: 'admin-token-0123456789' });
    const base = `http://127.0.0.1:${await hub.listen(0, '127.0.0.1')}`;
    const headers = { authorization: 'Bearer studio-token-0123456789', 'content-type': 'application/json' };
    try {
      await context.awake('user_a');
      allowed.delete('user_a');

      const start = await fetch(`${base}/v1/runs`, { method: 'POST', headers, body: '{}' });
      assert.equal(start.status, 403);
      assert.equal(((await start.json()) as { error: string }).error, INVITE_ONLY);
      const wake = await fetch(`${base}/cloud/v1/runner/wake`, { method: 'POST', headers });
      assert.equal(((await wake.json()) as { error: string }).error, INVITE_ONLY);

      assert.equal((await fetch(`${base}/cloud/v1/runner`, { headers })).status, 200);
      const listed = (await (await fetch(`${base}/admin/v1/fleet`, { headers: { authorization: 'Bearer admin-token-0123456789' } })).json()) as { revoked: Array<{ userId: string }> };
      assert.deepEqual(listed.revoked.map((entry) => entry.userId), ['user_a']);
      // Their own machine is still theirs to delete.
      assert.equal((await fetch(`${base}/cloud/v1/runner`, { method: 'DELETE', headers })).status, 202);
      assert.equal(fleet.status('user_a').state, 'deleting');
    } finally {
      await hub.close();
    }
  });
});
