import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The rules the Action and the workflows keep, checked as text.
 *
 * None of this can be run from a test — it only executes on a runner — so what
 * is asserted here is the shape that makes two specific mistakes impossible to
 * reintroduce quietly: an expression pasted into a script, and an action
 * referenced by a tag somebody else can move.
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
});
