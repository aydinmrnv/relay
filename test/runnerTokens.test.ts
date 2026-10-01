import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readHubConfig } from '../src/cli/commands/hub.ts';
import { mintRunnerToken, verifyRunnerToken } from '../src/cloud/hub/auth.ts';
import { AzureDriver } from '../src/cloud/hub/azure.ts';
import { runnerCloudInit, runnerFiles } from '../src/cloud/hub/cloudInit.ts';
import type { CloudDriver, CloudMachine, MachineSpec, RegionCapacity } from '../src/cloud/hub/driver.ts';
import { Fleet, runnerName } from '../src/cloud/hub/fleet.ts';
import { createHub, StaticVerifier } from '../src/cloud/hub/server.ts';
import { parseTokenSource, tokenReader } from '../src/cloud/runner.ts';

/**
 * Runner tokens that stop being good (CLOUD-02), and a hub secret that can be
 * replaced (CLOUD-07). Azure is an in-memory stand-in throughout: what these
 * tests show is the hub's own rules, not that Azure applies a rotated token.
 */

const SECRET = 'hub-secret-'.padEnd(48, 'x');
const USER = 'user_a';
const NAME = runnerName('relay', USER);
const IDLE = { runs: 0, queued: 0, logins: 0 };

/** A cloud that keeps what it was given: the token each machine would boot with, and the id recorded beside it. */
class MemoryCloud implements CloudDriver {
  readonly machines = new Map<string, CloudMachine>();
  readonly tokens = new Map<string, string>();
  readonly calls: string[] = [];
  failRotate: Error | null = null;

  async list(): Promise<CloudMachine[]> {
    return [...this.machines.values()].map((machine) => ({ ...machine }));
  }
  async create(spec: MachineSpec): Promise<void> {
    this.calls.push(`create ${spec.name}`);
    this.machines.set(spec.name, { name: spec.name, userId: spec.userId, region: spec.region, power: 'running', provisioning: 'succeeded', createdAt: Date.now(), tokenId: spec.tokenId });
    this.tokens.set(spec.name, spec.token);
  }
  async rotateToken(machine: Pick<CloudMachine, 'name'>, token: { token: string; id: string }): Promise<void> {
    this.calls.push(`rotate ${machine.name}`);
    if (this.failRotate !== null) throw this.failRotate;
    this.machines.get(machine.name)!.tokenId = token.id;
    this.tokens.set(machine.name, token.token);
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
    return { usedCores: 0, limitCores: 100 };
  }
}

function setup(cloud = new MemoryCloud()) {
  let time = 1_800_000_000_000;
  const clock = { now: () => time, advance: (ms: number) => (time += ms) };
  const fleet = new Fleet({
    driver: cloud,
    regions: ['northcentralus'],
    coresPerRunner: 2,
    tokenFor: (runner, userId) => mintRunnerToken(SECRET, { runner, userId }, { kind: 'managed', now: clock.now() }),
    now: clock.now,
  });
  /** The token the machine would read from its user data right now, as the hub would see it presented. */
  const held = () => verifyRunnerToken(SECRET, cloud.tokens.get(NAME), clock.now())!;
  const link = () => ({ close: () => undefined });
  return { cloud, clock, fleet, held, link };
}

/** Sleeps an awake machine and lets the cloud catch up. */
async function sleep(context: ReturnType<typeof setup>, connection: { close: () => void }): Promise<void> {
  await context.fleet.sleep(USER, { force: true });
  context.fleet.disconnected(USER, connection);
  context.clock.advance(2 * 60_000);
  await context.fleet.reconcile();
  assert.equal(context.fleet.status(USER).state, 'asleep');
}

