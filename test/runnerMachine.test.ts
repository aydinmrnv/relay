import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { readHubConfig } from '../src/cli/commands/hub.ts';
import { runnerCloudInit, runnerFiles } from '../src/cloud/hub/cloudInit.ts';
import { Fleet } from '../src/cloud/hub/fleet.ts';
import { createHub, StaticVerifier } from '../src/cloud/hub/server.ts';

/**
 * What a runner machine installs as root, and from where (CLOUD-12).
 *
 * The start-up script cannot be run on a real machine from here, so it is run
 * on this one: the script the hub would send, with the directories it writes
 * to moved under a temporary root and the programs it calls — curl, npm,
 * iptables, apt-get — replaced by stand-ins that record what they were asked.
 * That shows the script's own decisions. It does not show that a VM boots.
 */

const POSIX = process.platform !== 'win32' && spawnSync('bash', ['--version']).status === 0;
const OPTIONS = { hubUrl: 'https://hub.example.com', maxRuns: 1, adminUser: 'relay', claudeCodeVersion: '2.0.0', codexVersion: '0.40.0' };

interface Sandbox {
  root: string;
  /** Runs the prepare script; resolves with its exit code, what it printed and what the stand-ins were asked. */
  run(): Promise<{ status: number | null; output: string; calls: string[] }>;
  /** What the hub answers to `HEAD /runner/relay.tgz`. */
  headers(lines: Record<string, string>): Promise<void>;
  file(path: string): Promise<string | null>;
  done(): Promise<void>;
}

