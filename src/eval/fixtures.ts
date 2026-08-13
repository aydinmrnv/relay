/**
 * Reading the fixture set off disk, and refusing to run one that is malformed.
 *
 * A fixture is a directory, not a code path:
 *
 * ```
 * eval/fixtures/<id>/
 *   fixture.json        what the task is, where it came from, how it is judged
 *   task.md             the issue text the agents receive, verbatim
 *   repo/               the snapshot agents work in — everything they can see
 *   hidden/             the acceptance suite, overlaid only when grading
 * ```
 *
 * `repo/` and `hidden/` are separate trees because the guarantee is structural:
 * the harness materializes `repo/` and nothing else, so there is no instruction
 * anywhere telling an agent not to read the hidden suite — there is nothing to
 * read.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { screenTestScript } from '../testing/discovery.ts';
import { RelayError } from '../util/errors.ts';
import { isFixtureKind, type Fixture, type FixtureSource, type FixtureSuite } from './types.ts';

export const FIXTURE_FILES = {
  manifest: 'fixture.json',
  task: 'task.md',
  repo: 'repo',
  hidden: 'hidden',
  solution: 'solution',
} as const;

const DEFAULT_SUITE_TIMEOUT_MS = 5 * 60_000;

/**
 * Where the shipped fixture set lives.
 *
 * Resolved relative to this module so it works from the TypeScript sources and
 * from `dist/` alike: both sit one directory below the package root.
 */
export function defaultFixturesDir(): string {
  return join(import.meta.dirname, '..', '..', 'eval', 'fixtures');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bad(id: string, message: string): RelayError {
  return new RelayError(`Fixture "${id}": ${message}`, {
    code: 'BAD_FIXTURE',
    hint: 'See eval/README.md for the fixture format.',
  });
}

function readSuite(id: string, raw: unknown, label: string, fallbackTimeoutMs: number): FixtureSuite {
  if (!isRecord(raw)) throw bad(id, `${label} must be an object with a "command" array.`);

  const command = raw['command'];
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== 'string')) {
    throw bad(id, `${label}.command must be a non-empty array of strings, e.g. ["node", "--test", "test/"].`);
  }

  // Fixtures may come from `--fixtures <dir>`, so their commands are screened
  // with exactly the rules a project's own `test` script is screened with.
  const screened = screenTestScript((command as string[]).join(' '));
  if (!screened.safe) {
    throw bad(id, `${label}.command contains ${screened.label}, which Relay will not run.`);
  }

  const timeout = raw['timeoutMs'];
  if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1000)) {
    throw bad(id, `${label}.timeoutMs must be an integer of at least 1000.`);
  }

  return { command: command as string[], timeoutMs: (timeout as number | undefined) ?? fallbackTimeoutMs };
}