describe('a runner token', () => {
  it('is different every time, even for the same machine, and says when it was made', () => {
    const a = mintRunnerToken(SECRET, { runner: 'relay-abc', userId: 'user_1' }, { kind: 'managed', now: 1_800_000_000_000 });
    const b = mintRunnerToken(SECRET, { runner: 'relay-abc', userId: 'user_1' }, { kind: 'managed', now: 1_800_000_000_000 });
    assert.notEqual(a.token, b.token);
    assert.notEqual(a.id, b.id);
    const read = verifyRunnerToken(SECRET, a.token, 1_800_000_001_000);
    assert.deepEqual(read, { runner: 'relay-abc', userId: 'user_1', kind: 'managed', id: a.id, issuedAt: 1_800_000_000_000, expiresAt: a.expiresAt });
    assert.ok(a.token.startsWith('rr2.'));
  });

  it('expires, is not good before it was made, and is not good in the old permanent format', () => {
    const day = 24 * 60 * 60_000;
    const now = 1_800_000_000_000;
    const own = mintRunnerToken(SECRET, { runner: 'my-server', userId: 'user_1' }, { now });
    assert.equal(own.kind, 'own');
    assert.equal(own.expiresAt, now + 30 * day, 'thirty days unless asked otherwise');
    assert.ok(verifyRunnerToken(SECRET, own.token, now + 29 * day) !== null);
    assert.equal(verifyRunnerToken(SECRET, own.token, now + 30 * day), null);
    const short = mintRunnerToken(SECRET, { runner: 'my-server', userId: 'user_1' }, { now, ttlMs: day });
    assert.equal(verifyRunnerToken(SECRET, short.token, now + day + 1_000), null);
    // Made "an hour from now": a clock a few minutes out is fine, an hour is not.
    assert.ok(verifyRunnerToken(SECRET, own.token, now - 4 * 60_000) !== null);
    assert.equal(verifyRunnerToken(SECRET, own.token, now - 60 * 60_000), null);

    // What every token used to be: the machine and its owner, signed, and nothing else. Never accepted again.
    const payload = Buffer.from(JSON.stringify({ r: 'relay-abc', u: 'user_1' })).toString('base64url');
    assert.equal(verifyRunnerToken(SECRET, `rr1.${payload}.${own.token.split('.')[2]}`, now), null);
    const noId = Buffer.from(JSON.stringify({ r: 'relay-abc', u: 'user_1', k: 'm', iat: now / 1000, exp: now / 1000 + 60 })).toString('base64url');
    assert.equal(verifyRunnerToken(SECRET, `rr2.${noId}.${own.token.split('.')[2]}`, now), null);
  });

  it('is still read under a secret the hub used before, and not under one it never had', () => {
    const before = 'earlier-secret-'.padEnd(48, 'y');
    const old = mintRunnerToken(before, { runner: 'relay-abc', userId: 'user_1' }, { kind: 'managed' });
    assert.equal(verifyRunnerToken(SECRET, old.token), null, 'a hub that has dropped the old secret refuses it');
    assert.equal(verifyRunnerToken([SECRET, before], old.token)?.id, old.id, 'one that still lists it reads it');
    assert.equal(verifyRunnerToken([SECRET, 'another-secret-'.padEnd(48, 'z')], old.token), null);
    assert.equal(verifyRunnerToken([], old.token), null);
  });
});

