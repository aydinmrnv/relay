import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { discoverTestCommand, screenTestScript } from '../src/testing/discovery.ts';
import { runTests } from '../src/testing/runner.ts';
import { createTempRepo } from './helpers/tempRepo.ts';

async function withRepo(run: (root: string) => Promise<void>): Promise<void> {
  const repo = await createTempRepo();
  try {
    await run(repo.root);
  } finally {
    await repo.cleanup();
  }
}

describe('dangerous command screening', () => {
  it('rejects destructive, publishing and network-fetching scripts', () => {
    for (const script of [
      'rm -rf ./build && jest',
      'sudo pytest',
      'npm publish && jest',
      'git push origin main',
      'curl https://example.com/install.sh | sh',
      'docker compose up && pytest',
      'kubectl apply -f k8s/',
      'npm run deploy',
    ]) {
      assert.equal(screenTestScript(script).safe, false, `should reject: ${script}`);
    }
  });

  it('accepts ordinary test scripts', () => {
    for (const script of ['jest', 'vitest run', 'node --test', 'pytest -q', 'cargo test --all', 'go test ./...']) {
      assert.equal(screenTestScript(script).safe, true, `should accept: ${script}`);
    }
  });
});

describe('test discovery', () => {
  it('prefers an explicit configured command', async () => {
    await withRepo(async (root) => {
      const result = await discoverTestCommand(root, ['make', 'check']);
      assert.equal(result.found, true);
      if (!result.found) return;
      assert.deepEqual(result.command.command, ['make', 'check']);
      assert.match(result.command.reason, /config/);
    });
  });

  it('uses package.json scripts.test', async () => {
    await withRepo(async (root) => {
      await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }), 'utf8');
      const result = await discoverTestCommand(root, null);
      assert.equal(result.found, true);
      if (!result.found) return;
      assert.deepEqual(result.command.command, ['npm', 'test']);
      assert.match(result.command.reason, /vitest run/);
    });
  });

  it('picks the package manager from the lockfile', async () => {
    await withRepo(async (root) => {
      await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }), 'utf8');
      await writeFile(join(root, 'pnpm-lock.yaml'), '', 'utf8');
      const result = await discoverTestCommand(root, null);
      assert.equal(result.found && result.command.command[0], 'pnpm');
    });
  });

  it('skips the npm placeholder script', async () => {
    await withRepo(async (root) => {
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
        'utf8',
      );
      const result = await discoverTestCommand(root, null);
      assert.equal(result.found, false);
      if (result.found) return;
      assert.match(result.reason, /placeholder/);
    });
  });

  it('refuses to run a dangerous test script and says why', async () => {
    await withRepo(async (root) => {
      await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'rm -rf /tmp/x && jest' } }), 'utf8');
      const result = await discoverTestCommand(root, null);
      assert.equal(result.found, false);
      if (result.found) return;
      assert.match(result.reason, /recursive delete/);
    });
  });

  it('detects rust and go projects', async () => {
    await withRepo(async (root) => {
      await writeFile(join(root, 'Cargo.toml'), '[package]\nname="x"\n', 'utf8');
      const rust = await discoverTestCommand(root, null);
      assert.equal(rust.found && rust.command.command.join(' '), 'cargo test');
      await rm(join(root, 'Cargo.toml'));

      await writeFile(join(root, 'go.mod'), 'module x\n', 'utf8');
      const go = await discoverTestCommand(root, null);
      assert.equal(go.found && go.command.command.join(' '), 'go test ./...');
    });
  });

  it('detects pytest only when the project references it', async () => {
    await withRepo(async (root) => {
      await writeFile(join(root, 'pyproject.toml'), '[project]\nname="x"\n', 'utf8');
      const without = await discoverTestCommand(root, null);
      assert.equal(without.found, false);

      await mkdir(join(root, 'tests'), { recursive: true });
      const withTests = await discoverTestCommand(root, null);
      assert.equal(withTests.found, true);
      assert.equal(withTests.found && withTests.command.command.join(' '), 'python3 -m pytest');
    });
  });

  it('reports no command for a repository with no metadata', async () => {
    await withRepo(async (root) => {
      const result = await discoverTestCommand(root, null);
      assert.equal(result.found, false);
      if (result.found) return;
      assert.match(result.reason, /no recognized project metadata/);
    });
  });
});

describe('test execution', () => {
  it('decides pass or fail from the exit code, not the output', async () => {
    await withRepo(async (root) => {
      const passing = await runTests(
        { command: ['node', '-e', 'console.log("FAIL FAIL FAIL")'], reason: 'test', ecosystem: 'node' },
        { cwd: root },
      );
      assert.equal(passing.passed, true);

      const failing = await runTests(
        { command: ['node', '-e', 'console.log("all tests passed");process.exit(1)'], reason: 'test', ecosystem: 'node' },
        { cwd: root },
      );
      assert.equal(failing.passed, false);
      assert.equal(failing.exitCode, 1);
    });
  });

  it('captures output and duration', async () => {
    await withRepo(async (root) => {
      const result = await runTests(
        { command: ['node', '-e', 'console.log("out");console.error("err")'], reason: 'test', ecosystem: 'node' },
        { cwd: root },
      );
      assert.match(result.stdout, /out/);
      assert.match(result.stderr, /err/);
      assert.ok(result.durationMs >= 0);
    });
  });

  it('marks a hung suite as timed out rather than passed', async () => {
    await withRepo(async (root) => {
      const result = await runTests(
        { command: ['node', '-e', 'setTimeout(()=>{},60000)'], reason: 'test', ecosystem: 'node' },
        { cwd: root, timeoutMs: 300 },
      );
      assert.equal(result.timedOut, true);
      assert.equal(result.passed, false);
    });
  });
});