function readSource(id: string, raw: unknown): FixtureSource {
  if (!isRecord(raw)) throw bad(id, 'source must be an object.');
  const kind = raw['kind'];
  if (kind !== 'authored' && kind !== 'snapshot') {
    throw bad(id, 'source.kind must be "authored" or "snapshot".');
  }

  const source: FixtureSource = { kind };
  for (const key of ['repository', 'commit', 'license', 'note'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw bad(id, `source.${key} must be a string.`);
    source[key] = value;
  }

  // A pinned snapshot with no commit is not pinned, and a result computed
  // against "the repository, at some point" cannot be reproduced.
  if (kind === 'snapshot' && (source.repository === undefined || source.commit === undefined)) {
    throw bad(id, 'source.kind "snapshot" requires both source.repository and source.commit.');
  }
  return source;
}

/** Every file under `dir`, as paths relative to it, in sorted order. */
export async function listFilesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];

  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(relative(dir, path).split(sep).join('/'));
    }
  };

  await walk(dir);
  return found;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function readFixture(dir: string, id: string): Promise<Fixture> {
  const manifestPath = join(dir, FIXTURE_FILES.manifest);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw bad(id, `has no ${FIXTURE_FILES.manifest}.`);
    }
    throw bad(id, `${FIXTURE_FILES.manifest} is not valid JSON.`);
  }
  if (!isRecord(raw)) throw bad(id, `${FIXTURE_FILES.manifest} must contain a JSON object.`);

  if (raw['id'] !== undefined && raw['id'] !== id) {
    throw bad(id, `${FIXTURE_FILES.manifest} declares id "${String(raw['id'])}", which is not its directory name.`);
  }

  const title = raw['title'];
  if (typeof title !== 'string' || title.trim().length === 0) throw bad(id, 'title must be a non-empty string.');

  const kind = raw['kind'];
  if (!isFixtureKind(kind)) throw bad(id, 'kind must be one of bug, feature, refactor.');

  let task: string;
  try {
    task = await readFile(join(dir, FIXTURE_FILES.task), 'utf8');
  } catch {
    throw bad(id, `has no ${FIXTURE_FILES.task}.`);
  }
  if (task.trim().length === 0) throw bad(id, `${FIXTURE_FILES.task} is empty.`);

  const repoDir = join(dir, FIXTURE_FILES.repo);
  const hiddenDir = join(dir, FIXTURE_FILES.hidden);
  if (!(await isDirectory(repoDir))) throw bad(id, `has no ${FIXTURE_FILES.repo}/ directory.`);
  if (!(await isDirectory(hiddenDir))) throw bad(id, `has no ${FIXTURE_FILES.hidden}/ directory.`);

  const repoFiles = await listFilesUnder(repoDir);
  if (repoFiles.length === 0) throw bad(id, `${FIXTURE_FILES.repo}/ is empty.`);

  const hiddenPaths = await listFilesUnder(hiddenDir);
  if (hiddenPaths.length === 0) throw bad(id, `${FIXTURE_FILES.hidden}/ is empty — there is nothing to grade against.`);

  // The whole guarantee in one check: a path that exists in both trees is
  // visible to the agents, so it is not hidden, so grading against it is a lie.
  const visible = new Set(repoFiles);
  const leaked = hiddenPaths.filter((path) => visible.has(path));
  if (leaked.length > 0) {
    throw bad(id, `these hidden files also exist under ${FIXTURE_FILES.repo}/: ${leaked.join(', ')}.`);
  }

  return {
    id,
    dir,
    title,
    kind,
    task,
    source: readSource(id, raw['source']),
    acceptance: readSuite(id, raw['acceptance'], 'acceptance', DEFAULT_SUITE_TIMEOUT_MS),
    regression: readSuite(id, raw['regression'], 'regression', DEFAULT_SUITE_TIMEOUT_MS),
    hiddenPaths,
    protectedPaths: readProtected(id, raw['protected'], repoFiles),
    solutionPaths: (await isDirectory(join(dir, FIXTURE_FILES.solution)))
      ? await listFilesUnder(join(dir, FIXTURE_FILES.solution))
      : [],
  };
}

/**
 * The visible test files, restored before grading.
 *
 * Defaults to everything under `test/`, which is where a fixture's behaviour
 * contract lives by convention. A fixture that keeps its tests elsewhere says
 * so with a `protected` array.
 */
function readProtected(id: string, raw: unknown, repoFiles: readonly string[]): string[] {
  if (raw === undefined) return repoFiles.filter((path) => path.startsWith('test/'));

  if (!Array.isArray(raw) || raw.some((path) => typeof path !== 'string' || path.length === 0)) {
    throw bad(id, 'protected must be an array of non-empty repository-relative paths.');
  }

  const paths = raw as string[];
  const unknown = paths.filter((path) => !repoFiles.includes(path));
  if (unknown.length > 0) {
    throw bad(id, `protected names files that are not in ${FIXTURE_FILES.repo}/: ${unknown.join(', ')}.`);
  }
  return paths;
}

export interface LoadFixturesOptions {
  /** Fixture ids to keep. Empty means every fixture in the directory. */
  only?: readonly string[];
}

/** Loads and validates every fixture in a directory, sorted by id. */
export async function loadFixtures(dir: string, options: LoadFixturesOptions = {}): Promise<Fixture[]> {
  let entries: string[];
  try {
    entries = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    throw new RelayError(`No fixture directory at ${dir}.`, {
      code: 'NO_FIXTURES',
      hint: 'Point at one with `relay eval --fixtures <dir>`, or see eval/README.md.',
    });
  }

  const only = options.only ?? [];
  if (only.length > 0) {
    const unknown = only.filter((id) => !entries.includes(id));
    if (unknown.length > 0) {
      throw new RelayError(`No such fixture(s): ${unknown.join(', ')}.`, {
        code: 'NO_FIXTURES',
        hint: `Available: ${entries.join(', ')}.`,
      });
    }
  }

  const wanted = only.length > 0 ? entries.filter((id) => only.includes(id)) : entries;
  const fixtures: Fixture[] = [];
  for (const id of wanted) fixtures.push(await readFixture(join(dir, id), id));

  if (fixtures.length === 0) {
    throw new RelayError(`${dir} contains no fixtures.`, {
      code: 'NO_FIXTURES',
      hint: 'See eval/README.md for how to add one.',
    });
  }
  return fixtures;
}

/**
 * A stable issue number per fixture, so a run's branch and worktree name mean
 * something in a log. Deterministic in the id, not in the iteration order —
 * `--fixture` must not renumber the set it selects from.
 */
export function fixtureIssueNumber(id: string): number {
  let hash = 5381;
  for (const char of id) hash = ((hash * 33) ^ char.charCodeAt(0)) >>> 0;
  return 1 + (hash % 900);
}
