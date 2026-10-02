// Records the commit a build was made from, in dist/build.json.
//
// Every push to main is published under the same version number, so the
// version alone cannot say which build somebody is running. `relay --version`
// reads this file and prints `0.1.0+8cb9739`: the version, and the commit that
// was packed. It is written by `prepack`, after the build and before the
// tarball, so it is in every package. A checkout that has been packed has one
// lying in its dist/ too, which is why `relay --version` ignores it there.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const stamp = new URL('../dist/build.json', import.meta.url);

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/**
 * The commit being packed.
 *
 * The repository is asked, because it is the only thing that knows: HEAD is
 * the code in this directory. `GITHUB_SHA` is deliberately not consulted. It
 * names the commit a *workflow* is running for, which is this package's commit
 * only when the workflow belongs to this repository — packed from a copy
 * vendored into another project's CI, it would stamp that project's commit
 * onto this code. `RELAY_BUILD_COMMIT` is for the build that knows better
 * than git does, and says so on purpose.
 */
function commit() {
  const given = process.env.RELAY_BUILD_COMMIT;
  if (given !== undefined && given !== '') {
    if (/^[0-9a-f]{40}$/i.test(given)) return given.toLowerCase();
    process.stderr.write(`stamp-build: RELAY_BUILD_COMMIT is not a full commit id (${given}); ignoring it.\n`);
  }
  try {
    // Only a repository rooted here. Inside somebody else's repository HEAD is
    // their commit, not this package's.
    if (realpathSync(git('rev-parse', '--show-toplevel')) !== realpathSync(root)) return null;
    const head = git('rev-parse', 'HEAD');
    return /^[0-9a-f]{40}$/.test(head) ? head : null;
  } catch {
    // Packed from a source archive, with no repository to ask. The package is
    // still a good one; it just cannot say where it came from.
    return null;
  }
}

const sha = commit();
if (sha === null) {
  // No stamp is better than an old one: a build that cannot say where it came
  // from must not go out claiming to be the last build that could.
  await rm(stamp, { force: true });
  process.stderr.write('stamp-build: no commit to record; `relay --version` will print the version alone.\n');
} else {
  await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
  await writeFile(stamp, `${JSON.stringify({ commit: sha }, null, 2)}\n`);
}
