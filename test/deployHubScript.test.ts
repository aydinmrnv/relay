import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TRUSTED_STUDIO_ORIGIN } from '../src/studio/protocol.ts';

/**
 * `scripts/azure/deploy-hub.sh`, without Azure (CLOUD-03, CLOUD-07, CLOUD-12).
 *
 * `az`, `npm` and `curl` are stand-ins on the PATH: `az` writes down every
 * script it is asked to run on the hub and answers the few questions the
 * deploy asks. The part of the hub-side script that writes the hub's settings
 * is then run for real, here, against a temporary file. That shows what the
 * script decides and what it would send; it does not show that Azure does it.
 */

const SCRIPTS = fileURLToPath(new URL('../scripts/azure/', import.meta.url));
const POSIX = process.platform !== 'win32' && spawnSync('bash', ['--version']).status === 0 && spawnSync('shasum', ['--version']).status === 0;

interface Harness {
  dir: string;
  /** What the hub's VM answers when asked whether the coding CLIs are on it. */
  setClis(found: string): Promise<void>;
  /** Makes every hub-side script that contains this text fail part way, as Azure would report it: with success. */
  failScriptsContaining(text: string | null): Promise<void>;
  /** The public DNS name Azure reports for the hub's VM. */
  setFqdn(name: string): Promise<void>;
  deploy(...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string; scripts: string[]; calls: string[] }>;
  /** Runs the settings part of the last hub-side script against this harness's own hub.env, and returns the file. */
  applySettings(scripts: string[]): Promise<Record<string, string>>;
  done(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'relay-deploy-hub-'));
  const bin = join(dir, 'bin');
  const fake = join(dir, 'fake');
  await mkdir(bin, { recursive: true });
  await mkdir(fake, { recursive: true });
  await writeFile(join(dir, 'runner-ssh.pub'), 'ssh-ed25519 AAAA relay-runners\n');
  const stub = async (name: string, body: string) => {
    await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(bin, name), 0o755);
  };
  await stub(
    'az',
    `echo "az $*" >> "${fake}/calls"
case "$1 $2" in
  "account show") echo "00000000-1111-2222-3333-444444444444"; exit 0 ;;
  "vm show") case "$*" in *fqdns*) cat "${fake}/fqdn" 2>/dev/null ;; esac; exit 0 ;;
  "vm run-command")
    script=""
    while [ $# -gt 0 ]; do if [ "$1" = "--scripts" ]; then script="$2"; break; fi; shift; done
    n=$(( $(cat "${fake}/count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${fake}/count"
    printf '%s' "$script" > "${fake}/script-$(printf '%03d' "$n")"
    # Azure answers "succeeded" whatever the script did. A script the test says
    # fails stops before its last line, as it would under \`set -e\` on the hub.
    failed=""
    if [ -f "${fake}/fails" ] && printf '%s' "$script" | grep -q -- "$(cat "${fake}/fails")"; then failed=yes; fi
    printf '[stdout]\\n'
    case "$script" in
      *'command -v $b'*) cat "${fake}/clis" 2>/dev/null ;;
      *sha256sum*) echo "$(shasum -a 256 "$(cat "${fake}/tarball")" | cut -d' ' -f1)  /opt/relay/relay.tgz.new" ;;
      *'tailscale status'*) echo "hub.example-tailnet.ts.net." ;;
      *'cat /etc/relay/hub.env'*) cat "${dir}/hub.env" 2>/dev/null ;;
      *) echo ok ;;
    esac
    case "$script" in *__relay_remote_ok__*) [ -n "$failed" ] || echo __relay_remote_ok__ ;; esac
    printf '[stderr]\\n'
    [ -z "$failed" ] || echo "openssl: something went wrong"
    exit 0 ;;
esac
exit 0`,
  );
  await stub(
    'npm',
    `echo "npm $*" >> "${fake}/calls"
if [ "$1" = "pack" ]; then
  dest=""
  while [ $# -gt 0 ]; do if [ "$1" = "--pack-destination" ]; then dest="$2"; fi; shift; done
  printf 'a stand-in for the relay package' > "$dest/relay-orchestrator-0.0.0.tgz"
  echo "$dest/relay-orchestrator-0.0.0.tgz" > "${fake}/tarball"
fi
exit 0`,
  );
  await stub('curl', 'echo "{\\"ok\\":true}"');
  await stub('sleep', 'exit 0');

  const scriptsOf = async (): Promise<string[]> => {
    const names = (await readdir(fake)).filter((name) => name.startsWith('script-')).sort();
    return Promise.all(names.map((name) => readFile(join(fake, name), 'utf8')));
  };

  return {
    dir,
    setClis: (found) => writeFile(join(fake, 'clis'), found),
    failScriptsContaining: (text) => (text === null ? rm(join(fake, 'fails'), { force: true }) : writeFile(join(fake, 'fails'), text)),
    setFqdn: (name) => writeFile(join(fake, 'fqdn'), `${name}\n`),
    deploy: async (...args) => {
      for (const name of await readdir(fake)) if (name.startsWith('script-') || name === 'count' || name === 'calls') await rm(join(fake, name));
      const env = { ...process.env, PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}` };
      delete (env as Record<string, string | undefined>)['RELAY_STUDIO_URL'];
      delete (env as Record<string, string | undefined>)['CLERK_PUBLISHABLE_KEY'];
      const result = spawnSync('bash', [join(SCRIPTS, 'deploy-hub.sh'), ...args], { env, encoding: 'utf8' });
      const calls = (await readFile(join(fake, 'calls'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
      return { status: result.status, stdout: result.stdout, stderr: result.stderr, scripts: await scriptsOf(), calls };
    },
    applySettings: async (scripts) => {
      const setup = scripts.find((script) => script.includes('# BEGIN settings'));
      assert.ok(setup !== undefined, 'the deploy sent a script that writes the hub’s settings');
      const block = setup.slice(setup.indexOf('# BEGIN settings'), setup.indexOf('# END settings'));
      const local = block.replace('env_file=/etc/relay/hub.env', `env_file=${join(dir, 'hub.env')}`).replace('/etc/relay/runner-ssh.pub', join(dir, 'runner-ssh.pub'));
      assert.ok(!local.includes('/etc/relay/hub.env') && !local.includes('/etc/relay/runner-ssh'), 'nothing in the block still points at the real paths');
      const ran = spawnSync('bash', ['-e'], { input: local, encoding: 'utf8' });
      assert.equal(ran.status, 0, ran.stderr);
      const text = await readFile(join(dir, 'hub.env'), 'utf8');
      return Object.fromEntries(text.split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    },
    done: () => rm(dir, { recursive: true, force: true }),
  };
}

const KEY = `pk_test_${Buffer.from('clever-cat-1.clerk.accounts.dev$').toString('base64')}`;

describe('the Azure scripts', { skip: !POSIX }, () => {
  it('are shell that parses', () => {
    for (const name of ['deploy-hub.sh', 'create-runner.sh']) {
      const checked = spawnSync('bash', ['-n', join(SCRIPTS, name)], { encoding: 'utf8' });
      assert.equal(checked.status, 0, `${name}: ${checked.stderr}`);
    }
  });
});

describe('deploying the hub onto a VM', { skip: !POSIX }, () => {
  it('refuses one that has the coding CLIs on it, before anything is packed or shipped', async () => {
    const h = await harness();
    try {
      await h.setClis('/usr/bin/claude\n/home/relay/.codex\n');
      for (const args of [['--vm', 'dev/runner', '--clerk-publishable-key', KEY], ['--vm', 'dev/runner', '--upgrade'], ['--vm', 'dev/runner', '--rotate-secret']]) {
        const refused = await h.deploy(...args);
        assert.equal(refused.status, 1, args.join(' '));
        assert.match(refused.stderr, /runner has the coding CLIs on it:\n {2}\/usr\/bin\/claude/);
        assert.match(refused.stderr, /Give the hub a VM of its own/);
        assert.equal(refused.scripts.length, 1, 'the only thing run on the VM was the question');
        assert.ok(!refused.calls.some((call) => call.startsWith('npm')), 'and nothing was packed');
      }

      const forced = await h.deploy('--vm', 'dev/runner', '--upgrade', '--unsafe-shared-vm');
      assert.equal(forced.status, 0, forced.stderr);
      assert.match(forced.stderr, /Going on because of --unsafe-shared-vm/);
    } finally {
      await h.done();
    }
  });

  it('writes the settings it was given, serves only the trusted studio, and leaves the hub’s own defaults alone', async () => {
    const h = await harness();
    try {
      await h.setClis('');
      const first = await h.deploy('--vm', 'hub/vm', '--clerk-publishable-key', KEY, '--allow', 'user_a,user_b');
      assert.equal(first.status, 0, first.stderr);
      const env = await h.applySettings(first.scripts);
      assert.equal(env['RELAY_CLOUD_ALLOWED_USERS'], 'user_a,user_b');
      assert.equal(env['RELAY_HUB_STUDIO_ORIGINS'], TRUSTED_STUDIO_ORIGIN, 'read from the one place it is written, and no localhost beside it');
      assert.equal(env['RELAY_HUB_PUBLIC_URL'], 'https://hub.example-tailnet.ts.net');
      assert.equal(env['RELAY_HUB_SECRET_PREVIOUS_FILE'], '/etc/relay/hub-secret.previous');
      assert.equal(env['RELAY_CLOUD_SSH_KEY'], 'ssh-ed25519 AAAA relay-runners');
      assert.equal(env['CLERK_PUBLISHABLE_KEY'], KEY);
      for (const unset of ['RELAY_CLOUD_MAX_MACHINES', 'RELAY_CLOUD_IDLE_MINUTES', 'RELAY_CLOUD_CLAUDE_CODE_VERSION', 'RELAY_CLOUD_CODEX_VERSION']) {
        assert.equal(env[unset], undefined, `${unset} is the hub’s to default`);
      }
      assert.match(first.stdout, /Who may use: {2}user_a,user_b\./);
    } finally {
      await h.done();
    }
  });

  it('keeps the allow-list, and every other setting, when it is run again without them', async () => {
    const h = await harness();
    try {
      await h.setClis('');
      const first = await h.deploy('--vm', 'hub/vm', '--clerk-publishable-key', KEY, '--allow', 'user_a', '--max-machines', '25', '--claude-code-version', '2.0.0', '--studio', 'https://studio.example.com');
      assert.equal(first.status, 0, first.stderr);
      await h.applySettings(first.scripts);

      // The re-run every operator does: same VM, nothing but the key. It used to empty the allow-list.
      const again = await h.deploy('--vm', 'hub/vm', '--clerk-publishable-key', KEY);
      assert.equal(again.status, 0, again.stderr);
      const kept = await h.applySettings(again.scripts);
      assert.equal(kept['RELAY_CLOUD_ALLOWED_USERS'], 'user_a');
      assert.equal(kept['RELAY_CLOUD_MAX_MACHINES'], '25');
      assert.equal(kept['RELAY_CLOUD_CLAUDE_CODE_VERSION'], '2.0.0');
      assert.equal(kept['RELAY_HUB_STUDIO_ORIGINS'], 'https://studio.example.com');
      assert.match(again.stdout, /Who may use: {2}as it was/);

      // One setting changed, the rest still kept; and emptying the list has to be asked for by name.
      const changed = await h.applySettings((await h.deploy('--vm', 'hub/vm', '--clerk-publishable-key', KEY, '--allow', '*', '--codex-version', '0.40.0')).scripts);
      assert.deepEqual([changed['RELAY_CLOUD_ALLOWED_USERS'], changed['RELAY_CLOUD_MAX_MACHINES'], changed['RELAY_CLOUD_CODEX_VERSION']], ['*', '25', '0.40.0']);
      const nobody = await h.applySettings((await h.deploy('--vm', 'hub/vm', '--clerk-publishable-key', KEY, '--allow', 'none')).scripts);
      assert.equal(nobody['RELAY_CLOUD_ALLOWED_USERS'], '');
      assert.equal(nobody['RELAY_CLOUD_MAX_MACHINES'], '25');
    } finally {
      await h.done();
    }
  });

  it('refuses a value that could end the quoting it is sent in, and an empty allow-list given by accident', async () => {
    const h = await harness();
    try {
      await h.setClis('');
      for (const args of [['--allow', "x'; reboot; '"], ['--allow', ''], ['--studio', 'https://a.example$(reboot)'], ['--max-machines', '10; reboot'], ['--codex-version', '1.0 && reboot']]) {
        const refused = await h.deploy('--vm', 'hub/vm', '--clerk-publishable-key', KEY, ...args);
        assert.equal(refused.status, 2, args.join(' '));
        assert.deepEqual(refused.scripts, [], 'nothing was sent to the VM');
      }
    } finally {
      await h.done();
    }
  });

  it('keeps where the hub is, what it makes and whose sign-ins it checks when it is run again without them', async () => {
    const h = await harness();
    try {
      await h.setClis('');
      await h.setFqdn('relay-hub-00000000.northcentralus.cloudapp.azure.com');
      const first = await h.deploy('--vm', 'hub/vm', '--clerk-publishable-key', KEY, '--allow', 'user_a', '--expose', 'public-ip', '--regions', 'northcentralus,spaincentral', '--runner-size', 'Standard_B2s_v2', '--group', 'relay-beta');
      assert.equal(first.status, 0, first.stderr);
      const written = await h.applySettings(first.scripts);
      assert.equal(written['RELAY_HUB_PUBLIC_URL'], 'https://relay-hub-00000000.northcentralus.cloudapp.azure.com');

      // Nothing but the one thing being changed. Not even the Clerk key.
      const again = await h.deploy('--vm', 'hub/vm', '--allow', 'user_a,user_b');
      assert.equal(again.status, 0, again.stderr);
      const kept = await h.applySettings(again.scripts);
      assert.equal(kept['RELAY_HUB_PUBLIC_URL'], written['RELAY_HUB_PUBLIC_URL'], 'still on its public address, not moved to a tailnet name');
      assert.equal(kept['RELAY_CLOUD_REGIONS'], 'northcentralus,spaincentral');
      assert.equal(kept['RELAY_CLOUD_VM_SIZE'], 'Standard_B2s_v2');
      assert.equal(kept['RELAY_CLOUD_RESOURCE_GROUP'], 'relay-beta');
      assert.equal(kept['CLERK_PUBLISHABLE_KEY'], KEY);
      assert.equal(kept['RELAY_CLOUD_ALLOWED_USERS'], 'user_a,user_b');
      assert.ok(again.calls.some((call) => call.includes('--scope /subscriptions/00000000-1111-2222-3333-444444444444/resourceGroups/relay-beta')), 'and its identity is still scoped to the same group');

      // A value that would strand what the hub has made is refused, not obeyed.
      const moved = await h.deploy('--vm', 'hub/vm', '--expose', 'funnel');
      assert.equal(moved.status, 2);
      assert.match(moved.stderr, /is reached at https:\/\/relay-hub-00000000[^\n]* \(public-ip\)\. --expose funnel would give it another\s+address/);
      const elsewhere = await h.deploy('--vm', 'hub/vm', '--group', 'another-group');
      assert.equal(elsewhere.status, 2);
      assert.match(elsewhere.stderr, /machines are in the resource group relay-beta/);
      for (const refused of [moved, elsewhere]) assert.ok(!refused.calls.some((call) => call.startsWith('npm')), 'before anything is packed or shipped');

      const onPurpose = await h.deploy('--vm', 'hub/vm', '--expose', 'funnel', '--change-exposure');
      assert.equal(onPurpose.status, 0, onPurpose.stderr);
      assert.equal((await h.applySettings(onPurpose.scripts))['RELAY_HUB_PUBLIC_URL'], 'https://hub.example-tailnet.ts.net');
    } finally {
      await h.done();
    }
  });

  it('stops, and says so, when a script fails on the hub, though Azure calls the command a success', async () => {
    const h = await harness();
    try {
      await h.setClis('');
      await h.failScriptsContaining('openssl rand -base64 48 | tr');
      const rotated = await h.deploy('--vm', 'hub/vm', '--rotate-secret');
      assert.equal(rotated.status, 1);
      assert.match(rotated.stderr, /A step failed on vm\. Nothing after it was done\. What it printed:\n[^]*openssl: something went wrong/);
      assert.ok(!rotated.stdout.includes('now signs runner tokens with a new secret'), 'it does not announce a rotation that did not happen');

      // The same for a deploy: a failed install is not followed by "The hub is at".
      const deployed = await h.deploy('--vm', 'hub/vm', '--clerk-publishable-key', KEY, '--allow', 'user_a');
      assert.equal(deployed.status, 1);
      assert.ok(!deployed.stdout.includes('The hub is at'));

      await h.failScriptsContaining('cat /etc/relay/admin-token');
      assert.equal((await h.deploy('--vm', 'hub/vm', '--print-admin-token')).status, 1);
      await h.failScriptsContaining(null);
      assert.equal((await h.deploy('--vm', 'hub/vm', '--rotate-secret')).status, 0);
    } finally {
      await h.done();
    }
  });

  it('replaces the hub’s secret while keeping the old one readable', async () => {
    const h = await harness();
    try {
      await h.setClis('');
      const rotated = await h.deploy('--vm', 'hub/vm', '--rotate-secret');
      assert.equal(rotated.status, 0, rotated.stderr);
      const script = rotated.scripts.at(-1) ?? '';
      // The current secret goes on top of the list of earlier ones before a new one is made.
      assert.ok(script.indexOf('hub-secret.previous.new') < script.indexOf('openssl rand -base64 48'));
      assert.match(script, /RELAY_HUB_SECRET_PREVIOUS_FILE=\/etc\/relay\/hub-secret\.previous/);
      assert.match(script, /systemctl restart relay-hub/);
      assert.ok(!rotated.calls.some((call) => call.startsWith('npm')), 'no package is shipped for a rotation');
      assert.match(rotated.stdout, /still reads the old one/);
    } finally {
      await h.done();
    }
  });
});