describe('which runner tokens the fleet takes', () => {
  it('takes a managed machine’s current token, and only while the hub wants the machine awake', async () => {
    const context = setup();
    const { fleet, held, link } = context;
    await fleet.wake(USER);
    const first = held();
    assert.deepEqual(fleet.admits(first), { ok: true });
    const connection = link();
    assert.equal(fleet.connected(first, connection, IDLE), true);

    await sleep(context, connection);
    const asleep = fleet.admits(first);
    assert.equal(asleep.ok, false);
    assert.equal(asleep.ok === false && asleep.status, 409, 'a copied token cannot turn a sleeping machine into a connected one');
    assert.equal(fleet.connected(first, link(), IDLE), false);
    assert.equal(fleet.status(USER).state, 'asleep');
  });

  it('issues a new token at every start, and refuses the one from the start before', async () => {
    const context = setup();
    const { cloud, fleet, held, link } = context;
    await fleet.wake(USER);
    const first = held();
    const connection = link();
    fleet.connected(first, connection, IDLE);
    await sleep(context, connection);

    await fleet.wake(USER);
    assert.deepEqual(cloud.calls.slice(-2), [`rotate ${NAME}`, `start ${NAME}`], 'the new token is in place before the machine starts');
    const second = held();
    assert.notEqual(second.id, first.id);
    assert.deepEqual(fleet.admits(second), { ok: true });
    const stale = fleet.admits(first);
    assert.equal(stale.ok === false && stale.status, 401);
    assert.match(stale.ok === false ? stale.reason : '', /earlier start/);
  });

  it('does not start a machine whose token it could not replace', async () => {
    const context = setup();
    const { cloud, fleet, held, link } = context;
    await fleet.wake(USER);
    const connection = link();
    fleet.connected(held(), connection, IDLE);
    await sleep(context, connection);

    cloud.failRotate = new Error('Azure said no');
    const status = await fleet.wake(USER);
    assert.ok(!cloud.calls.includes(`start ${NAME}`), 'starting it would leave the old token good for another stretch');
    assert.notEqual(status.state, 'starting');
    assert.match(status.error ?? '', /Azure said no/);
  });

  it('refuses a removed machine’s token at once, while the cloud still lists the machine', async () => {
    const context = setup();
    const { cloud, fleet, held, link } = context;
    await fleet.wake(USER);
    const token = held();
    fleet.connected(token, link(), IDLE);

    // Azure takes a while to delete a VM; the fake keeps it listed, as Azure would.
    const listed = { ...cloud.machines.get(NAME)! };
    await fleet.remove(USER);
    cloud.machines.set(NAME, listed);
    await fleet.reconcile();

    const refused = fleet.admits(token);
    assert.equal(refused.ok === false && refused.status, 401);
    assert.equal(fleet.connected(token, link(), IDLE), false, 'and the runner that dials straight back is not let in');
  });

  it('remembers which token is current across a hub restart, from what the cloud recorded', async () => {
    const context = setup();
    const { cloud, clock, fleet, held, link } = context;
    await fleet.wake(USER);
    const first = held();
    const connection = link();
    fleet.connected(first, connection, IDLE);
    await sleep(context, connection);
    await fleet.wake(USER);
    const current = held();

    const restarted = new Fleet({ driver: cloud, regions: ['northcentralus'], coresPerRunner: 2, tokenFor: () => ({ token: '', id: '' }), now: clock.now });
    const early = restarted.admits(current);
    assert.equal(early.ok === false && early.status, 503, 'before it has read its machines it says "later", not "no"');
    await restarted.reconcile();
    assert.deepEqual(restarted.admits(current), { ok: true });
    assert.equal(restarted.admits(first).ok, false);
  });

  it('never lets a hand-minted token name a managed machine, and takes one for a runner of someone’s own', () => {
    const { fleet } = setup();
    const own = mintRunnerToken(SECRET, { runner: 'my-server', userId: USER });
    assert.deepEqual(fleet.admits(own), { ok: true });
    const impostor = mintRunnerToken(SECRET, { runner: NAME, userId: USER });
    assert.equal(fleet.admits(impostor).ok, false);
    const elsewhere = mintRunnerToken(SECRET, { runner: 'relay-somewhere', userId: USER }, { kind: 'managed' });
    assert.equal(fleet.admits(elsewhere).ok, false);

    const unmanaged = new Fleet({ driver: null, regions: [], coresPerRunner: 2, tokenFor: () => ({ token: '', id: '' }) });
    assert.deepEqual(unmanaged.admits(own), { ok: true });
    assert.equal(unmanaged.admits(mintRunnerToken(SECRET, { runner: NAME, userId: USER }, { kind: 'managed' })).ok, false, 'a hub that makes no machines has issued no managed token');
  });
});

