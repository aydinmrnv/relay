import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { adoptConfigOverlay, CONFIG_OVERLAY_VARIABLE, DEFAULT_CONFIG, loadConfig, mergeConfig, setConfigOverlay } from '../src/storage/config.ts';
import { parseClaudeStatus, parseCodexStatus, parseLoginOutput } from '../src/studio/agents.ts';
import { checkInstallPath, installFiles, mergeInstalledConfig } from '../src/studio/install.ts';
import { browserCommand } from '../src/studio/open.ts';
import { studioRunOverlay } from '../src/studio/overlay.ts';
import { loadPairingToken, pairingUrl, tokensMatch } from '../src/studio/pairing.ts';
import type { AgentsStatus, RunStreamRecord } from '../src/studio/protocol.ts';
import { lastError, parseTask, runArguments, StudioRuns, type RelayLauncher } from '../src/studio/runs.ts';
import { createCompanion, type Companion, type CompanionEvent } from '../src/studio/server.ts';

async function tempDir(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'relay-studio-test-')));
}

async function withRelayHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await tempDir();
  const previous = process.env['RELAY_HOME'];
  process.env['RELAY_HOME'] = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env['RELAY_HOME'];
    else process.env['RELAY_HOME'] = previous;
    await rm(home, { recursive: true, force: true });
  }
}

/**
 * Stands in for `relay run --json`: records the argv and the overlay it was
 * handed, prints the engine's stream, and ends the way the scenario says.
 */
const FAKE_RUN = `
import { readFileSync, writeFileSync } from 'node:fs';
const capture = process.env.FAKE_CAPTURE;
const overlay = process.env.${CONFIG_OVERLAY_VARIABLE};
writeFileSync(capture, JSON.stringify({ argv: process.argv.slice(2), overlay: JSON.parse(readFileSync(overlay, 'utf8')) }));
const mode = process.env.FAKE_MODE ?? 'ok';
if (mode === 'precondition') {
  process.stderr.write('\\nError Codex is not signed in.\\n\\nRun \\\`codex login\\\`.\\n\\n');
  process.exit(3);
}
const line = (value) => process.stdout.write(JSON.stringify({ schema: 1, command: 'run', ...value }) + '\\n');
line({ type: 'run_started', at: 'now', runId: '20260101-000000-abc', shortId: 'abc', issueRef: '142', agents: { planner: 'claude' } });
if (mode === 'hang') { setInterval(() => {}, 1000); }
else {
  line({ type: 'phase_started', at: 'now', phase: 'PLANNING', phaseLabel: 'Planning', detail: null });
  line({ type: 'summary', at: 'now', exitCode: 0, run: { runId: '20260101-000000-abc' } });
}
`;

async function fakeLauncher(dir: string): Promise<RelayLauncher> {
  const script = join(dir, 'fake-run.mjs');
  await writeFile(script, FAKE_RUN);
  return { command: process.execPath, args: [script] };
}

function collect(runs: StudioRuns, id: string): Promise<RunStreamRecord[]> {
  return new Promise((resolve) => {
    const records: RunStreamRecord[] = [];
    runs.subscribe(id, (record) => {
      records.push(record);
      if (record.type === 'exit') resolve(records);
    });
  });
}

const COMPILED = {
  version: 1,
  agents: { planner: 'claude', planReviewer: 'codex', implementer: 'codex', codeReviewer: 'claude' },
  models: {},
  harnesses: { evil: { command: 'rm' } },
  workflow: { review: 'standard', deliver: 'merge', maxCostUsd: 4, confirmAboveUsd: 2, offerMerge: true, triggerLabel: 'relay:go', typos: true },
  unattended: { enabled: true, authors: ['someone'] },
  github: { autoPush: true, autoPr: true, autoMerge: true, mergeMethod: 'squash', protectedBranches: [] },
  tests: { command: null },
  delivery: { comment: true },
  notify: { webhook: 'https://hooks.example/x', command: ['sh', '-c', 'echo'] },
};

