import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, parse, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseRemoteUrl } from '../git/repository.ts';
import { runProcess } from '../process/runner.ts';
import { RelayError } from '../util/errors.ts';

/**
 * How this copy of Relay got here, which is the only thing that decides how it
 * is updated: a checkout is fast-forwarded, an npm-managed copy is reinstalled,
 * and anything else is the user's own arrangement to update.
 */
export type InstallKind = 'git' | 'npm' | 'unknown';

export interface Installation {
  /**
   * Root of the installed Relay package — never the repository Relay was
   * invoked against. `relay --update` updates Relay itself, from anywhere.
   */
  root: string;
  version: string;
  kind: InstallKind;
  /** An npm spec that reinstalls this copy, when one can be derived. */
  spec: string | null;
}

interface Manifest {
  name?: string;
  version?: string;
  repository?: string | { url?: string };
}

/**
 * Locates the installed package and classifies it.
 *
 * The starting point is this module's own path rather than the working
 * directory: Relay is normally run from inside somebody else's repository, and
 * that repository is emphatically not the thing being updated.
 */
export async function describeInstallation(from: string = fileURLToPath(import.meta.url)): Promise<Installation> {
  const root = await findPackageRoot(dirname(from));
  const manifest = await readManifest(root);

  return {
    root,
    version: versionLabel(manifest.version ?? 'unknown', await buildCommit(root)),
    kind: await detectKind(root),
    spec: npmSpec(manifest),
  };
}

/** Reads the installed package version without also probing git for its install kind. */
export async function packageVersion(from: string = fileURLToPath(import.meta.url)): Promise<string> {
  const root = await findPackageRoot(dirname(from));
  return (await readManifest(root)).version ?? 'unknown';
}

/**
 * The commit a packed build was made from, or null for a copy that was never
 * packed — a checkout runs its own sources, and `git log` already says where
 * those came from. Written by `scripts/stamp-build.mjs` during `npm pack`.
 *
 * A checkout is asked first, because one can have a stamp too: `npm pack` in a
 * working tree leaves `dist/build.json` behind, naming the commit that was
 * HEAD that day. Every commit since would be reported as that one. So a root
 * that is itself a repository has no build to name, whatever is in its dist/;
 * an installed package never has a `.git`, and is the only thing that does.
 */
export async function buildCommit(root: string): Promise<string | null> {
  // `.git` is a directory in a clone and a file in a worktree or a submodule.
  if (await exists(join(root, '.git'))) return null;
  try {
    const commit = (JSON.parse(await readFile(join(root, 'dist', 'build.json'), 'utf8')) as { commit?: unknown }).commit;
    return typeof commit === 'string' && /^[0-9a-f]{7,40}$/i.test(commit) ? commit.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `0.1.0+8cb9739` — the version, and the build.
 *
 * Every green push to main is published as the same version number, so the
 * number alone cannot tell two installs apart, or tell a bug report which
 * code it is about. The commit rides as semver build metadata: it changes
 * nothing about precedence, and it is the one fact that identifies a build.
 */
export function versionLabel(version: string, commit: string | null): string {
  return commit === null ? version : `${version}+${commit.slice(0, 7)}`;
}

/** What `relay --version` prints: the version, and the commit when this copy was packed. */
export async function buildVersion(from: string = fileURLToPath(import.meta.url)): Promise<string> {
  const root = await findPackageRoot(dirname(from));
  return versionLabel((await readManifest(root)).version ?? 'unknown', await buildCommit(root));
}

/**
 * The version recorded in an installed copy, or null when it cannot be read.
 * Called after an update, where a missing answer is worth reporting plainly
 * rather than turning a successful update into a failure. It carries the build
 * commit when there is one, because an update that replaced the code without
 * moving the version number has still changed what is installed.
 */
export async function installedVersion(root: string): Promise<string | null> {
  try {
    const version = (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Manifest).version;
    return version === undefined ? null : versionLabel(version, await buildCommit(root));
  } catch {
    return null;
  }
}

/** Nearest ancestor holding a `package.json`, which is the package this file belongs to. */
async function findPackageRoot(start: string): Promise<string> {
  const stop = parse(start).root;
  let current = start;

  for (;;) {
    try {
      await readFile(join(current, 'package.json'), 'utf8');
      return current;
    } catch {
      if (current === stop) break;
      current = dirname(current);
    }
  }

  throw new RelayError('Could not find the installed relay package.', {
    code: 'INSTALL_NOT_FOUND',
    hint: 'Reinstall Relay, then run `relay --update` again.',
  });
}

async function readManifest(root: string): Promise<Manifest> {
  try {
    return JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Manifest;
  } catch (error) {
    throw new RelayError(`Could not read ${join(root, 'package.json')}.`, {
      code: 'INSTALL_UNREADABLE',
      hint: 'Reinstall Relay, then run `relay --update` again.',
      cause: error,
    });
  }
}

/**
 * A package under `node_modules` is npm's to replace; a package that is itself
 * the root of a git checkout is git's to fast-forward.
 *
 * The checkout must own its root. Relay vendored inside a larger repository
 * would otherwise be "updated" by fast-forwarding somebody else's project,
 * which is a considerably bigger action than the one that was asked for.
 */
async function detectKind(root: string): Promise<InstallKind> {
  if (root.split(sep).includes('node_modules')) return 'npm';

  const result = await runProcess('git', ['-C', root, 'rev-parse', '--show-toplevel'], { timeoutMs: 20_000 });
  if (!result.ok) return 'unknown';

  return (await samePath(result.stdout.trim(), root)) ? 'git' : 'unknown';
}

/** git reports realpaths, so a symlinked install only matches after resolution. */
async function samePath(left: string, right: string): Promise<boolean> {
  if (left === right) return true;
  try {
    return (await realpath(left)) === (await realpath(right));
  } catch {
    return false;
  }
}

/** Where CI publishes the prebuilt CLI for a GitHub repository (`.github/workflows/cli-release.yml`). */
export function releaseTarball(owner: string, name: string): string {
  return `https://github.com/${owner}/${name}/releases/download/cli-latest/relay.tgz`;
}

/**
 * The spec that reinstalls this package. Relay is distributed from its
 * repository rather than the npm registry, so the repository field is the
 * authoritative source and `name@latest` is only the fallback.
 */
function npmSpec(manifest: Manifest): string | null {
  const url = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  if (url !== undefined && url.length > 0) {
    const normalized = url.replace(/^git\+/, '');
    const slug = parseRemoteUrl(normalized);
    // Not `github:owner/repo`: current npm installs a git dependency globally
    // as an empty package, because the build that makes dist/ never runs. The
    // repository's CI publishes the built package instead.
    if (slug !== null && slug.host.endsWith('github.com')) return releaseTarball(slug.owner, slug.name);
    return normalized;
  }

  return manifest.name === undefined ? null : `${manifest.name}@latest`;
}