async function sandbox(options = OPTIONS): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), 'relay-runner-machine-'));
  const bin = join(root, 'bin');
  const state = join(root, 'state');
  await mkdir(bin, { recursive: true });
  await mkdir(state, { recursive: true });
  await mkdir(join(root, 'var', 'lib', 'relay-runner'), { recursive: true });
  await writeFile(join(state, 'relay.tgz'), 'the relay package');

  const stub = async (name: string, body: string) => {
    await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(bin, name), 0o755);
  };
  const record = `echo "$(basename "$0") $*" >> "${state}/calls"`;
  await stub('iptables', `${record}\n[ -f "${state}/iptables-fails" ] && exit 1\nexit 0`);
  await stub('id', `[ "$1" = "-nG" ] && echo "relay-run"\nexit 0`);
  for (const name of ['useradd', 'passwd', 'apt-get', 'gh']) await stub(name, `${record}\nexit 0`);
  await stub('sleep', 'exit 0');
  await stub('timeout', 'shift\nexec "$@"');
  await stub('sha256sum', 'if [ -x /usr/bin/sha256sum ]; then exec /usr/bin/sha256sum "$@"; else exec shasum -a 256 "$@"; fi');
  // HEAD asks what the hub serves; a download writes the package where it was told to.
  await stub(
    'curl',
    `${record}
out=""; head=""
while [ $# -gt 0 ]; do case "$1" in -fsSI) head=yes ;; -o) out="$2"; shift ;; esac; shift; done
if [ -n "$head" ]; then [ -f "${state}/headers" ] && cat "${state}/headers"; exit 0; fi
[ -n "$out" ] && cp "${state}/relay.tgz" "$out"
exit 0`,
  );
  // Installing a package makes its command exist, as the real npm would.
  await stub(
    'npm',
    `${record}
for arg in "$@"; do
  case "$arg" in
    @anthropic-ai/claude-code@*) printf '#!/bin/sh\\n' > "${bin}/claude"; chmod +x "${bin}/claude" ;;
    @openai/codex@*) printf '#!/bin/sh\\n' > "${bin}/codex"; chmod +x "${bin}/codex" ;;
    *relay.tgz) printf '#!/bin/sh\\n' > "${bin}/relay"; chmod +x "${bin}/relay" ;;
  esac
done
exit 0`,
  );

  const script = runnerFiles(options).prepare.replaceAll('/var/lib/relay-runner', join(root, 'var', 'lib', 'relay-runner'));
  await writeFile(join(root, 'prepare.sh'), script);

  return {
    root,
    run: async () => {
      await rm(join(state, 'calls'), { force: true });
      const result = spawnSync('bash', [join(root, 'prepare.sh')], { env: { ...process.env, PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}` }, encoding: 'utf8' });
      const calls = (await readFile(join(state, 'calls'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
      return { status: result.status, output: `${result.stdout}${result.stderr}`, calls };
    },
    headers: async (lines) => {
      const text = ['HTTP/1.1 200 OK', ...Object.entries(lines).map(([name, value]) => `${name}: ${value}`), '', ''].join('\r\n');
      await writeFile(join(state, 'headers'), text);
    },
    file: (path) => readFile(join(root, path), 'utf8').catch(() => null),
    done: () => rm(root, { recursive: true, force: true }),
  };
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const installs = (calls: string[]): string[] => calls.filter((call) => call.startsWith('npm install'));

describe('what a runner machine installs when it starts', { skip: !POSIX }, () => {
  it('installs Relay only when the file is the one the hub described', async () => {
    const box = await sandbox();
    try {
      await box.headers({ 'x-relay-version': '0.1.0+abc', 'x-relay-sha256': sha('some other bytes') });
      const wrong = await box.run();
      assert.equal(wrong.status, 0, wrong.output);
      assert.match(wrong.output, /is not the one the hub described/);
      assert.ok(!installs(wrong.calls).some((call) => call.includes('relay.tgz')), 'a package with the wrong hash is not installed');
      assert.equal(await box.file('var/lib/relay-runner/relay-version'), null);

      // No hash at all is no better than a wrong one.
      await box.headers({ 'x-relay-version': '0.1.0+abc' });
      assert.ok(!installs((await box.run()).calls).some((call) => call.includes('relay.tgz')));

      await box.headers({ 'x-relay-version': '0.1.0+abc', 'x-relay-sha256': sha('the relay package') });
      const right = await box.run();
      assert.ok(installs(right.calls).some((call) => call.includes('relay.tgz')));
      assert.equal((await box.file('var/lib/relay-runner/relay-version'))?.trim(), '0.1.0+abc');

      // Already on the hub's version: nothing is downloaded or installed again.
      const again = await box.run();
      assert.ok(!installs(again.calls).some((call) => call.includes('relay.tgz')));
      assert.ok(!again.calls.some((call) => call.startsWith('curl') && call.includes(' -o ')));
    } finally {
      await box.done();
    }
  });

  it('installs the coding CLIs at the versions it was made with, once, and follows the hub when it names others', async () => {
    const box = await sandbox();
    try {
      await box.headers({ 'x-relay-version': '0.1.0+abc', 'x-relay-sha256': sha('the relay package') });
      const first = await box.run();
      assert.ok(installs(first.calls).includes('npm install -g --no-audit --no-fund @anthropic-ai/claude-code@2.0.0 @openai/codex@0.40.0'), first.calls.join('\n'));
      assert.ok(!first.calls.join('\n').includes('@latest'));

      const second = await box.run();
      assert.deepEqual(installs(second.calls), [], 'a pinned version is not fetched again on every start');

      // The operator changes the pin on the hub: machines that already exist follow at their next start.
      await box.headers({ 'x-relay-version': '0.1.0+abc', 'x-relay-sha256': sha('the relay package'), 'x-relay-claude-code': '2.1.0', 'x-relay-codex': '0.40.0' });
      assert.deepEqual(installs((await box.run()).calls), ['npm install -g --no-audit --no-fund @anthropic-ai/claude-code@2.1.0 @openai/codex@0.40.0']);

      // A header that is not a version is not passed to npm, or to the shell.
      await box.headers({ 'x-relay-version': '0.1.0+abc', 'x-relay-sha256': sha('the relay package'), 'x-relay-claude-code': '2.1.0; rm -rf /', 'x-relay-codex': '$(reboot)' });
      const hostile = await box.run();
      assert.deepEqual(installs(hostile.calls), ['npm install -g --no-audit --no-fund @anthropic-ai/claude-code@2.0.0 @openai/codex@0.40.0'], 'it falls back to the versions it was made with');
      // Nor one that starts like an option.
      await box.headers({ 'x-relay-version': '0.1.0+abc', 'x-relay-sha256': sha('the relay package'), 'x-relay-claude-code': '-g', 'x-relay-codex': '--prefix' });
      assert.deepEqual(installs((await box.run()).calls), [], 'the versions it was made with are already there');
    } finally {
      await box.done();
    }
  });

  it('closes the metadata service first, and does nothing else if it cannot', async () => {
    const box = await sandbox();
    try {
      await writeFile(join(box.root, 'state', 'iptables-fails'), '');
      const result = await box.run();
      assert.equal(result.status, 1);
      assert.match(result.output, /could not close the instance metadata service/);
      assert.deepEqual(result.calls.filter((call) => !call.startsWith('iptables')), [], 'nothing was fetched or installed');
      assert.ok(result.calls.includes('iptables -I OUTPUT -d 169.254.169.254 -m owner ! --uid-owner 0 -j REJECT'));
    } finally {
      await box.done();
    }
  });
});

describe('how a runner machine hands the runner its token', { skip: !POSIX }, () => {
  const TOKEN = 'rr2.payload.signature';

  /** Runs the real start script with the system's programs replaced, and the runner by something that writes down what it was given. */
  async function start(options: { iptables?: 'missing-rule' } = {}): Promise<{ status: number | null; output: string; stdin: string | null; env: string | null; argv: string | null; root: string; done: () => Promise<void> }> {
    const root = await mkdtemp(join(tmpdir(), 'relay-runner-start-'));
    const bin = join(root, 'bin');
    await mkdir(bin, { recursive: true });
    await mkdir(join(root, 'home'), { recursive: true });
    const stub = async (name: string, body: string) => {
      await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
      await chmod(join(bin, name), 0o755);
    };
    await stub('iptables', options.iptables === 'missing-rule' ? 'exit 1' : 'exit 0');
    await stub('getent', `echo "relay-run:x:1001:1001::${root}/home:/bin/bash"`);
    await stub('sleep', 'exit 0');
    // The instance metadata service, answering as Azure does: the user data, in base64.
    await stub('curl', `printf '%s' '${Buffer.from(TOKEN).toString('base64')}'`);
    // Drops to the unprivileged user on a real machine; here it only has to pass the command on.
    await stub('setpriv', 'while [ $# -gt 0 ]; do case "$1" in --reuid|--regid) shift 2 ;; --init-groups) shift ;; *) break ;; esac; done\nexec "$@"');
    await stub('relay', `cat > "${root}/stdin"\nenv > "${root}/env"\necho "$*" > "${root}/argv"`);

    const script = runnerFiles(OPTIONS).start.replace('PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', `PATH=${bin}:/usr/bin:/bin`);
    await writeFile(join(root, 'start.sh'), script);
    const result = spawnSync('bash', [join(root, 'start.sh')], { env: { ...process.env, PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`, SECRET_OF_ROOT: 'must-not-reach-the-runner' }, encoding: 'utf8' });
    const read = (name: string) => readFile(join(root, name), 'utf8').catch(() => null);
    return { status: result.status, output: `${result.stdout}${result.stderr}`, stdin: await read('stdin'), env: await read('env'), argv: await read('argv'), root, done: () => rm(root, { recursive: true, force: true }) };
  }

  it('gives it on standard input and nowhere else: not in the environment, not in the arguments', async () => {
    const run = await start();
    try {
      assert.equal(run.status, 0, run.output);
      assert.equal(run.stdin, TOKEN, 'the runner reads its token from the pipe');
      assert.equal(run.argv?.trim(), 'connect --hub https://hub.example.com --token-from stdin');
      assert.ok(!run.argv?.includes(TOKEN) && !run.env?.includes(TOKEN), 'and it is in neither `ps` nor the environment');
      assert.ok(!run.env?.includes('SECRET_OF_ROOT'), 'nothing of root’s environment comes along');
      assert.match(run.env ?? '', new RegExp(`^HOME=${run.root}/home$`, 'm'));
      assert.match(run.env ?? '', /^RELAY_RUNNER_MAX_RUNS=1$/m);
      // Node's SIGUSR1 debugger is switched off for everything Node runs there, where this Node has the flag.
      const supported = spawnSync(process.execPath, ['-e', '0'], { env: { ...process.env, NODE_OPTIONS: '--disable-sigusr1' } }).status === 0;
      assert.match(run.env ?? '', supported ? /^NODE_OPTIONS=--disable-sigusr1$/m : /^NODE_OPTIONS=$/m);
    } finally {
      await run.done();
    }
  });

  it('does not read the token at all unless the metadata service is closed to everyone else', async () => {
    const run = await start({ iptables: 'missing-rule' });
    try {
      assert.equal(run.status, 1);
      assert.match(run.output, /not closed to other users; not starting/);
      assert.equal(run.stdin, null, 'the runner was never started');
    } finally {
      await run.done();
    }
  });
});