describe('pairing', () => {
  it('creates a token once, keeps it private, and rotates it on request', async () => {
    await withRelayHome(async (home) => {
      const first = await loadPairingToken();
      assert.equal(first.created, true);
      assert.ok(first.token.length >= 40);
      const again = await loadPairingToken();
      assert.deepEqual(again, { token: first.token, created: false });
      if (process.platform !== 'win32') assert.equal((await stat(join(home, 'studio.json'))).mode & 0o777, 0o600);
      const rotated = await loadPairingToken({ rotate: true });
      assert.equal(rotated.created, true);
      assert.notEqual(rotated.token, first.token);
    });
  });

  it('compares tokens exactly, and puts them only in the fragment of the link', () => {
    assert.equal(tokensMatch('abc', 'abc'), true);
    assert.equal(tokensMatch('abc', 'abd'), false);
    assert.equal(tokensMatch('abc', 'ab'), false);
    assert.equal(tokensMatch('abc', null), false);
    const url = new URL(pairingUrl('https://studio.example/', 4477, 'tok'));
    assert.equal(url.pathname, '/connect');
    assert.equal(url.search, '');
    assert.equal(url.hash, '#port=4477&token=tok');
  });
});

describe('a studio run takes the pipeline from the workflow and the rest from the repository', () => {
  it('keeps the shape, caps delivery at a pull request, and asks nothing', () => {
    const overlay = studioRunOverlay(COMPILED) as Record<string, Record<string, unknown>>;
    assert.deepEqual(overlay['agents'], COMPILED.agents);
    assert.equal(overlay['workflow']?.['deliver'], 'pr');
    assert.equal(overlay['workflow']?.['maxCostUsd'], 4);
    assert.equal(overlay['workflow']?.['offerMerge'], false);
    assert.equal(overlay['workflow']?.['confirmAboveUsd'], null);
    assert.equal(overlay['workflow']?.['typos'], undefined);
    assert.equal(overlay['github']?.['autoMerge'], false);
    assert.equal(overlay['github']?.['autoPr'], true);
    for (const key of ['harnesses', 'unattended', 'notify', 'tests', 'models']) assert.equal(overlay[key], undefined, key);
    assert.deepEqual(overlay['delivery'], { comment: true });
    // What the engine will accept, not just what this module likes.
    const merged = mergeConfig(DEFAULT_CONFIG, overlay);
    assert.equal(merged.workflow.deliver, 'pr');
    assert.equal(merged.github.autoMerge, false);
  });

  it('uses a test command the workflow names', () => {
    const overlay = studioRunOverlay({ ...COMPILED, tests: { command: ['npm', 'test'] } });
    assert.deepEqual(overlay['tests'], { command: ['npm', 'test'] });
  });

  it('is layered over the repository config by loadConfig, and a missing overlay is an error', async () => {
    const root = await tempDir();
    const overlayPath = join(root, 'overlay.json');
    try {
      await mkdir(join(root, '.relay'), { recursive: true });
      await writeFile(join(root, '.relay', 'config.json'), JSON.stringify({ issues: { provider: 'linear', team: 'ENG' }, workflow: { branchPrefix: 'mine' } }));
      await writeFile(overlayPath, JSON.stringify(studioRunOverlay(COMPILED)));
      setConfigOverlay(overlayPath);
      const config = await loadConfig(root);
      assert.equal(config.issues.provider, 'linear');
      assert.equal(config.workflow.branchPrefix, 'mine');
      assert.equal(config.workflow.deliver, 'pr');
      assert.equal(config.workflow.maxCostUsd, 4);
      setConfigOverlay(join(root, 'missing.json'));
      await assert.rejects(loadConfig(root), /ENOENT/);
    } finally {
      setConfigOverlay(undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('is taken out of the environment, so nothing the run spawns inherits it', async () => {
    const env: NodeJS.ProcessEnv = { [CONFIG_OVERLAY_VARIABLE]: '/nowhere/overlay.json', PATH: '/bin' };
    try {
      adoptConfigOverlay(env);
      assert.deepEqual(env, { PATH: '/bin' });
      await assert.rejects(loadConfig(await tempDir()), /ENOENT/);
    } finally {
      setConfigOverlay(undefined);
    }
  });
});

describe('what the studio may ask a run to work on', () => {
  it('accepts issue references and descriptions, and never a flag', () => {
    assert.deepEqual(parseTask({ kind: 'issue', ref: ' 142 ' }), { kind: 'issue', ref: '142' });
    assert.deepEqual(parseTask({ kind: 'issue', ref: 'acme/api#7' }), { kind: 'issue', ref: 'acme/api#7' });
    assert.deepEqual(parseTask({ kind: 'issue', ref: 'https://github.com/acme/api/issues/7' }).kind, 'issue');
    assert.throws(() => parseTask({ kind: 'issue', ref: '--merge' }), /not an issue/);
    assert.throws(() => parseTask({ kind: 'issue', ref: '142 --merge' }), /not an issue/);
    assert.throws(() => parseTask({ kind: 'prompt', text: '   ' }), /empty/);
    assert.throws(() => parseTask({ kind: 'shell', text: 'x' }), /work on/);
  });

  it('spells every argument so the text cannot become an option', () => {
    assert.deepEqual(runArguments({ kind: 'issue', ref: '142' }), ['run', '--json', '--no-offer-merge', '--', '142']);
    assert.deepEqual(runArguments({ kind: 'prompt', text: '--merge everything' }), ['run', '--json', '--no-offer-merge', '--prompt=--merge everything']);
  });

  it('reads the reason a run refused to start from its stderr', () => {
    assert.equal(lastError('\nError Codex is not signed in.\n\nRun `codex login`.\n\n'), 'Codex is not signed in.\nRun `codex login`.');
    assert.equal(lastError('something went sideways\n'), 'something went sideways');
    assert.equal(lastError(''), null);
  });
});

describe('studio runs', () => {
  it('runs `relay run --json` with the overlay and relays its stream verbatim', async () => {
    const dir = await tempDir();
    const capture = join(dir, 'capture.json');
    process.env['FAKE_CAPTURE'] = capture;
    try {
      const runs = new StudioRuns(dir, await fakeLauncher(dir));
      const view = await runs.start({ workflow: { id: 'wf_1', name: 'Ticket to PR' }, config: COMPILED, task: { kind: 'issue', ref: '142' } });
      assert.equal(view.status, 'running');
      const records = await collect(runs, view.id);
      const engine = records.filter((record) => record.type === 'engine');
      assert.deepEqual(engine.map((record) => (record.type === 'engine' ? record.data['type'] : null)), ['run_started', 'phase_started', 'summary']);
      assert.deepEqual(records.at(-1), { seq: 3, type: 'exit', code: 0, error: null });
      assert.equal(runs.get(view.id)?.runId, '20260101-000000-abc');

      const seen = JSON.parse(await readFile(capture, 'utf8')) as { argv: string[]; overlay: Record<string, Record<string, unknown>> };
      assert.deepEqual(seen.argv, ['run', '--json', '--no-offer-merge', '--', '142']);
      assert.equal(seen.overlay['workflow']?.['deliver'], 'pr');

      // A late subscriber gets the whole run, from the first line.
      const replay = await collect(runs, view.id);
      assert.equal(replay.length, records.length);
    } finally {
      delete process.env['FAKE_CAPTURE'];
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('carries the reason a run refused to start', async () => {
    const dir = await tempDir();
    process.env['FAKE_CAPTURE'] = join(dir, 'capture.json');
    process.env['FAKE_MODE'] = 'precondition';
    try {
      const runs = new StudioRuns(dir, await fakeLauncher(dir));
      const view = await runs.start({ workflow: { id: 'wf_1', name: 'W' }, config: COMPILED, task: { kind: 'prompt', text: 'Fix it' } });
      const records = await collect(runs, view.id);
      assert.deepEqual(records.at(-1), { seq: 0, type: 'exit', code: 3, error: 'Codex is not signed in.\nRun `codex login`.' });
    } finally {
      delete process.env['FAKE_CAPTURE'];
      delete process.env['FAKE_MODE'];
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a workflow the engine would refuse, before spawning anything', async () => {
    const dir = await tempDir();
    try {
      const runs = new StudioRuns(dir, await fakeLauncher(dir));
      await assert.rejects(
        runs.start({ workflow: { id: 'w', name: 'W' }, config: { agents: { planner: 'gpt5' } }, task: { kind: 'prompt', text: 'x' } }),
        /does not compile to a config this Relay accepts: Unknown agent "gpt5"/,
      );
      assert.deepEqual(runs.list(), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('installing an export', () => {
  it('only writes relative, export-shaped paths outside .git', () => {
    assert.deepEqual(checkInstallPath('.github/workflows/relay.yml'), ['.github', 'workflows', 'relay.yml']);
    for (const bad of ['../x.json', '/etc/x.json', 'a/../../x.json', '.git/hooks/x.json', '.GIT/config.json', 'C:/x.json', 'a\\b.json', 'run.sh', 'a//b.json', '']) {
      assert.throws(() => checkInstallPath(bad), Error, bad);
    }
  });

  it('merges the config instead of resetting what the repository wrote', () => {
    const merged = mergeInstalledConfig(
      { issues: { provider: 'linear', team: 'ENG' }, tests: { command: ['make', 'check'] }, notify: { system: true, webhook: null }, workflow: { deliver: 'branch', branchPrefix: 'mine' } },
      { workflow: { deliver: 'pr' }, tests: { command: null }, notify: { webhook: null, system: false, bell: false } },
    );
    assert.deepEqual(merged, {
      issues: { provider: 'linear', team: 'ENG' },
      tests: { command: ['make', 'check'] },
      notify: { system: true, webhook: null },
      workflow: { deliver: 'pr', branchPrefix: 'mine' },
    });
  });

  it('reports what it created, updated and left alone, and will not follow a symlink out', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    try {
      await mkdir(join(root, '.relay'), { recursive: true });
      await writeFile(join(root, '.relay', 'config.json'), JSON.stringify({ issues: { provider: 'linear', team: 'ENG' } }));
      const files = [
        { path: '.relay/config.json', content: JSON.stringify({ version: 1, workflow: { deliver: 'pr' } }) },
        { path: '.github/workflows/ticket.yml', content: 'name: x\n' },
      ];
      const first = await installFiles(root, files);
      assert.deepEqual(first.files, [
        { path: '.relay/config.json', status: 'updated' },
        { path: '.github/workflows/ticket.yml', status: 'created' },
      ]);
      const config = JSON.parse(await readFile(join(root, '.relay', 'config.json'), 'utf8')) as Record<string, unknown>;
      assert.deepEqual(config['issues'], { provider: 'linear', team: 'ENG' });
      const second = await installFiles(root, files);
      assert.deepEqual(second.files.map((file) => file.status), ['unchanged', 'unchanged']);

      if (process.platform !== 'win32') {
        await symlink(outside, join(root, 'escape'));
        await assert.rejects(installFiles(root, [{ path: 'escape/x.json', content: '{}' }]), /outside the repository/);
      }
      await assert.rejects(installFiles(root, [{ path: '.relay/config.json', content: '[1]' }]), /not a JSON object/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('the companion server', () => {
  const STATUS: AgentsStatus = {
    bridge: true,
    checkedAt: '2026-01-01T00:00:00.000Z',
    agents: {
      claude: { id: 'claude', name: 'Claude Code', installed: true, version: '2.0.0', loggedIn: true, method: 'subscription', plan: 'max', email: null, installCommand: '', loginCommand: '' },
      codex: { id: 'codex', name: 'Codex', installed: false, version: null, loggedIn: false, method: 'none', plan: null, email: null, installCommand: '', loginCommand: '' },
    },
  };

  async function started(overrides: { runs?: StudioRuns | null; root?: string } = {}): Promise<{ companion: Companion; base: string; events: CompanionEvent[] }> {
    const events: CompanionEvent[] = [];
    const companion = createCompanion({
      token: 'secret-token',
      origins: ['https://studio.example'],
      version: 'test',
      repository: overrides.root === undefined ? null : { root: overrides.root, owner: 'acme', name: 'api', defaultBranch: 'main' },
      runs: overrides.runs ?? null,
      agentsStatus: async () => STATUS,
      log: (event) => events.push(event),
      heartbeatMs: 50,
    });
    const port = await companion.listen(0);
    return { companion, base: `http://127.0.0.1:${port}`, events };
  }

  const auth = { authorization: 'Bearer secret-token' };

  it('greets anyone, and describes this machine only to a paired studio', async () => {
    const { companion, base, events } = await started();
    try {
      assert.deepEqual(await (await fetch(`${base}/v1/hello`)).json(), { product: 'relay', protocol: 1, authorized: false });
      const paired = (await (await fetch(`${base}/v1/hello`, { headers: { ...auth, origin: 'https://studio.example' } })).json()) as Record<string, unknown>;
      assert.equal(paired['authorized'], true);
      assert.deepEqual(paired['capabilities'], ['agents']);
      assert.equal(paired['repository'], null);
      assert.ok(events.some((event) => event.kind === 'paired'));
    } finally {
      await companion.close();
    }
  });

  it('refuses other origins, other host names, and a missing or wrong token', async () => {
    const { companion, base } = await started();
    try {
      const foreign = await fetch(`${base}/v1/agents`, { headers: { ...auth, origin: 'https://evil.example' } });
      assert.equal(foreign.status, 403);
      assert.equal(foreign.headers.get('access-control-allow-origin'), null);
      assert.equal((await fetch(`${base}/v1/agents`)).status, 401);
      assert.equal((await fetch(`${base}/v1/agents`, { headers: { authorization: 'Bearer nope' } })).status, 401);
      const agents = await fetch(`${base}/v1/agents`, { headers: { ...auth, origin: 'https://studio.example' } });
      assert.equal(agents.status, 200);
      assert.equal(agents.headers.get('access-control-allow-origin'), 'https://studio.example');
      assert.deepEqual(await agents.json(), STATUS);
    } finally {
      await companion.close();
    }
  });

  it('answers the preflight, including Chrome’s private-network question', async () => {
    const { companion, base } = await started();
    try {
      const response = await fetch(`${base}/v1/runs`, {
        method: 'OPTIONS',
        headers: { origin: 'https://studio.example', 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' },
      });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('access-control-allow-private-network'), 'true');
      assert.match(response.headers.get('access-control-allow-headers') ?? '', /authorization/);
    } finally {
      await companion.close();
    }
  });

  it('says runs need a repository when it was started outside one', async () => {
    const { companion, base } = await started();
    try {
      const response = await fetch(`${base}/v1/runs`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 409);
    } finally {
      await companion.close();
    }
  });

  it('starts a run, streams it as NDJSON to the end, and refuses a body that is not JSON', async () => {
    const dir = await tempDir();
    process.env['FAKE_CAPTURE'] = join(dir, 'capture.json');
    const runs = new StudioRuns(dir, await fakeLauncher(dir));
    const { companion, base, events } = await started({ runs, root: dir });
    try {
      const form = await fetch(`${base}/v1/runs`, { method: 'POST', headers: { ...auth, 'content-type': 'text/plain' }, body: '{}' });
      assert.equal(form.status, 415);

      const bad = await fetch(`${base}/v1/runs`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ workflow: { id: 'w', name: 'W' }, config: COMPILED, task: { kind: 'issue', ref: '-x' } }) });
      assert.equal(bad.status, 400);

      const response = await fetch(`${base}/v1/runs`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ workflow: { id: 'w', name: 'Ticket to PR' }, config: COMPILED, task: { kind: 'issue', ref: '142' } }),
      });
      assert.equal(response.status, 201);
      const view = (await response.json()) as { id: string };
      const stream = await fetch(`${base}/v1/runs/${view.id}/events`, { headers: auth });
      assert.match(stream.headers.get('content-type') ?? '', /ndjson/);
      const lines = (await stream.text()).trim().split('\n').map((line) => JSON.parse(line) as RunStreamRecord);
      const real = lines.filter((line) => line.type !== 'ping');
      assert.equal(real.at(-1)?.type, 'exit');
      assert.equal(real.filter((line) => line.type === 'engine').length, 3);
      assert.ok(events.some((event) => event.kind === 'run-started' && /issue 142/.test(event.message)));
      const listed = (await (await fetch(`${base}/v1/runs`, { headers: auth })).json()) as { runs: Array<{ id: string; status: string }> };
      assert.equal(listed.runs[0]?.id, view.id);
      assert.equal((await fetch(`${base}/v1/runs/nope/events`, { headers: auth })).status, 404);
    } finally {
      delete process.env['FAKE_CAPTURE'];
      await companion.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stops a run the studio asks it to stop', { skip: process.platform === 'win32' }, async () => {
    const dir = await tempDir();
    process.env['FAKE_CAPTURE'] = join(dir, 'capture.json');
    process.env['FAKE_MODE'] = 'hang';
    const runs = new StudioRuns(dir, await fakeLauncher(dir));
    const { companion, base } = await started({ runs, root: dir });
    try {
      const view = (await (
        await fetch(`${base}/v1/runs`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ workflow: { id: 'w', name: 'W' }, config: COMPILED, task: { kind: 'prompt', text: 'hang' } }),
        })
      ).json()) as { id: string };
      const ended = collect(runs, view.id);
      // Wait for the engine to name the run, as the studio would see it.
      while (runs.get(view.id)?.runId === null) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal((await fetch(`${base}/v1/runs/${view.id}`, { method: 'DELETE', headers: auth })).status, 202);
      const records = await ended;
      assert.equal(records.at(-1)?.type, 'exit');
      assert.equal((await fetch(`${base}/v1/runs/${view.id}`, { method: 'DELETE', headers: auth })).status, 404);
    } finally {
      delete process.env['FAKE_CAPTURE'];
      delete process.env['FAKE_MODE'];
      await companion.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('reading the vendor CLIs', () => {
  it('keeps the sign-in state and the display fields, and nothing else', () => {
    assert.deepEqual(parseClaudeStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'a@b.c', orgId: 'x' }), true), {
      loggedIn: true,
      method: 'subscription',
      plan: 'max',
      email: 'a@b.c',
    });
    assert.deepEqual(parseClaudeStatus('Logged in', true), { loggedIn: true, method: 'unknown', plan: null, email: null });
    assert.equal(parseCodexStatus('Not logged in', false).loggedIn, false);
    assert.equal(parseCodexStatus('Logged in using ChatGPT', true).method, 'subscription');
    assert.equal(parseCodexStatus('Logged in using an API key', true).method, 'api-key');
  });

  it('finds the URL, the device code and the paste prompt in a login transcript', () => {
    const session = { output: 'Open https://auth.example/device?x=1. and enter ABCD-12345\nPaste code here:', url: null, code: null, needsCode: false, agent: 'codex' as const, mode: 'device' as const };
    parseLoginOutput(session);
    assert.equal(session.url, 'https://auth.example/device?x=1');
    assert.equal(session.code, 'ABCD-12345');
    assert.equal(session.needsCode, true);
  });

  it('opens a browser without a shell on every platform', () => {
    assert.deepEqual(browserCommand('https://x.example/?a=1&b=2', 'darwin'), { command: 'open', args: ['https://x.example/?a=1&b=2'] });
    assert.deepEqual(browserCommand('https://x.example/?a=1&b=2', 'win32'), { command: 'rundll32', args: ['url.dll,FileProtocolHandler', 'https://x.example/?a=1&b=2'] });
    assert.equal(browserCommand('https://x', 'linux').command, 'xdg-open');
  });
});