describe('the hub, asked to let a runner in', () => {
  it('lets in the machine’s current token, turns away a stale one, and turns both away once the machine is removed', async () => {
    const cloud = new MemoryCloud();
    const fleet = new Fleet({ driver: cloud, regions: ['northcentralus'], coresPerRunner: 2, tokenFor: (runner, userId) => mintRunnerToken(SECRET, { runner, userId }, { kind: 'managed' }) });
    const hub = createHub({ fleet, secret: SECRET, previousSecrets: [], sessions: new StaticVerifier([['studio-token-0123456789', USER]]), origins: ['https://studio.example'], version: 'test', adminToken: 'admin-token-0123456789' });
    const base = `http://127.0.0.1:${await hub.listen(0, '127.0.0.1')}`;
    const studio = { authorization: 'Bearer studio-token-0123456789' };

    /** Dials in as a runner would: resolves 'open' or 'refused'. */
    const dial = (token: string): Promise<'open' | 'refused'> =>
      new Promise((resolve) => {
        const ws = new WebSocket(`${base.replace('http:', 'ws:')}/v1/runner/connect`, { headers: { authorization: `Bearer ${token}` } } as unknown as string[]);
        ws.addEventListener('open', () => {
          ws.send(JSON.stringify({ t: 'hello', hello: { product: 'relay', protocol: 1, authorized: true }, activity: IDLE }));
          resolve('open');
        });
        ws.addEventListener('error', () => resolve('refused'));
      });

    try {
      assert.equal((await fetch(`${base}/cloud/v1/runner/wake`, { method: 'POST', headers: studio })).status, 202);
      const current = cloud.tokens.get(NAME)!;
      const stale = mintRunnerToken(SECRET, { runner: NAME, userId: USER }, { kind: 'managed' }).token;
      assert.equal(await dial(stale), 'refused', 'signed by the hub, but not the token this machine was given');
      assert.equal(await dial('rr2.not.atoken'), 'refused');
      assert.equal(await dial(current), 'open');
      for (let tries = 0; fleet.status(USER).state !== 'ready'; tries += 1) {
        if (tries > 200) throw new Error('the runner never became ready');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      assert.equal((await fetch(`${base}/cloud/v1/runner`, { method: 'DELETE', headers: studio })).status, 202);
      assert.equal(await dial(current), 'refused', 'removing the machine ends its token');

      // The operator's route mints a token that expires, and not one that could pass for a managed machine.
      const admin = { authorization: 'Bearer admin-token-0123456789', 'content-type': 'application/json' };
      const minted = (await (await fetch(`${base}/admin/v1/tokens`, { method: 'POST', headers: admin, body: JSON.stringify({ userId: USER, runner: 'my-server', ttlDays: 2 }) })).json()) as { token: string; expiresAt: string };
      const read = verifyRunnerToken(SECRET, minted.token)!;
      assert.equal(read.kind, 'own');
      assert.ok(Math.abs(Date.parse(minted.expiresAt) - Date.now() - 2 * 24 * 60 * 60_000) < 5_000);
      assert.equal((await fetch(`${base}/admin/v1/tokens`, { method: 'POST', headers: admin, body: JSON.stringify({ userId: USER, runner: NAME }) })).status, 400);
      assert.equal((await fetch(`${base}/admin/v1/tokens`, { method: 'POST', headers: admin, body: JSON.stringify({ userId: USER, runner: 'my-server', ttlDays: 4000 }) })).status, 400);
    } finally {
      await hub.close();
    }
  });
});

describe('replacing a machine’s token on Azure', () => {
  it('sends the new token as user data and its id in the tags, in one request', async () => {
    const requests: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if (url.startsWith('http://169.254.169.254')) return new Response(JSON.stringify({ access_token: 'arm', expires_on: String(Math.floor(Date.now() / 1000) + 3600) }));
      requests.push({ method: init.method ?? 'GET', url, body: init.body === undefined ? null : (JSON.parse(String(init.body)) as Record<string, unknown>) });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const driver = new AzureDriver({
      subscriptionId: 'sub', resourceGroup: 'relay-cloud', credential: 'managed-identity', vmSize: 'Standard_B2ats_v2', image: 'Canonical:ubuntu-24_04-lts:server:latest',
      osDiskType: 'StandardSSD_LRS', osDiskGb: 32, adminUser: 'relay', sshPublicKey: 'ssh-ed25519 AAAA test', customData: () => '', fetchImpl,
    });
    await driver.rotateToken({ name: 'relay-abc', region: 'spaincentral', userId: 'user_1' }, { token: 'rr2.new.token', id: 'token-id-2' });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.method, 'PATCH');
    assert.match(requests[0]?.url ?? '', /virtualMachines\/relay-abc\?api-version=/);
    // A PATCH replaces the whole tag set, so the owner and the role go with the new id.
    assert.deepEqual(requests[0]?.body, { tags: { 'relay-role': 'runner', 'relay-user': 'user_1', 'relay-token': 'token-id-2' }, properties: { userData: Buffer.from('rr2.new.token').toString('base64') } });
  });
});

