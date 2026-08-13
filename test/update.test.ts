import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { setTheme } from '../src/cli/output.ts';
import { runUpdate, type NpmResult, type UpdateDeps } from '../src/cli/commands/update.ts';
import { describeInstallation, type Installation } from '../src/update/installation.ts';
import { runProcess } from '../src/process/runner.ts';
import { isRelayError } from '../src/util/errors.ts';
import type { Theme } from '../src/ui/theme.ts';

const PIPED: Theme = { color: false, unicode: true, interactive: false };

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  setTheme(undefined);
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A temp directory that is removed after the test that made it. */
async function scratch(prefix: string): Promise<string> {
  // Realpaths throughout: git reports them, and so does Node when it resolves
  // this package's own location (macOS /var → /private/var).
  const base = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  return base;
}

async function git(args: readonly string[], cwd: string): Promise<string> {
  const result = await runProcess('git', args, {
    cwd,
    env: {
      GIT_AUTHOR_NAME: 'Relay Test',
      GIT_AUTHOR_EMAIL: 'test@relay.invalid',
      GIT_COMMITTER_NAME: 'Relay Test',
      GIT_COMMITTER_EMAIL: 'test@relay.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

async function write(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
}

function manifest(version: string): string {
  return `${JSON.stringify(
    {
      name: 'relay-orchestrator',
      version,
      repository: { type: 'git', url: 'git+https://github.com/aydinmrnv/relay.git' },
    },
    null,
    2,
  )}\n`;
}

interface Install {
  /** The published copy `--update` pulls from. */
  origin: string;
  /** The checkout standing in for the installed Relay. */
  root: string;
  /** Adds a commit to the origin, which the install is then behind by. */
  release(files: Record<string, string>, message: string): Promise<void>;
  commitLocally(files: Record<string, string>, message: string): Promise<void>;
}

/**
 * A real checkout of a real remote, playing the part of an installed Relay.
 *
 * Fetch, fast-forward, divergence and detached HEAD are git's behaviour rather
 * than Relay's, and a mock of them would only ever assert what this test
 * already believes about git.
 */
async function createInstall(): Promise<Install> {
  const base = await scratch('relay-update-');
  const origin = join(base, 'origin');
  const root = join(base, 'install');

  await mkdir(origin, { recursive: true });
  await git(['init', '-q', '-b', 'main'], origin);
  await write(join(origin, 'package.json'), manifest('0.1.0'));
  await write(join(origin, 'src', 'index.ts'), 'export const version = 1;\n');
  await git(['add', '-A'], origin);
  await git(['commit', '-q', '-m', 'initial'], origin);
  await git(['clone', '-q', origin, root], base);

  const commit = async (cwd: string, files: Record<string, string>, message: string): Promise<void> => {
    for (const [path, contents] of Object.entries(files)) await write(join(cwd, path), contents);
    await git(['add', '-A'], cwd);
    await git(['commit', '-q', '-m', message], cwd);
  };

  return {
    origin,
    root,
    release: (files, message) => commit(origin, files, message),
    commitLocally: (files, message) => commit(root, files, message),
  };
}

/** Every npm invocation the update would have made, and none of them made. */
class Npm {
  readonly calls: Array<{ args: string[]; cwd: string }> = [];

  /** Args prefix that fails, e.g. `['run', 'build']`. */
  private readonly failing: readonly string[] | undefined;

  constructor(failing?: readonly string[]) {
    this.failing = failing;
  }

  readonly run = async (args: readonly string[], cwd: string): Promise<NpmResult> => {
    this.calls.push({ args: [...args], cwd });
    const fails = this.failing !== undefined && this.failing.every((arg, index) => args[index] === arg);
    return fails ? { ok: false, detail: 'npm ERR! it did not work' } : { ok: true, detail: '' };
  };

  ran(...args: string[]): boolean {
    return this.calls.some((call) => args.every((arg, index) => call.args[index] === arg));
  }
}

async function installation(root: string, overrides: Partial<Installation> = {}): Promise<Installation> {
  const version = (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string }).version;
  return { root, version, kind: 'git', spec: 'github:aydinmrnv/relay', ...overrides };
}

/** Runs the update against a scripted world and returns everything it printed. */
async function update(
  install: Installation,
  npm: Npm,
): Promise<{ code: number; output: string; error?: unknown }> {
  setTheme(PIPED);
  const originalWrite = process.stdout.write.bind(process.stdout);
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;

  const deps: UpdateDeps = { installation: async () => install, npm: npm.run };
  try {
    return { code: await runUpdate(deps), output };
  } catch (error) {
    return { code: 1, output, error };
  } finally {
    process.stdout.write = originalWrite;
  }
}

describe('relay --update, from a checkout', () => {
  it('reports the version it is already on and touches nothing', async () => {
    const install = await createInstall();
    const npm = new Npm();

    const { code, output, error } = await update(await installation(install.root), npm);

    assert.equal(error, undefined);
    assert.equal(code, 0);
    assert.match(output, /Already the latest version/);
    assert.deepEqual(npm.calls, [], 'nothing to update is nothing to install or build');
  });

  it('fast-forwards to the remote and names what it brought in', async () => {
    const install = await createInstall();
    await install.release({ 'src/index.ts': 'export const version = 2;\n' }, 'Take the serial waiting out of a run');
    await install.release({ 'src/extra.ts': 'export const extra = true;\n' }, 'Give the CLI a wordmark');
    const npm = new Npm();

    const { code, output, error } = await update(await installation(install.root), npm);

    assert.equal(error, undefined);
    assert.equal(code, 0);
    assert.equal(await git(['rev-parse', 'HEAD'], install.root), await git(['rev-parse', 'HEAD'], install.origin));

    assert.match(output, /Updating 2 commits behind origin\/main/);
    assert.match(output, /Give the CLI a wordmark/);
    assert.match(output, /Take the serial waiting out of a run/);
    assert.match(output, /Fast-forwarded [0-9a-f]+ → [0-9a-f]+/);
    // The version did not move, so the closing line says where it landed
    // rather than claiming an upgrade that did not happen.
    assert.match(output, /Relay is up to date at 0\.1\.0\./);
  });

  it('reports the new version when the update carries one', async () => {
    const install = await createInstall();
    await install.release({ 'package.json': manifest('0.2.0') }, 'Release 0.2.0');

    const { output } = await update(await installation(install.root), new Npm());
    assert.match(output, /Relay is up to date: 0\.1\.0 → 0\.2\.0\./);
  });

  it('installs dependencies only when the manifest changed', async () => {
    const install = await createInstall();
    await install.release({ 'src/index.ts': 'export const version = 2;\n' }, 'Code only');

    const codeOnly = new Npm();
    await update(await installation(install.root), codeOnly);
    assert.equal(codeOnly.ran('install'), false, 'a code-only change installs nothing');

    await install.release({ 'package-lock.json': '{ "lockfileVersion": 3 }\n' }, 'Bump a dependency');

    const withLockfile = new Npm();
    await update(await installation(install.root), withLockfile);
    assert.ok(withLockfile.ran('install', '--no-audit', '--no-fund'));
    assert.equal(withLockfile.calls[0]?.cwd, install.root, 'npm runs where Relay lives, not where it was invoked');
  });

  it('rebuilds only a checkout that runs compiled output', async () => {
    const install = await createInstall();
    await install.release({ 'src/index.ts': 'export const version = 2;\n' }, 'A change');

    const sources = new Npm();
    const fromSources = await update(await installation(install.root), sources);
    assert.equal(fromSources.code, 0);
    assert.equal(sources.ran('run', 'build'), false, 'the launcher runs the sources when there is no dist');

    // The same update again, this time against a checkout with compiled output
    // the new commits have just made stale.
    await install.release({ 'src/index.ts': 'export const version = 3;\n' }, 'Another change');
    await write(join(install.root, 'dist', 'index.js'), 'export const version = 2;\n');

    const compiled = new Npm();
    const fromDist = await update(await installation(install.root), compiled);
    assert.equal(fromDist.code, 0);
    assert.ok(compiled.ran('run', 'build'));
    assert.match(fromDist.output, /Rebuilt dist/);
  });

  it('refuses to merge a checkout that has diverged', async () => {
    const install = await createInstall();
    await install.release({ 'src/index.ts': 'export const version = 2;\n' }, 'Upstream work');
    await install.commitLocally({ 'src/local.ts': 'export const local = true;\n' }, 'Local work');
    const head = await git(['rev-parse', 'HEAD'], install.root);

    const { code, error } = await update(await installation(install.root), new Npm());

    assert.equal(code, 1);
    assert.ok(isRelayError(error) && error.code === 'UPDATE_DIVERGED', String(error));
    assert.match((error as Error).message, /1 local commit and 1 new commit upstream/);
    assert.equal(await git(['rev-parse', 'HEAD'], install.root), head, 'a refusal changes nothing');
  });

  it('treats local commits with nothing upstream as up to date', async () => {
    const install = await createInstall();
    await install.commitLocally({ 'src/local.ts': 'export const local = true;\n' }, 'Local work');

    const { code, output } = await update(await installation(install.root), new Npm());
    assert.equal(code, 0);
    assert.match(output, /Already the latest version — 1 local commit not on origin\/main/);
  });

  it('will not guess what "latest" means for a detached checkout', async () => {
    const install = await createInstall();
    await git(['checkout', '-q', '--detach', 'HEAD'], install.root);

    const { error } = await update(await installation(install.root), new Npm());
    assert.ok(isRelayError(error) && error.code === 'UPDATE_DETACHED', String(error));
    assert.match(error.hint ?? '', new RegExp(install.root));
  });

  it('will not guess what "latest" means for a branch that tracks nothing', async () => {
    const install = await createInstall();
    await git(['checkout', '-q', '-b', 'private'], install.root);

    const { error } = await update(await installation(install.root), new Npm());
    assert.ok(isRelayError(error) && error.code === 'UPDATE_NO_UPSTREAM', String(error));
  });

  it('says the code landed when only the build failed', async () => {
    const install = await createInstall();
    await install.release({ 'src/index.ts': 'export const version = 2;\n' }, 'A change');
    await write(join(install.root, 'dist', 'index.js'), 'export const version = 1;\n');

    const { code, error } = await update(await installation(install.root), new Npm(['run', 'build']));

    assert.equal(code, 1);
    assert.ok(isRelayError(error) && error.code === 'UPDATE_STEP_FAILED', String(error));
    assert.match(error.message, /npm ERR! it did not work/);
    assert.match(error.hint ?? '', /new code is in place/);
    // The fast-forward itself stood: re-running is the repair path, not a redo.
    assert.equal(await git(['rev-parse', 'HEAD'], install.root), await git(['rev-parse', 'HEAD'], install.origin));
  });
});

describe('relay --update, from an npm install', () => {
  it('reinstalls the package npm knows about', async () => {
    const npm = new Npm();
    const root = await scratch('relay-npm-');
    await write(join(root, 'package.json'), manifest('0.1.0'));

    const { code, output, error } = await update(
      { root, version: '0.1.0', kind: 'npm', spec: 'github:aydinmrnv/relay' },
      npm,
    );

    assert.equal(error, undefined);
    assert.equal(code, 0);
    assert.deepEqual(npm.calls, [{ args: ['install', '-g', 'github:aydinmrnv/relay'], cwd: root }]);
    assert.match(output, /npm install -g github:aydinmrnv\/relay/);
  });

  it('hands back a failed global install with the command to retry', async () => {
    const root = await scratch('relay-npm-');
    await write(join(root, 'package.json'), manifest('0.1.0'));

    const { code, error } = await update(
      { root, version: '0.1.0', kind: 'npm', spec: 'github:aydinmrnv/relay' },
      new Npm(['install', '-g']),
    );

    assert.equal(code, 1);
    assert.ok(isRelayError(error) && error.code === 'UPDATE_NPM_FAILED', String(error));
    assert.match(error.hint ?? '', /npm install -g github:aydinmrnv\/relay/);
  });
});

describe('relay --update, from an install it does not recognize', () => {
  it('says so, and says what to run instead', async () => {
    const npm = new Npm();
    const root = await scratch('relay-unknown-');

    const { code, error } = await update({ root, version: '0.1.0', kind: 'unknown', spec: 'github:a/b' }, npm);

    assert.equal(code, 1);
    assert.ok(isRelayError(error) && error.code === 'UPDATE_UNSUPPORTED', String(error));
    assert.match(error.hint ?? '', /npm install -g github:a\/b/);
    assert.deepEqual(npm.calls, [], 'an install Relay cannot classify is one it does not touch');
  });
});

describe('installation detection', () => {
  /** Where the module doing the detecting would sit inside the package. */
  const moduleIn = (root: string): string => join(root, 'src', 'update', 'installation.ts');

  it('finds the package root from a file buried inside it', async () => {
    const root = await scratch('relay-detect-');
    await write(join(root, 'package.json'), manifest('9.9.9'));

    const found = await describeInstallation(join(root, 'dist', 'cli', 'commands', 'update.js'));
    assert.equal(found.root, root);
    assert.equal(found.version, '9.9.9');
  });

  it('calls a checkout that owns its root a git install', async () => {
    const root = await scratch('relay-detect-');
    await git(['init', '-q', '-b', 'main'], root);
    await write(join(root, 'package.json'), manifest('0.1.0'));

    assert.equal((await describeInstallation(moduleIn(root))).kind, 'git');
  });

  it('will not fast-forward a repository Relay merely lives inside', async () => {
    const base = await scratch('relay-detect-');
    await git(['init', '-q', '-b', 'main'], base);
    const vendored = join(base, 'vendor', 'relay');
    await write(join(vendored, 'package.json'), manifest('0.1.0'));

    // Updating this would update somebody else's project, which is a much
    // larger action than the one that was asked for.
    assert.equal((await describeInstallation(moduleIn(vendored))).kind, 'unknown');
  });

  it('calls a package under node_modules an npm install', async () => {
    const base = await scratch('relay-detect-');
    const root = join(base, 'node_modules', 'relay-orchestrator');
    await write(join(root, 'package.json'), manifest('0.1.0'));

    assert.equal((await describeInstallation(moduleIn(root))).kind, 'npm');
  });

  it('reads the reinstall spec off the repository, not the registry', async () => {
    const root = await scratch('relay-detect-');
    await write(join(root, 'package.json'), manifest('0.1.0'));

    assert.equal((await describeInstallation(moduleIn(root))).spec, 'github:aydinmrnv/relay');
  });

  it('falls back to the package name when there is no repository', async () => {
    const root = await scratch('relay-detect-');
    await write(join(root, 'package.json'), `${JSON.stringify({ name: 'relay-orchestrator', version: '0.1.0' })}\n`);

    assert.equal((await describeInstallation(moduleIn(root))).spec, 'relay-orchestrator@latest');
  });

  it('describes the copy that is actually running', async () => {
    // No arguments: the real installation, whatever this test run is.
    const found = await describeInstallation();
    const own = JSON.parse(await readFile(join(found.root, 'package.json'), 'utf8')) as { name: string };
    assert.equal(own.name, 'relay-orchestrator');
    assert.equal(found.version, found.version.trim());
  });
});
