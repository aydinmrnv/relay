import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';

import { runProcess } from '../../src/process/runner.ts';
import type { Issue, IssueProvider } from '../../src/github/types.ts';

export interface TempRepo {
  root: string;
  relayHome: string;
  cleanup(): Promise<void>;
  git(...args: string[]): Promise<string>;
  writeFile(relativePath: string, contents: string): Promise<void>;
  commit(message: string): Promise<void>;
}

/**
 * Real git repository in a temp directory. Git integration is worth testing
 * against git itself: worktrees, diffs and refs have too much behaviour to mock
 * credibly.
 */
export async function createTempRepo(
  options: { withPackageJson?: boolean; empty?: boolean } = {},
): Promise<TempRepo> {
  // Resolve symlinks up front: git always reports realpaths, so tests that
  // compare against them must start from one too (macOS /var → /private/var).
  const base = await realpath(await mkdtemp(join(tmpdir(), 'relay-test-')));
  const root = join(base, 'repo');
  const relayHome = join(base, 'relay-home');
  await mkdir(root, { recursive: true });
  await mkdir(relayHome, { recursive: true });

  const git = async (...args: string[]): Promise<string> => {
    const result = await runProcess('git', args, {
      cwd: root,
      env: {
        GIT_AUTHOR_NAME: 'Relay Test',
        GIT_AUTHOR_EMAIL: 'test@relay.invalid',
        GIT_COMMITTER_NAME: 'Relay Test',
        GIT_COMMITTER_EMAIL: 'test@relay.invalid',
        // `os.devNull` rather than a literal `/dev/null`: on Windows the null
        // device is `\\.\nul`, and pointing git at a path that does not exist
        // would fail instead of isolating the test from the user's config.
        GIT_CONFIG_GLOBAL: devNull,
        GIT_CONFIG_SYSTEM: devNull,
      },
    });
    if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    return result.stdout.trim();
  };

  await git('init', '-q', '-b', 'main');

  const write = async (relativePath: string, contents: string): Promise<void> => {
    const path = join(root, relativePath);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, contents, 'utf8');
  };

  // `empty: true` stops here: `git init` and nothing else, which is the state a
  // brand new project is in and one Relay is expected to start work from.
  if (options.empty !== true) {
    await write('README.md', '# Test repo\n');
    await write('src/app.ts', 'export const value = 1;\n');
    if (options.withPackageJson === true) {
      await write('package.json', JSON.stringify({ name: 'temp', version: '1.0.0', scripts: { test: 'echo ok' } }, null, 2));
    }

    await git('add', '-A');
    await git('commit', '-q', '-m', 'initial commit');
  }

  return {
    root,
    relayHome,
    git,
    writeFile: write,
    commit: async (message: string) => {
      await git('add', '-A');
      await git('commit', '-q', '-m', message);
    },
    cleanup: async () => {
      await rm(base, { recursive: true, force: true });
    },
  };
}

/** Issue provider that never touches the network or `gh`. */
export class FakeIssueProvider implements IssueProvider {
  readonly name = 'fake';
  readonly requests: string[] = [];

  private readonly issue: Issue;

  constructor(overrides: Partial<Issue> = {}) {
    this.issue = {
      id: 'fake:acme/widgets#142',
      number: 142,
      title: 'Add authentication rate limiting',
      body: 'Logins should be rate limited per IP.',
      url: 'https://github.com/acme/widgets/issues/142',
      state: 'open',
      author: 'someone',
      labels: ['bug'],
      repository: { owner: 'acme', name: 'widgets' },
      comments: [],
      ...overrides,
    };
  }

  async getIssue(ref: string): Promise<Issue> {
    this.requests.push(ref);
    return this.issue;
  }

  async listIssues(): Promise<null> { return null; }

  async checkAvailability(): Promise<{ available: boolean; detail: string }> {
    return { available: true, detail: 'fake' };
  }
}
