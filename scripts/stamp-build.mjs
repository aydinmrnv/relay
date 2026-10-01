// Records the commit a build was made from, in dist/build.json.
//
// Every push to main is published under the same version number, so the
// version alone cannot say which build somebody is running. `relay --version`
// reads this file and prints `0.1.0+8cb9739`: the version, and the commit that
// was packed. It is written by `prepack`, after the build and before the
// tarball, so it is in every package and in no checkout.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

/** The commit being packed: CI names it, and a checkout can be asked. */
function commit() {
  for (const given of [process.env.RELAY_BUILD_COMMIT, process.env.GITHUB_SHA]) {
    if (given !== undefined && /^[0-9a-f]{40}$/i.test(given)) return given.toLowerCase();
  }
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /^[0-9a-f]{40}$/.test(head) ? head : null;
  } catch {
    // Packed from a source archive, with no repository to ask. The package is
    // still a good one; it just cannot say where it came from.
    return null;
  }
}

const sha = commit();
if (sha === null) {
  process.stderr.write('stamp-build: no commit to record; `relay --version` will print the version alone.\n');
} else {
  await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
  await writeFile(new URL('../dist/build.json', import.meta.url), `${JSON.stringify({ commit: sha }, null, 2)}\n`);
}
