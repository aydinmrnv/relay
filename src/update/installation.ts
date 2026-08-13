import { readFile, realpath } from 'node:fs/promises';
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
    version: manifest.version ?? 'unknown',
    kind: await detectKind(root),
    spec: npmSpec(manifest),
  };
}

/**
 * The version recorded in an installed copy, or null when it cannot be read.
 * Called after an update, where a missing answer is worth reporting plainly
 * rather than turning a successful update into a failure.
 */
export async function installedVersion(root: string): Promise<string | null> {
  try {
    return (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Manifest).version ?? null;
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

/**
 * The spec that reinstalls this package. Relay is distributed from its
 * repository rather than the npm registry, so the repository field is the
 * authoritative source and `name@latest` is only the fallback.
 */
function npmSpec(manifest: Manifest): string | null {
  const url = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  if (url !== undefined && url.length > 0) {
    // `git+https://github.com/owner/repo.git` is a valid spec on its own, but
    // `github:owner/repo` is the one a person can read back out of a log.
    const normalized = url.replace(/^git\+/, '');
    const slug = parseRemoteUrl(normalized);
    if (slug !== null && slug.host.endsWith('github.com')) return `github:${slug.owner}/${slug.name}`;
    return normalized;
  }

  return manifest.name === undefined ? null : `${manifest.name}@latest`;
}
