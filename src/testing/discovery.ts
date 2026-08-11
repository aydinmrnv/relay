import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface TestCommand {
  command: string[];
  /** Why Relay chose this command — always shown before it runs. */
  reason: string;
  ecosystem: 'node' | 'python' | 'rust' | 'go' | 'explicit';
}

export type DiscoveryResult =
  | { found: true; command: TestCommand }
  | { found: false; reason: string };

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

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
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
 * Finds a test command from project metadata. Prefers an explicit, existing
 * test script; never invents one. Returning `found: false` is a normal outcome
 * and does not fail the run.
 */
export async function discoverTestCommand(
  root: string,
  override?: readonly string[] | null,
): Promise<DiscoveryResult> {
  if (override !== undefined && override !== null && override.length > 0) {
    return {
      found: true,
      command: {
        command: [...override],
        reason: 'configured in .relay/config.json (tests.command)',
        ecosystem: 'explicit',
      },
    };
  }

  const packageJsonPath = join(root, 'package.json');
  if (await exists(packageJsonPath)) {
    const pkg = await readJson(packageJsonPath);
    const scripts = pkg?.['scripts'];
    const testScript =
      scripts !== null && typeof scripts === 'object' ? (scripts as Record<string, unknown>)['test'] : undefined;

    if (typeof testScript === 'string' && testScript.trim().length > 0) {
      if (isPlaceholderScript(testScript)) {
        return { found: false, reason: 'package.json has the default placeholder test script' };
      }
      const screen = screenTestScript(testScript);
      if (!screen.safe) {
        return {
          found: false,
          reason: `package.json test script was skipped because it contains ${screen.label}: \`${testScript}\``,
        };
      }
      const manager = await detectPackageManager(root);
      return {
        found: true,
        command: {
          command: manager === 'npm' ? ['npm', 'test'] : [manager, 'test'],
          reason: `package.json defines scripts.test (\`${testScript}\`)`,
          ecosystem: 'node',
        },
      };
    }
    return { found: false, reason: 'package.json has no scripts.test' };
  }

  if (await exists(join(root, 'Cargo.toml'))) {
    return { found: true, command: { command: ['cargo', 'test'], reason: 'Cargo.toml found', ecosystem: 'rust' } };
  }

  if (await exists(join(root, 'go.mod'))) {
    return { found: true, command: { command: ['go', 'test', './...'], reason: 'go.mod found', ecosystem: 'go' } };
  }

  if (await exists(join(root, 'pyproject.toml'))) {
    const content = await readFile(join(root, 'pyproject.toml'), 'utf8').catch(() => '');
    // Only claim pytest when the project actually references it.
    if (/pytest/i.test(content) || (await exists(join(root, 'tests')))) {
      return {
        found: true,
        command: { command: ['python3', '-m', 'pytest'], reason: 'pyproject.toml references pytest', ecosystem: 'python' },
      };
    }
    return { found: false, reason: 'pyproject.toml found but no test runner could be identified' };
  }

  if ((await exists(join(root, 'setup.py'))) || (await exists(join(root, 'tox.ini')))) {
    if (await exists(join(root, 'tests'))) {
      return {
        found: true,
        command: { command: ['python3', '-m', 'pytest'], reason: 'python project with a tests/ directory', ecosystem: 'python' },
      };
    }
  }

  return { found: false, reason: 'no recognized project metadata with a test command' };
}
