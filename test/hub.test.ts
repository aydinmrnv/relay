import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runProcess } from '../src/process/runner.ts';
import { checkoutRepository } from '../src/cloud/checkout.ts';
import { dialOut, type DialOut } from '../src/cloud/dialout.ts';
import { mintRunnerToken } from '../src/cloud/hub/auth.ts';
import { Fleet } from '../src/cloud/hub/fleet.ts';
import { createHub, StaticVerifier, type Hub } from '../src/cloud/hub/server.ts';
import { CONFIG_OVERLAY_VARIABLE } from '../src/storage/config.ts';
import type { AgentsStatus, RunStreamRecord } from '../src/studio/protocol.ts';
import { createRouter } from '../src/studio/router.ts';
import { StudioRuns, type RelayLauncher } from '../src/studio/runs.ts';
import { isolatedGitEnv } from './helpers/tempRepo.ts';

/**
 * The hub and a runner, for real: an HTTP server, a WebSocket, the runner's
 * dial-out with its reconnects, a git checkout, and `relay run` played by a
 * script. Only Azure and the coding agents are stand-ins.
 */

const SECRET = 'hub-secret-'.padEnd(48, 'x');
const STUDIO_TOKEN = 'studio-token-0123456789';
const USER = 'user_test';
const ORIGIN = 'https://studio.example';

const FAKE_RUN = `
import { existsSync } from 'node:fs';
const overlay = process.env.${CONFIG_OVERLAY_VARIABLE};
if (!overlay || !existsSync(overlay)) { process.stderr.write('Error no overlay\\n'); process.exit(1); }
const line = (value) => process.stdout.write(JSON.stringify({ schema: 1, command: 'run', ...value }) + '\\n');
line({ type: 'run_started', at: 'now', runId: 'r-' + process.pid, cwd: process.cwd() });
line({ type: 'phase_started', at: 'now', phase: 'PLANNING' });
const gate = process.env.FAKE_GATE;
const finish = () => { line({ type: 'phase_started', at: 'now', phase: 'IMPLEMENTING' }); line({ type: 'summary', at: 'now', exitCode: 0 }); process.exit(0); };
if (gate) { const timer = setInterval(() => { if (existsSync(gate)) { clearInterval(timer); finish(); } }, 25); }
else finish();
process.on('SIGINT', () => { line({ type: 'cancelled', at: 'now' }); process.exit(130); });
`;

const STATUS: AgentsStatus = {
  bridge: true,
  checkedAt: '2026-01-01T00:00:00.000Z',
  agents: {
    claude: { id: 'claude', name: 'Claude Code', installed: true, version: '2.1.0', loggedIn: true, method: 'subscription', plan: 'max', email: null, installCommand: '', loginCommand: '' },
    codex: { id: 'codex', name: 'Codex', installed: true, version: '0.1.0', loggedIn: false, method: 'none', plan: null, email: null, installCommand: '', loginCommand: '' },
  },
};

const CONFIG = {
  version: 1,
  agents: { planner: 'claude', planReviewer: 'codex', implementer: 'codex', codeReviewer: 'claude' },
  workflow: { review: 'standard', deliver: 'pr', maxCostUsd: 4 },
};

