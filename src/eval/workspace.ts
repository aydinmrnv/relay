/**
 * Materializing a fixture into a real git repository, and keeping the hidden
 * suite out of it.
 *
 * The acceptance criterion is that hidden suites are never visible to any
 * agent, *enforced by the worktree contents rather than by instruction*. That
 * is what this file is: `repo/` is copied and `hidden/` is not, and then the
 * result is checked rather than assumed — because "we only copied one of them"
 * is a claim about code, and the guarantee should survive someone editing it.
 */
import { access, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { git } from '../git/repository.ts';
import { RelayError } from '../util/errors.ts';
import type { Fixture } from './types.ts';

/** Root under which every eval scratch repository lives. */
export function evalRoot(): string {
  const home = process.env['RELAY_HOME'];
  return home !== undefined && home.length > 0 ? join(home, 'eval') : join(homedir(), '.relay', 'eval');
}

const IDENTITY = ['-c', 'user.name=Relay Eval', '-c', 'user.email=eval@relay.localhost'];

/**
 * The scratch repository a single run works against.
 *
 * One per run, not one per fixture: two runs of the same fixture must not be
 * able to see each other's branches, and a fixture that a run damaged must not
 * change what the next repetition starts from.
 */
export interface FixtureWorkspace {
  fixture: Fixture;
  /** Absolute path of the materialized repository — the visible tree. */
  root: string;
  /** Commit every worktree branches from. */
  baseSha: string;
  /** Scratch directory owning `root` and anything grading creates. */
  dir: string;
  cleanup(): Promise<void>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fails when any hidden path exists under `dir`.
 *
 * Called on the materialized repository before a run starts — where it is a
 * hard error, because a leaked suite invalidates every number the run produces
 * — and on the worktree after the run, where it is reported rather than thrown.
 */
export async function findHiddenPaths(dir: string, fixture: Fixture): Promise<string[]> {
  const present: string[] = [];
  for (const path of fixture.hiddenPaths) {
    if (await exists(join(dir, path))) present.push(path);
  }
  return present;
}

export async function assertHiddenSuiteAbsent(dir: string, fixture: Fixture): Promise<void> {
  const present = await findHiddenPaths(dir, fixture);
  if (present.length === 0) return;
  throw new RelayError(
    `Fixture "${fixture.id}" leaked its hidden suite into ${dir}: ${present.join(', ')}.`,
    {
      code: 'HIDDEN_SUITE_LEAKED',
      hint: 'The hidden suite must exist only under the fixture\'s hidden/ directory. Refusing to grade against a suite the agents could read.',
    },
  );
}

export interface MaterializeOptions {
  /** Directory the scratch repository is created under. */
  parent: string;
  /** Distinguishes repetitions of the same fixture. */
  label: string;
}

/**
 * Copies `repo/` into a fresh git repository and commits it.
 *
 * The commit matters: Relay branches every worktree from a base sha, and a
 * fixture with no commits has none. It is also what makes a result
 * reproducible — the diff a run is judged on is measured against this tree and
 * nothing else.
 */
export async function materializeFixture(
  fixture: Fixture,
  options: MaterializeOptions,
): Promise<FixtureWorkspace> {
  const dir = join(options.parent, `${fixture.id}-${options.label}`);
  // Named after the fixture rather than `repo`, because Relay derives a run's
  // worktree path from the repository directory name: `workspaces/local/repo/…`
  // for every fixture would make a stray worktree impossible to attribute.
  const root = join(dir, fixture.id);

  await mkdir(dirname(root), { recursive: true });
  await cp(join(fixture.dir, 'repo'), root, { recursive: true });

  // Relay writes run state under `<root>/.relay/runs`. Keeping it untracked
  // means the run's own bookkeeping can never show up in the diff it is graded
  // on. (The worktree is a separate directory, so this is belt and braces.)
  await writeFile(join(root, '.gitignore'), '.relay/\nnode_modules/\n', 'utf8');

  await git(['init', '--quiet', '--initial-branch=main'], { cwd: root });
  await git(['add', '-A'], { cwd: root });
  await git([...IDENTITY, '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '--message', `${fixture.id}: fixture snapshot`], {
    cwd: root,
  });

  // Structural, not advisory: if this ever fires, the harness stops rather than
  // reporting a solve rate measured against a suite the agents could read.
  await assertHiddenSuiteAbsent(root, fixture);

  const baseSha = await git(['rev-parse', 'HEAD'], { cwd: root });

  return {
    fixture,
    root,
    baseSha,
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A detached checkout of one commit, with the hidden suite overlaid on top.
 *
 * Grading happens here and never in the run's own worktree: the tree the agents
 * wrote in is never the tree they are judged in, so nothing an agent left
 * behind — a stub file at a hidden path, a `.gitignore` entry — can affect the
 * verdict.
 */
export interface GradingCheckout {
  path: string;
  dispose(): Promise<void>;
}

export async function createGradingCheckout(
  workspace: FixtureWorkspace,
  sha: string,
  label: string,
): Promise<GradingCheckout> {
  const path = join(workspace.dir, 'grade', label);
  await mkdir(dirname(path), { recursive: true });
  await git(['worktree', 'add', '--detach', '--quiet', path, sha], { cwd: workspace.root });

  return {
    path,
    dispose: async () => {
      try {
        await git(['worktree', 'remove', '--force', path], { cwd: workspace.root });
      } catch {
        // The scratch directory is removed wholesale afterwards; a worktree that
        // will not detach must not lose the result it was created to produce.
      }
      await rm(path, { recursive: true, force: true });
    },
  };
}

/** Overlays the hidden suite onto a grading checkout, overwriting what is there. */
export async function overlayHiddenSuite(checkoutPath: string, fixture: Fixture): Promise<void> {
  await cp(join(fixture.dir, 'hidden'), checkoutPath, { recursive: true, force: true });
}

/**
 * Applies the fixture's reference solution. Only `--check-fixtures` calls this;
 * nothing on the path a run takes can reach it.
 */
export async function applyReferenceSolution(checkoutPath: string, fixture: Fixture): Promise<void> {
  if (fixture.solutionPaths.length === 0) return;
  await cp(join(fixture.dir, 'solution'), checkoutPath, { recursive: true, force: true });
}

/**
 * Puts the fixture's own test files back before anything is judged.
 *
 * A change is measured against the behaviour contract that existed when it
 * started. Without this the cheapest way to pass the regression suite is to
 * delete the assertion that fails, and the harness would score that as clean.
 */
export async function restoreProtectedPaths(checkoutPath: string, fixture: Fixture): Promise<void> {
  for (const path of fixture.protectedPaths) {
    const target = join(checkoutPath, path);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(fixture.dir, 'repo', path), target, { recursive: true, force: true });
  }
}