describe('the hub’s secret', () => {
  it('can be replaced: earlier secrets are listed, from the environment or a file that may not exist yet', async () => {
    const key = `pk_test_${Buffer.from('clever-cat-1.clerk.accounts.dev$').toString('base64')}`;
    const base = { RELAY_HUB_SECRET: 'n'.repeat(40), CLERK_PUBLISHABLE_KEY: key };
    assert.deepEqual((await readHubConfig(base)).previousSecrets, []);
    assert.deepEqual((await readHubConfig({ ...base, RELAY_HUB_SECRET_PREVIOUS: `${'o'.repeat(40)}, ${'p'.repeat(40)}` })).previousSecrets, ['o'.repeat(40), 'p'.repeat(40)]);
    await assert.rejects(readHubConfig({ ...base, RELAY_HUB_SECRET_PREVIOUS: 'short' }), /shorter than 32/);

    const dir = await mkdtemp(join(tmpdir(), 'relay-hub-secret-'));
    try {
      const file = join(dir, 'hub-secret.previous');
      assert.deepEqual((await readHubConfig({ ...base, RELAY_HUB_SECRET_PREVIOUS_FILE: file })).previousSecrets, [], 'a hub that has never rotated has no such file');
      await writeFile(file, `${'o'.repeat(40)}\n${'n'.repeat(40)}\n`);
      assert.deepEqual((await readHubConfig({ ...base, RELAY_HUB_SECRET_PREVIOUS_FILE: file })).previousSecrets, ['o'.repeat(40)], 'the current secret is not also a previous one');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('where a runner reads its token', () => {
  it('takes it from standard input once, at the start, and refuses to start without one', async () => {
    assert.deepEqual(parseTokenSource('stdin'), { kind: 'stdin' });
    let reads = 0;
    const read = tokenReader({ kind: 'stdin' }, fetch, () => {
      reads += 1;
      return 'rr2.a.b\n';
    });
    assert.equal(await read(), 'rr2.a.b');
    assert.equal(await read(), 'rr2.a.b');
    assert.equal(reads, 1, 'the pipe is read once; the token then lives only in this process');
    assert.throws(() => tokenReader({ kind: 'stdin' }, fetch, () => ''), /No runner token on standard input/);
    assert.throws(() => parseTokenSource('somewhere'), /not a token source/);
  });
});

describe('what a managed runner machine boots with', () => {
  const options = { hubUrl: 'https://hub.example.com', maxRuns: 1, adminUser: 'relay' };

  it('closes the metadata service to everyone but root before anything else, and will not start without that', () => {
    const { prepare, start, service } = runnerFiles(options);
    const rule = 'OUTPUT -d 169.254.169.254 -m owner ! --uid-owner 0 -j REJECT';
    assert.ok(prepare.includes(`iptables -C ${rule} 2>/dev/null || iptables -I ${rule}`));
    assert.ok(prepare.indexOf(`iptables -I ${rule}`) < prepare.indexOf('installing Node'), 'before any install');
    assert.match(prepare, /could not close the instance metadata service[^\n]*\n\s+exit 1/);
    assert.ok(start.indexOf(`iptables -C ${rule}`) < start.indexOf('/metadata/instance/compute/userData'), 'the token is not read until the rule is seen to be there');
    assert.match(start, /not closed to other users; not starting"\n\s+exit 1/);
    assert.match(service, /^ExecStartPre=\/usr\/local\/bin\/relay-runner-prepare$/m);
    assert.match(service, /^ExecStart=\/usr\/local\/bin\/relay-runner-start$/m);
    assert.match(service, /^LimitCORE=0$/m);
    assert.ok(!/^User=/m.test(service), 'the service starts as root and the start step drops to the runner’s user');
  });

  it('runs the runner as a user that cannot become root, and gives it the token down a pipe', () => {
    const { prepare, start } = runnerFiles(options);
    assert.match(prepare, /useradd --create-home --shell \/bin\/bash "\$run_user"/);
    assert.match(prepare, /is in a group that leads to root; not starting"\n\s+exit 1/);
    assert.match(start, /setpriv --reuid "\$run_user" --regid "\$run_user" --init-groups \\\n\s+relay connect --hub "\$hub" --token-from stdin < <\(printf '%s' "\$token"\)/);
    assert.match(start, /exec env -i /, 'nothing of root’s environment reaches the runner');
    assert.ok(!/RELAY_RUNNER_TOKEN|--token-from (azure|file)/.test(start + prepare), 'not in the environment, not in a file, not read by the runner itself');
    // The admin user Azure makes has passwordless sudo: the runner must never be it.
    assert.throws(() => runnerFiles({ ...options, adminUser: 'relay-run' }), /can become root/);
    assert.throws(() => runnerFiles({ ...options, runUser: 'root' }), /can become root/);
    assert.throws(() => runnerFiles({ ...options, runUser: 'Bad User' }), /not a user name/);

    const text = runnerCloudInit(options);
    assert.match(text, /kernel\.yama\.ptrace_scope = 1/);
    assert.match(text, /path: \/etc\/cron\.allow/);
    assert.match(text, /systemctl disable --now apport\.service/);
  });

  it('is shell that parses', { skip: process.platform === 'win32' || spawnSync('bash', ['--version']).status !== 0 }, () => {
    const { prepare, start } = runnerFiles(options);
    for (const [name, script] of [['prepare', prepare], ['start', start]] as const) {
      const checked = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
      assert.equal(checked.status, 0, `${name}: ${checked.stderr}`);
    }
  });
});