describe('what the runner’s start-up script will not do', () => {
  it('pipes nothing from the network into a shell, and builds nothing from a branch', () => {
    const { prepare, start } = runnerFiles(OPTIONS);
    const text = runnerCloudInit(OPTIONS);
    for (const script of [prepare, start, text]) {
      assert.ok(!/curl[^\n|]*\|\s*(ba)?sh/.test(script), 'no `curl … | bash`');
      assert.ok(!/git clone/.test(script), 'no building Relay from whatever is on GitHub today');
    }
    assert.match(prepare, /claude_want="2\.0\.0"\ncodex_want="0\.40\.0"/, 'pinned versions, when the hub is given them');
    assert.match(prepare, /signed-by=\/etc\/apt\/keyrings\/nodesource\.gpg\] https:\/\/deb\.nodesource\.com\/node_22\.x nodistro main/);
    assert.match(start, /Relay is not installed[^\n]*not starting"; exit 1/);
    // Unpinned is still possible, and is what an operator gets by saying nothing.
    assert.match(runnerFiles({ ...OPTIONS, claudeCodeVersion: 'latest', codexVersion: 'latest' }).prepare, /claude_want="latest"/);
    assert.throws(() => runnerFiles({ ...OPTIONS, codexVersion: '1.0.0 && reboot' }), /not an npm version/);
  });
});

