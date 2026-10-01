import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isolatedGitEnv } from './helpers/tempRepo.ts';

/**
 * The rules the Action and the workflows keep, checked as text.
 *
 * Almost none of this can be run from a test — it only executes on a runner —
 * so what is asserted here is the shape that makes two specific mistakes
 * impossible to reintroduce quietly: an expression pasted into a script, and an
 * action referenced by a tag somebody else can move. The exception is at the
 * bottom: the script that decides whether to publish, which is run.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['action.yml', '.github/workflows/ci.yml', '.github/workflows/cli-release.yml'] as const;

async function read(path: string): Promise<string> {
  return (await readFile(join(root, path), 'utf8')).replace(/\r\n/g, '\n');
}

interface RunBlock {
  line: number;
  body: string;
}

/**
 * The script of every `run:` in a YAML file, without a YAML parser: a block
 * scalar is every following line indented deeper than its key, and a one-line
 * `run:` is the rest of that line.
 */
function runBlocks(yaml: string): RunBlock[] {
  const lines = yaml.split('\n');
  const blocks: RunBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[index] ?? '');
    if (match === null) continue;
    const indent = (match[1] ?? '').length + ((lines[index] ?? '').trimStart().startsWith('- ') ? 2 : 0);
    const inline = match[2] ?? '';
    if (!/^[|>][+-]?$/.test(inline)) {
      blocks.push({ line: index + 1, body: inline });
      continue;
    }
    const body: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const text = lines[next] ?? '';
      if (text.trim().length > 0 && text.length - text.trimStart().length <= indent) break;
      body.push(text);
    }
    blocks.push({ line: index + 1, body: body.join('\n') });
  }
  return blocks;
}

