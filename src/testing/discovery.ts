import { access, readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export type Ecosystem = 'node' | 'python' | 'rust' | 'go' | 'jvm' | 'ruby' | 'dotnet' | 'make' | 'explicit';

export interface TestCommand {
  command: string[];
  /** Why Relay chose this command — always shown before it runs. */
  reason: string;
  ecosystem: Ecosystem;
  /** Absolute directory the command runs in. Defaults to the worktree root. */
  directory?: string;
}

export type DiscoveryResult =
  | { found: true; command: TestCommand }
  | { found: false; reason: string };

export interface DiscoveryOptions {
  /**
   * Paths the run changed, relative to `root`. Used only as a fallback: when the
   * root declares no test command, a change confined to one package can still be
   * verified by that package's own suite.
   */
  changedPaths?: readonly string[];
}

/**
 * Commands Relay refuses to run even if a project's `test` script contains
 * them. Discovery reads project metadata written by whoever controls the repo,
 * and a run should never be the thing that publishes, deploys, or destroys.
 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\brm\s+-[a-z]*[rf]/i, label: 'recursive delete' },
  { pattern: /\bsudo\b/i, label: 'sudo' },
  { pattern: /\bgit\s+push\b/i, label: 'git push' },
  { pattern: /\bnpm\s+publish\b/i, label: 'npm publish' },
  { pattern: /\bdocker\s+(run|compose|build)\b/i, label: 'docker' },
  { pattern: /\b(deploy|publish|release)\b/i, label: 'deploy/publish/release' },
  { pattern: /curl[^|]*\|\s*(ba)?sh/i, label: 'curl-pipe-shell' },
  { pattern: /\bwget\b/i, label: 'network download' },
  { pattern: /\bterraform\b|\bkubectl\b|\bhelm\b/i, label: 'infrastructure tooling' },
  { pattern: /\bshutdown\b|\breboot\b|\bmkfs\b/i, label: 'system command' },
];

export function screenTestScript(script: string): { safe: true } | { safe: false; label: string } {
  for (const { pattern, label } of DANGEROUS_PATTERNS) {
    if (pattern.test(script)) return { safe: false, label };
  }
  return { safe: true };
}

/** npm's own placeholder, which exits 1 and means "there is no test suite". */
function isPlaceholderScript(script: string): boolean {
  return /no test specified/i.test(script);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8').catch(() => '');
}

/** Lockfile decides the package manager; guessing would run the wrong one. */
async function detectPackageManager(root: string): Promise<'npm' | 'pnpm' | 'yarn' | 'bun'> {
  if (await exists(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(join(root, 'yarn.lock'))) return 'yarn';
  if (await exists(join(root, 'bun.lockb'))) return 'bun';
  if (await exists(join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}

/**
 * What one detector concluded. `undefined` means "this is not my ecosystem, keep
 * looking"; `found: false` means "this *is* my ecosystem and it declares no test
 * command I will run", which is a more useful answer than the generic one.
 */
type Detection = DiscoveryResult | undefined;

interface DetectorContext {
  /** Absolute directory being inspected. */
  dir: string;
  /** How to name a file in that directory, e.g. `packages/api/package.json`. */
  label: (file: string) => string;
}

function found(
  context: DetectorContext,
  command: string[],
  reason: string,
  ecosystem: Ecosystem,
): DiscoveryResult {
  return { found: true, command: { command, reason, ecosystem, directory: context.dir } };
}

async function detectNode({ dir, label }: DetectorContext): Promise<Detection> {
  const packageJsonPath = join(dir, 'package.json');
  if (!(await exists(packageJsonPath))) return undefined;

  const pkg = await readJson(packageJsonPath);
  const scripts = pkg?.['scripts'];
  const testScript =
    scripts !== null && typeof scripts === 'object' ? (scripts as Record<string, unknown>)['test'] : undefined;

  if (typeof testScript !== 'string' || testScript.trim().length === 0) {
    return { found: false, reason: `${label('package.json')} has no scripts.test` };
  }
  if (isPlaceholderScript(testScript)) {
    return { found: false, reason: `${label('package.json')} has the default placeholder test script` };
  }
  const screen = screenTestScript(testScript);
  if (!screen.safe) {
    return {
      found: false,
      reason: `${label('package.json')} test script was skipped because it contains ${screen.label}: \`${testScript}\``,
    };
  }

  const manager = await detectPackageManager(dir);
  return found(
    { dir, label },
    manager === 'npm' ? ['npm', 'test'] : [manager, 'test'],
    `${label('package.json')} defines scripts.test (\`${testScript}\`)`,
    'node',
  );
}

async function detectRust(context: DetectorContext): Promise<Detection> {
  if (!(await exists(join(context.dir, 'Cargo.toml')))) return undefined;
  return found(context, ['cargo', 'test'], `${context.label('Cargo.toml')} found`, 'rust');
}

async function detectGo(context: DetectorContext): Promise<Detection> {
  if (!(await exists(join(context.dir, 'go.mod')))) return undefined;
  return found(context, ['go', 'test', './...'], `${context.label('go.mod')} found`, 'go');
}

async function detectPython(context: DetectorContext): Promise<Detection> {
  const { dir, label } = context;

  if (await exists(join(dir, 'pyproject.toml'))) {
    const content = await readText(join(dir, 'pyproject.toml'));
    // Only claim pytest when the project actually references it.
    if (/pytest/i.test(content) || (await isDirectory(join(dir, 'tests')))) {
      return found(context, ['python3', '-m', 'pytest'], `${label('pyproject.toml')} references pytest`, 'python');
    }
    return { found: false, reason: `${label('pyproject.toml')} found but no test runner could be identified` };
  }

  if ((await exists(join(dir, 'setup.py'))) || (await exists(join(dir, 'tox.ini')))) {
    if (await isDirectory(join(dir, 'tests'))) {
      return found(context, ['python3', '-m', 'pytest'], `python project with a ${label('tests/')} directory`, 'python');
    }
  }
  return undefined;
}

/** Gradle ships a wrapper precisely so the build is run with the version the project pins. */
async function detectGradle(context: DetectorContext): Promise<Detection> {
  const { dir, label } = context;
  const buildFile = (await exists(join(dir, 'build.gradle')))
    ? 'build.gradle'
    : (await exists(join(dir, 'build.gradle.kts')))
      ? 'build.gradle.kts'
      : undefined;
  if (buildFile === undefined) return undefined;

  if (await exists(join(dir, 'gradlew'))) {
    return found(context, ['./gradlew', 'test'], `${label(buildFile)} found, with a Gradle wrapper`, 'jvm');
  }
  return found(context, ['gradle', 'test'], `${label(buildFile)} found (no Gradle wrapper)`, 'jvm');
}

async function detectMaven(context: DetectorContext): Promise<Detection> {
  if (!(await exists(join(context.dir, 'pom.xml')))) return undefined;
  return found(context, ['mvn', '-q', 'test'], `${context.label('pom.xml')} found`, 'jvm');
}

/**
 * Ruby projects declare their suite in one of two places. RSpec wins when a
 * `spec/` directory exists, because a project with specs runs them; otherwise a
 * Rakefile counts only if it actually declares a `test` task.
 */
async function detectRuby(context: DetectorContext): Promise<Detection> {
  const { dir, label } = context;
  if (!(await exists(join(dir, 'Gemfile')))) return undefined;

  if (await isDirectory(join(dir, 'spec'))) {
    return found(context, ['bundle', 'exec', 'rspec'], `${label('Gemfile')} with a ${label('spec/')} directory`, 'ruby');
  }

  const rakefilePath = join(dir, 'Rakefile');
  if (await exists(rakefilePath)) {
    const rakefile = await readText(rakefilePath);
    if (/Rake::TestTask|task\s+:test\b|task\s+['"]test['"]/.test(rakefile)) {
      return found(context, ['bundle', 'exec', 'rake', 'test'], `${label('Rakefile')} declares a test task`, 'ruby');
    }
    return { found: false, reason: `${label('Rakefile')} declares no test task` };
  }
  return undefined;
}

async function detectDotnet(context: DetectorContext): Promise<Detection> {
  const entries = await readdir(context.dir).catch(() => [] as string[]);
  const project = entries.find((entry) => entry.endsWith('.sln')) ?? entries.find((entry) => entry.endsWith('.csproj'));
  if (project === undefined) return undefined;
  return found(context, ['dotnet', 'test'], `${context.label(project)} found`, 'dotnet');
}

/**
 * Last resort: a hand-written `test` target. A Makefile recipe is
 * attacker-controlled in exactly the way `scripts.test` is, so it is screened
 * the same way — including the recipes of the targets it depends on.
 */
async function detectMake(context: DetectorContext): Promise<Detection> {
  const { dir, label } = context;
  const makefile = (await exists(join(dir, 'Makefile')))
    ? 'Makefile'
    : (await exists(join(dir, 'makefile')))
      ? 'makefile'
      : undefined;
  if (makefile === undefined) return undefined;

  const content = await readText(join(dir, makefile));
  const recipe = collectMakeRecipe(content, 'test');
  if (recipe === undefined) return undefined;

  const screen = screenTestScript(recipe);
  if (!screen.safe) {
    return {
      found: false,
      reason: `${label(makefile)} test target was skipped because it contains ${screen.label}`,
    };
  }
  return found(context, ['make', 'test'], `${label(makefile)} declares a test target`, 'make');
}

/**
 * Returns the recipe lines of a Makefile target, plus those of every target it
 * depends on, or `undefined` when the target is not declared. Variable
 * assignments (`test := …`) are deliberately not targets.
 */
export function collectMakeRecipe(content: string, target: string, seen = new Set<string>()): string | undefined {
  if (seen.has(target)) return '';
  seen.add(target);

  const lines = content.split('\n');
  // Prerequisites come from the Makefile, so the target name is escaped before
  // it becomes a pattern: `*.o` must not compile to an invalid expression.
  const header = new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:(?![=:]?=)`);

  let index = lines.findIndex((line) => header.test(line));
  if (index === -1) return undefined;

  const prerequisites = (lines[index] ?? '').split(':').slice(1).join(':').split(/\s+/).filter((part) => part.length > 0);
  const recipe: string[] = [];

  for (index += 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.startsWith('\t')) {
      recipe.push(line.trim());
      continue;
    }
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue;
    break;
  }

  for (const prerequisite of prerequisites) {
    const inherited = collectMakeRecipe(content, prerequisite, seen);
    if (inherited !== undefined) recipe.push(inherited);
  }

  return recipe.join('\n');
}

/** Highest-signal metadata first; `make` last, since it is the vaguest evidence. */
const DETECTORS: Array<(context: DetectorContext) => Promise<Detection>> = [
  detectNode,
  detectRust,
  detectGo,
  detectPython,
  detectGradle,
  detectMaven,
  detectRuby,
  detectDotnet,
  detectMake,
];

async function detectIn(root: string, dir: string): Promise<Detection> {
  const prefix = relative(root, dir);
  const context: DetectorContext = {
    dir,
    label: (file) => (prefix.length === 0 ? file : `${prefix.split(sep).join('/')}/${file}`),
  };

  let declined: DiscoveryResult | undefined;
  for (const detector of DETECTORS) {
    const detection = await detector(context);
    if (detection === undefined) continue;
    if (detection.found) return detection;
    // Keep the first specific "no test command here" so the run can report it
    // instead of the generic fallback, but let the other detectors try.
    declined ??= detection;
  }
  return declined;
}

/** Deepest directory (relative to the root) that contains every changed path. */
function commonDirectory(paths: readonly string[]): string[] {
  const segmented = paths
    .map((path) => path.split('/').filter((part) => part.length > 0 && part !== '.'))
    .filter((parts) => parts.length > 1)
    .map((parts) => parts.slice(0, -1));
  if (segmented.length === 0 || segmented.length !== paths.length) return [];

  const [first = [], ...rest] = segmented;
  const common: string[] = [];
  for (let index = 0; index < first.length; index += 1) {
    const segment = first[index]!;
    if (!rest.every((parts) => parts[index] === segment)) break;
    common.push(segment);
  }
  return common;
}

/**
 * Monorepo fallback. Walks from the directory that contains the run's changes
 * up towards the root, so a change confined to `packages/api` is verified by
 * that package's own suite rather than by nothing at all.
 */
async function detectForChangedPaths(root: string, changedPaths: readonly string[]): Promise<Detection> {
  let segments = commonDirectory(changedPaths);

  while (segments.length > 0) {
    const detection = await detectIn(root, join(root, ...segments));
    if (detection?.found === true) {
      return {
        found: true,
        command: {
          ...detection.command,
          reason: `${detection.command.reason}; the run only changed files under ${segments.join('/')}/`,
        },
      };
    }
    segments = segments.slice(0, -1);
  }
  return undefined;
}

/**
 * Finds a test command from project metadata. Prefers an explicit, existing
 * test script; never invents one. Returning `found: false` is a normal outcome
 * and does not fail the run.
 */
export async function discoverTestCommand(
  root: string,
  override?: readonly string[] | null,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  if (override !== undefined && override !== null && override.length > 0) {
    return {
      found: true,
      command: {
        command: [...override],
        reason: 'configured in .relay/config.json (tests.command)',
        ecosystem: 'explicit',
        directory: root,
      },
    };
  }

  const atRoot = await detectIn(root, root);
  if (atRoot?.found === true) return atRoot;

  const scoped = await detectForChangedPaths(root, options.changedPaths ?? []);
  if (scoped?.found === true) return scoped;

  return atRoot ?? { found: false, reason: 'no recognized project metadata with a test command' };
}