describe('what the hub says about the package and the pins', () => {
  it('states the package’s whole SHA-256 and the CLI versions beside it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relay-hub-package-'));
    const tarball = join(dir, 'relay.tgz');
    await writeFile(tarball, 'the relay package');
    const fleet = new Fleet({ driver: null, regions: [], coresPerRunner: 2, tokenFor: () => ({ token: '', id: '' }) });
    const hub = createHub({ fleet, secret: 's'.repeat(40), sessions: new StaticVerifier([]), origins: ['https://studio.example'], version: '0.1.0', tarballPath: tarball, cliVersions: { claudeCode: '2.0.0', codex: '0.40.0' } });
    const base = `http://127.0.0.1:${await hub.listen(0, '127.0.0.1')}`;
    try {
      const head = await fetch(`${base}/runner/relay.tgz`, { method: 'HEAD' });
      assert.equal(head.headers.get('x-relay-sha256'), sha('the relay package'));
      assert.equal(head.headers.get('x-relay-version'), `0.1.0+${sha('the relay package').slice(0, 12)}`);
      assert.equal(head.headers.get('x-relay-claude-code'), '2.0.0');
      assert.equal(head.headers.get('x-relay-codex'), '0.40.0');
      assert.equal(sha(await (await fetch(`${base}/runner/relay.tgz`)).text()), head.headers.get('x-relay-sha256'));
    } finally {
      await hub.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('takes the pins from its configuration, and will not make machines without a package to give them', async () => {
    const key = `pk_test_${Buffer.from('clever-cat-1.clerk.accounts.dev$').toString('base64')}`;
    const env = {
      RELAY_HUB_SECRET: 'x'.repeat(40),
      CLERK_PUBLISHABLE_KEY: key,
      AZURE_SUBSCRIPTION_ID: 'sub',
      RELAY_CLOUD_REGIONS: 'northcentralus',
      RELAY_HUB_PUBLIC_URL: 'https://hub.example.com',
      RELAY_CLOUD_SSH_KEY: 'ssh-ed25519 AAAA ops',
      RELAY_HUB_TARBALL: '/opt/relay/relay.tgz',
    };
    const unpinned = await readHubConfig(env);
    assert.deepEqual([unpinned.cloud?.claudeCodeVersion, unpinned.cloud?.codexVersion], ['latest', 'latest']);
    const pinned = await readHubConfig({ ...env, RELAY_CLOUD_CLAUDE_CODE_VERSION: '2.0.0', RELAY_CLOUD_CODEX_VERSION: '0.40.0' });
    assert.deepEqual([pinned.cloud?.claudeCodeVersion, pinned.cloud?.codexVersion], ['2.0.0', '0.40.0']);
    await assert.rejects(readHubConfig({ ...env, RELAY_CLOUD_CODEX_VERSION: '1.0.0; reboot' }), /not an npm version/);
    const { RELAY_HUB_TARBALL: _tarball, ...without } = env;
    await assert.rejects(readHubConfig(without), /RELAY_HUB_TARBALL must be set/);
  });
});