describe('the hub, with a runner dialed in', () => {
  let dir: string;
  let remote: string;
  let hub: Hub;
  let base: string;
  // Not connected until the second test: the first looks at a hub with no runner.
  let runner: DialOut | undefined;
  let runs: StudioRuns;
  let fleet: Fleet;
  let router: ReturnType<typeof createRouter>;

  const studio = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${STUDIO_TOKEN}`, origin: ORIGIN, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.headers ?? {}) } });

  async function lines(response: Response, until?: (record: RunStreamRecord) => boolean): Promise<RunStreamRecord[]> {
    const records: RunStreamRecord[] = [];
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const record = JSON.parse(buffer.slice(0, index)) as RunStreamRecord;
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (record.type !== 'ping') records.push(record);
        if (until?.(record) === true) {
          await reader.cancel();
          return records;
        }
      }
    }
    return records;
  }

  async function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  before(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'relay-hub-test-')));
    const env = await isolatedGitEnv(dir);
    const source = join(dir, 'source');
    remote = join(dir, 'remote.git');
    const git = async (args: string[], cwd: string) => {
      const result = await runProcess('git', args, { cwd, env });
      if (!result.ok) throw new Error(result.stderr);
    };
    await runProcess('mkdir', ['-p', source]);
    await git(['init', '-q', '-b', 'main'], source);
    await writeFile(join(source, 'README.md'), 'hello\n');
    await git(['add', '.'], source);
    await git(['commit', '-q', '-m', 'first'], source);
    await git(['clone', '-q', '--bare', source, remote], dir);

    const script = join(dir, 'fake-run.mjs');
    await writeFile(script, FAKE_RUN);
    const launcher: RelayLauncher = { command: process.execPath, args: [script] };

    fleet = new Fleet({ driver: null, regions: [], coresPerRunner: 2, tokenFor: () => '' });
    hub = createHub({ fleet, secret: SECRET, sessions: new StaticVerifier([[STUDIO_TOKEN, USER]]), origins: [ORIGIN], version: 'test', heartbeatMs: 50, resumeWindowMs: 5_000, wakeWaitMs: 500, adminToken: 'admin-token-0123456789' });
    base = `http://127.0.0.1:${await hub.listen(0, '127.0.0.1')}`;

    runs = new StudioRuns(null, launcher, () => undefined, {
      maxConcurrent: 1,
      checkout: (slug, signal) => checkoutRepository(slug, signal, { root: join(dir, 'repos'), remoteFor: () => remote }),
    });
    router = createRouter({
      version: 'test',
      repository: null,
      runs,
      capabilities: ['agents', 'runs', 'repositories', 'github'],
      machine: 'relay-test',
      agentsStatus: async () => STATUS,
      githubStatus: async () => ({ installed: true, version: '2.0.0', loggedIn: true, login: 'octocat', loginCommand: '' }),
    });
  });

  after(async () => {
    await runner?.stop();
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('answers for a person whose runner is not connected, and refuses strangers', async () => {
    const hello = (await (await studio('/v1/hello')).json()) as Record<string, unknown>;
    assert.equal(hello['authorized'], true);
    assert.deepEqual(hello['capabilities'], []);
    assert.equal((hello['cloud'] as { state: string }).state, 'none');

    const asleep = await studio('/v1/agents');
    assert.equal(asleep.status, 503);
    assert.equal(asleep.headers.get('retry-after'), '5');

    assert.equal((await fetch(`${base}/v1/hello`)).status, 401);
    assert.equal((await fetch(`${base}/v1/hello`, { headers: { authorization: 'Bearer nope' } })).status, 401);
    assert.equal((await studio('/v1/hello', { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${base}/admin/v1/fleet`)).status, 404, 'the admin routes do not exist without the admin token');
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  });

  it('carries the studio’s requests to the runner once it dials in', async () => {
    runner = dialOut({ hub: base, token: async () => mintRunnerToken(SECRET, { runner: 'relay-test', userId: USER }), router, runs, minDelayMs: 20, maxDelayMs: 100 });
    await runner.ready;
    await waitFor(() => fleet.isReady(USER));

    const hello = (await (await studio('/v1/hello')).json()) as Record<string, unknown>;
    assert.equal(hello['machine'], 'relay-test');
    assert.deepEqual(hello['capabilities'], ['agents', 'runs', 'repositories', 'github']);
    assert.equal((hello['cloud'] as { state: string }).state, 'ready');

    assert.deepEqual(await (await studio('/v1/agents')).json(), STATUS);
    assert.equal(((await (await studio('/v1/github')).json()) as { login: string }).login, 'octocat');
    assert.equal((await studio('/v1/nope')).status, 404);
  });

  it('runs in the repository the studio names, checked out on the runner, and streams it to the end', async () => {
    const missing = await studio('/v1/runs', { method: 'POST', body: JSON.stringify({ workflow: { id: 'w', name: 'W' }, config: CONFIG, task: { kind: 'prompt', text: 'fix it' } }) });
    assert.equal(missing.status, 400);
    assert.match(((await missing.json()) as { error: string }).error, /owner\/name/);

    const started = await studio('/v1/runs', { method: 'POST', body: JSON.stringify({ workflow: { id: 'w', name: 'W' }, config: CONFIG, task: { kind: 'prompt', text: 'fix it' }, repository: 'acme/widgets' }) });
    assert.equal(started.status, 201);
    const view = (await started.json()) as { id: string; repository: string };
    assert.equal(view.repository, 'acme/widgets');

    const records = await lines(await studio(`/v1/runs/${view.id}/events`));
    assert.equal(records.at(-1)?.type, 'exit');
    assert.equal((records.at(-1) as { code: number }).code, 0);
    const first = records[0] as unknown as { type: 'engine'; data: { cwd: string } };
    assert.equal(first.data.cwd, join(dir, 'repos', 'acme', 'widgets'));
    assert.ok((await stat(join(dir, 'repos', 'acme', 'widgets', 'README.md'))).isFile());
  });

  it('keeps a run’s stream open while the runner reconnects, and picks it up where it left off', async () => {
    const gate = join(dir, 'gate');
    process.env['FAKE_GATE'] = gate;
    try {
      const started = await studio('/v1/runs', { method: 'POST', body: JSON.stringify({ workflow: { id: 'w', name: 'W' }, config: CONFIG, task: { kind: 'prompt', text: 'slow' }, repository: 'acme/widgets' }) });
      const view = (await started.json()) as { id: string };
      const stream = await studio(`/v1/runs/${view.id}/events`);
      const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader();
      const seen: RunStreamRecord[] = [];
      let buffer = '';
      const readUntil = async (check: () => boolean) => {
        while (!check()) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += value;
          let index = buffer.indexOf('\n');
          while (index !== -1) {
            const record = JSON.parse(buffer.slice(0, index)) as RunStreamRecord;
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf('\n');
            if (record.type !== 'ping') seen.push(record);
          }
        }
      };
      await readUntil(() => seen.length >= 2);

      // The hub drops the runner; the run carries on over there, and the runner dials back.
      const admin = { authorization: 'Bearer admin-token-0123456789' };
      const since = async () => ((await (await fetch(`${base}/admin/v1/fleet`, { headers: admin })).json()) as { links: Array<{ since: string }> }).links[0]?.since;
      const before = await since();
      const kicked = await fetch(`${base}/admin/v1/runners/${USER}/disconnect`, { method: 'POST', headers: admin });
      assert.equal(kicked.status, 202);
      for (let tries = 0; ; tries += 1) {
        const now = await since();
        if (now !== undefined && now !== before) break;
        if (tries > 250) throw new Error('the runner never came back');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await writeFile(gate, 'go');

      await readUntil(() => seen.at(-1)?.type === 'exit');
      const seqs = seen.map((record) => record.seq);
      assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'in order');
      assert.equal(new Set(seqs).size, seqs.length, 'nothing twice');
      assert.deepEqual(seqs, seqs.map((_, index) => index), 'nothing missing');
      assert.equal((seen.at(-1) as { code: number }).code, 0);
    } finally {
      delete process.env['FAKE_GATE'];
    }
  });

  it('queues a second run behind the first on a one-run machine, and stops one that is waiting', async () => {
    const gate = join(dir, 'gate2');
    process.env['FAKE_GATE'] = gate;
    try {
      const body = (text: string) => JSON.stringify({ workflow: { id: 'w', name: 'W' }, config: CONFIG, task: { kind: 'prompt', text }, repository: 'acme/widgets' });
      const first = (await (await studio('/v1/runs', { method: 'POST', body: body('one') })).json()) as { id: string };
      const second = (await (await studio('/v1/runs', { method: 'POST', body: body('two') })).json()) as { id: string; stage: string };
      assert.equal(second.stage, 'queued');
      const third = (await (await studio('/v1/runs', { method: 'POST', body: body('three') })).json()) as { id: string };

      assert.equal((await studio(`/v1/runs/${third.id}`, { method: 'DELETE' })).status, 202);
      const stopped = await lines(await studio(`/v1/runs/${third.id}/events`));
      assert.equal((stopped.at(-1) as { code: number }).code, 130);

      await writeFile(gate, 'go');
      for (const id of [first.id, second.id]) {
        const records = await lines(await studio(`/v1/runs/${id}/events`));
        assert.equal((records.at(-1) as { code: number }).code, 0);
      }
    } finally {
      delete process.env['FAKE_GATE'];
    }
  });
});
