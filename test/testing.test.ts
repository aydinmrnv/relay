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

  it('prefers the Gradle wrapper the project pins, and falls back to gradle', async () => {
    await withRepo(async (root) => {
      await writeFile(join(root, 'build.gradle.kts'), 'plugins { java }\n', 'utf8');
      const bare = await discoverTestCommand(root, null);
      assert.equal(bare.found && bare.command.command.join(' '), 'gradle test');
      assert.equal(bare.found && bare.command.ecosystem, 'jvm');

      await writeFile(join(root, 'gradlew'), '#!/bin/sh\n', 'utf8');
      const wrapped = await discoverTestCommand(root, null);
      assert.equal(wrapped.found && wrapped.command.command.join(' '), './gradlew test');
      assert.match(wrapped.found ? wrapped.command.reason : '', /wrapper/);
    });
  });

  it('detects a Maven project', async () => {
    await withRepo(async (root) => {
      await writeFile(join(root, 'pom.xml'), '<project></project>\n', 'utf8');
      const result = await discoverTestCommand(root, null);
      assert.equal(result.found && result.command.command.join(' '), 'mvn -q test');
    });
  });

  it('prefers rspec over rake, and needs a declared test task for rake', async () => {
    await withRepo(async (root) => {
      await writeFile(join(root, 'Gemfile'), "source 'https://rubygems.org'\n", 'utf8');

      // A Gemfile alone declares nothing runnable.
      assert.equal((await discoverTestCommand(root, null)).found, false);

      await writeFile(join(root, 'Rakefile'), "task :build do\nend\n", 'utf8');
      const noTask = await discoverTestCommand(root, null);
      assert.equal(noTask.found, false);
      assert.match(noTask.found ? '' : noTask.reason, /Rakefile declares no test task/);

      await writeFile(join(root, 'Rakefile'), "Rake::TestTask.new(:test)\n", 'utf8');
      const rake = await discoverTestCommand(root, null);
      assert.equal(rake.found && rake.command.command.join(' '), 'bundle exec rake test');

      await mkdir(join(root, 'spec'), { recursive: true });
      const rspec = await discoverTestCommand(root, null);
      assert.equal(rspec.found && rspec.command.command.join(' '), 'bundle exec rspec');
      assert.equal(rspec.found && rspec.command.ecosystem, 'ruby');
    });
  });

  it('detects a .NET solution or project', async () => {
    await withRepo(async (root) => {
      await writeFile(join(root, 'Widgets.csproj'), '<Project />\n', 'utf8');
      const csproj = await discoverTestCommand(root, null);
      assert.equal(csproj.found && csproj.command.command.join(' '), 'dotnet test');
      assert.equal(csproj.found && csproj.command.ecosystem, 'dotnet');

      await writeFile(join(root, 'Widgets.sln'), '\n', 'utf8');
      const sln = await discoverTestCommand(root, null);
      assert.match(sln.found ? sln.command.reason : '', /Widgets\.sln/);
    });
  });

  it('uses a Makefile test target only when nothing more specific matches', async () => {
    await withRepo(async (root) => {
      await writeFile(join(root, 'Makefile'), 'build:\n\tcc main.c\n\ntest: build\n\t./run-tests.sh\n', 'utf8');
      const make = await discoverTestCommand(root, null);
      assert.equal(make.found && make.command.command.join(' '), 'make test');
      assert.equal(make.found && make.command.ecosystem, 'make');

      // A real ecosystem outranks a Makefile that only wraps it.
      await writeFile(join(root, 'go.mod'), 'module x\n', 'utf8');
      const go = await discoverTestCommand(root, null);
      assert.equal(go.found && go.command.command.join(' '), 'go test ./...');
    });
  });

  it('screens a Makefile test target the same way it screens scripts.test', async () => {
    await withRepo(async (root) => {
      await writeFile(join(root, 'Makefile'), 'test:\n\tsudo pytest\n', 'utf8');
      const direct = await discoverTestCommand(root, null);
      assert.equal(direct.found, false);
      assert.match(direct.found ? '' : direct.reason, /sudo/);

      // Hiding the command one target deeper does not get it past the screen.
      await writeFile(join(root, 'Makefile'), 'reset-db:\n\trm -rf ./data\n\ntest: reset-db\n\tpytest\n', 'utf8');
      const indirect = await discoverTestCommand(root, null);
      assert.equal(indirect.found, false);
      assert.match(indirect.found ? '' : indirect.reason, /recursive delete/);
    });
  });

  it('ignores a Makefile with no test target', async () => {
    await withRepo(async (root) => {
      await writeFile(join(root, 'Makefile'), 'test := build\n\nall:\n\tcc main.c\n', 'utf8');
      const result = await discoverTestCommand(root, null);
      assert.equal(result.found, false);
      assert.match(result.found ? '' : result.reason, /no recognized project metadata/);
    });
  });

  it('falls back to the package a monorepo change was confined to', async () => {
    await withRepo(async (root) => {
      // A root with no suite of its own — the case that used to verify nothing.
      await writeFile(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }), 'utf8');
      await mkdir(join(root, 'packages', 'api'), { recursive: true });
      await writeFile(
        join(root, 'packages', 'api', 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run' } }),
        'utf8',
      );

      const scoped = await discoverTestCommand(root, null, {
        changedPaths: ['packages/api/src/index.ts', 'packages/api/test/index.test.ts'],
      });
      assert.equal(scoped.found, true);
      if (!scoped.found) return;
      assert.deepEqual(scoped.command.command, ['npm', 'test']);
      assert.equal(scoped.command.directory, join(root, 'packages', 'api'));
      assert.match(scoped.command.reason, /only changed files under packages\/api\//);

      // A change spanning packages is not confined to one, so nothing is claimed.
      const spread = await discoverTestCommand(root, null, {
        changedPaths: ['packages/api/src/index.ts', 'packages/web/src/app.ts'],
      });
      assert.equal(spread.found, false);
    });
  });

  it('keeps the root suite when the root has one', async () => {
    await withRepo(async (root) => {
      await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }), 'utf8');
      await mkdir(join(root, 'packages', 'api'), { recursive: true });
      await writeFile(
        join(root, 'packages', 'api', 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run' } }),
        'utf8',
      );

      const result = await discoverTestCommand(root, null, { changedPaths: ['packages/api/src/index.ts'] });
      assert.equal(result.found && result.command.directory, root);
      assert.match(result.found ? result.command.reason : '', /node --test/);
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
