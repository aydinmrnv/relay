// Removes what a build writes, so a package is made from this build and
// nothing left over from an earlier one. `tsc` only ever adds files: a module
// deleted from src/ stays in dist/ until something takes it out, and `npm
// pack` ships whatever is there.
import { rm } from 'node:fs/promises';

for (const directory of ['dist', 'man']) {
  await rm(new URL(`../${directory}/`, import.meta.url), { recursive: true, force: true });
}