describe('the Action and the workflows', () => {
  // `${{ inputs.issue }}` inside a script is pasted in before the shell parses
  // it, so an input of `$(curl … | sh)` is a command. Reaching the script
  // through `env:` makes it a string.
  it('never write an expression into a script', async () => {
    for (const file of FILES) {
      const blocks = runBlocks(await read(file));
      assert.ok(blocks.length > 0, `${file}: found no run blocks, so nothing was checked`);
      for (const block of blocks) {
        assert.ok(!block.body.includes('${{'), `${file}:${block.line} interpolates an expression into a run block`);
      }
    }
  });

  it('reference every action by commit, with the release it is in beside it', async () => {
    for (const file of FILES) {
      const uses = (await read(file)).split('\n').filter((line) => /^\s*(?:- )?uses:/.test(line));
      for (const line of uses) {
        const target = line.replace(/^\s*(?:- )?uses:\s*/, '');
        // This repository's own Action and workflows are whatever is checked out.
        if (target.startsWith('./')) continue;
        assert.match(target, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `${file}: ${line.trim()}`);
      }
    }
  });

  it('give CI no more than read access unless a job asks', async () => {
    const ci = await read('.github/workflows/ci.yml');
    assert.match(ci, /^permissions:\n {2}contents: read$/m);
    // Exactly one job writes, and it says so itself.
    const grants = ci.split('\n').filter((line) => /^\s+contents: write$/.test(line));
    assert.equal(grants.length, 1);
  });

  it('build, pack and install the package in CI', async () => {
    const ci = await read('.github/workflows/ci.yml');
    assert.match(ci, /^\s+- run: npm run build$/m);
    assert.match(ci, /npm pack --pack-destination/);
    // The Node floor in package.json is exercised, not just stated.
    const { engines } = JSON.parse(await read('package.json')) as { engines: { node: string } };
    const floor = /^>=(\d+\.\d+\.\d+)$/.exec(engines.node)?.[1];
    assert.ok(floor !== undefined, `engines.node is ${engines.node}`);
    assert.ok(ci.includes(`node: '${floor}'`), `CI never runs the suite on Node ${floor}`);
  });

  it('run the Action with its default version, not only the checkout', async () => {
    const ci = await read('.github/workflows/ci.yml');
    const job = /\n {2}action-install:\n([\s\S]*?)\n {2}\S/.exec(ci)?.[1] ?? '';
    assert.match(job, /uses: \.\//);
    assert.doesNotMatch(job, /^\s+version:/m, 'the job passes a version, so it is not testing the default');
  });

  // The install is from this repository's releases. A name on a registry is
  // whoever registered it, and what the Action runs has the job's tokens.
  it('install Relay from the release tarball, never from the npm registry by name', async () => {
    const action = await read('action.yml');
    const scripts = runBlocks(action).map((block) => block.body).join('\n');
    assert.doesNotMatch(scripts, /npm install[^\n]*relay-orchestrator@/);
    assert.match(scripts, /releases\/download/);
    assert.match(scripts, /tag=cli-latest/);
    assert.match(scripts, /tag="cli-v\$\{RELAY_VERSION#v\}"/);
    // Gated on CI: the release has no trigger of its own.
    const release = await read('.github/workflows/cli-release.yml');
    assert.match(release, /^on:\n {2}workflow_call:/m);
    // Delete-then-upload is a 404 for as long as the upload takes. Comments
    // may name the flag; nothing that runs may use it.
    const commands = release.split('\n').filter((line) => !line.trim().startsWith('#'));
    assert.ok(!commands.some((line) => line.includes('--clobber')), 'the release replaces an asset by deleting it first');
    const ci = await read('.github/workflows/ci.yml');
    assert.match(ci, /release:\n {4}needs: \[check, package, unattended, action-install\]/);
  });

  // The publish job reads package.json with `node` and installs the tarball
  // with `npm`, so it pins the Node it does that with like every other job.
  it('set up Node in the job that publishes', async () => {
    const release = await read('.github/workflows/cli-release.yml');
    assert.match(release, /uses: actions\/setup-node@[0-9a-f]{40} # v\d+\.\d+\.\d+\n\s+with:\n\s+node-version: 22\n/);
  });
});

/**
 * The one script in the release that decides something, run for real.
 *
 * "Should this commit replace what is published?" is a question about three
 * commits' places in a history, and the wrong answer either moves every install
 * back to older code or stops releases for good. It is plain git and shell, so
 * it is lifted out of the workflow and run against a repository built for it.
 */
describe('what the release decides to publish', () => {
  const skip =
    process.platform === 'win32'
      ? 'the release runs on a Linux runner; its script is bash'
      : spawnSync('bash', ['-c', 'exit 0']).status === 0
        ? false
        : 'bash is not installed';

  let dir: string;
  let repo: string;
  let script: string;
  let env: Record<string, string>;
  const commits: Record<'base' | 'cliChange' | 'docsOnly' | 'elsewhere', string> = {
    base: '',
    cliChange: '',
    docsOnly: '',
    elsewhere: '',
  };

  const git = (...args: string[]): string => {
    const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const commit = async (path: string, contents: string, message: string): Promise<string> => {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), contents, 'utf8');
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };

  before(async () => {
    if (skip !== false) return;
    const release = await read('.github/workflows/cli-release.yml');
    const named = release.split('\n').findIndex((line) => line.includes('- name: Decide what to publish')) + 1;
    assert.ok(named > 0, 'the release no longer has a step that decides what to publish');
    script = runBlocks(release).find((block) => block.line > named)?.body ?? '';
    assert.match(script, /rolling=/);

    dir = await realpath(await mkdtemp(join(tmpdir(), 'relay-release-')));
    repo = join(dir, 'repo');
    await mkdir(join(dir, 'pack'), { recursive: true });
    await writeFile(join(dir, 'pack', 'relay.tgz'), 'not a real tarball', 'utf8');
    // `gh release view` is asked whether the versioned release exists. Here
    // it never does, so `versioned` follows `rolling`.
    await mkdir(join(dir, 'bin'), { recursive: true });
    await writeFile(join(dir, 'bin', 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await mkdir(repo, { recursive: true });
    env = {
      ...(process.env as Record<string, string>),
      ...(await isolatedGitEnv(dir)),
      PATH: `${join(dir, 'bin')}:${process.env['PATH'] ?? ''}`,
      RUNNER_TEMP: dir,
      CLI_PATHS: 'src package.json',
    };

    git('init', '-q', '-b', 'main');
    commits.base = await commit('package.json', '{ "version": "0.1.0" }\n', 'base');
    // A commit main never had: what a rewritten history leaves the tag on.
    git('checkout', '-q', '-b', 'abandoned');
    commits.elsewhere = await commit('src/old.ts', 'export const old = 1;\n', 'abandoned work');
    git('checkout', '-q', 'main');
    commits.cliChange = await commit('src/a.ts', 'export const a = 1;\n', 'change the CLI');
    commits.docsOnly = await commit('docs/notes.md', 'notes\n', 'change only the docs');
  });
  after(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  /** Runs the step for `sha` with `cli-latest` at `published`, as the runner would. */
  async function plan(sha: string, published: string | null): Promise<{ rolling: string; versioned: string; log: string }> {
    if (published === null) spawnSync('git', ['tag', '-d', 'cli-latest'], { cwd: repo, env });
    else git('tag', '-f', 'cli-latest', published);
    git('checkout', '-q', '--detach', sha);

    const output = join(dir, 'output.txt');
    await writeFile(output, '', 'utf8');
    const result = spawnSync('bash', ['-c', script], {
      cwd: repo,
      env: { ...env, GITHUB_SHA: sha, GITHUB_OUTPUT: output },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `the step failed:\n${result.stdout}\n${result.stderr}`);
    const outputs = Object.fromEntries(
      (await readFile(output, 'utf8'))
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => line.split('=', 2) as [string, string]),
    );
    return { rolling: outputs['rolling'] ?? '', versioned: outputs['versioned'] ?? '', log: result.stdout };
  }

  it('publishes the first build, and cuts the versioned release with it', { skip }, async () => {
    const result = await plan(commits.cliChange, null);
    assert.equal(result.rolling, 'true');
    assert.equal(result.versioned, 'true');
  });

  it('publishes a commit that changed the CLI since the published one', { skip }, async () => {
    assert.equal((await plan(commits.cliChange, commits.base)).rolling, 'true');
  });

  it('publishes nothing for a commit that changed only something else', { skip }, async () => {
    const result = await plan(commits.docsOnly, commits.cliChange);
    assert.equal(result.rolling, 'false');
    assert.equal(result.versioned, 'false');
    assert.match(result.log, /Nothing the CLI is built from changed/);
  });

  it('publishes nothing twice', { skip }, async () => {
    assert.equal((await plan(commits.cliChange, commits.cliChange)).rolling, 'false');
  });

  // A slow run finishing after a faster, newer one — or an old run re-run.
  it('never moves the release back to an older commit', { skip }, async () => {
    const result = await plan(commits.cliChange, commits.docsOnly);
    assert.equal(result.rolling, 'false');
    assert.match(result.log, /already a newer commit/);
  });

  // "Not an ancestor" used to be read as "newer", which is true of the case
  // above and false of this one: nothing on main will ever descend from a
  // commit main does not have, so every release from here on was skipped.
  it('publishes over a commit that is not in the history at all', { skip }, async () => {
    const result = await plan(commits.docsOnly, commits.elsewhere);
    assert.equal(result.rolling, 'true');
    assert.match(result.log, /::warning::.*not in this branch's history/);
  });
});
