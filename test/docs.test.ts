import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXIT } from '../src/cli/exit.ts';
import { buildProgram } from '../src/cli/program.ts';
import { DEFAULT_CONFIG, mergeConfig } from '../src/storage/config.ts';
import { RELAY_IGNORE_ENTRIES } from '../src/cli/onboarding.ts';

/**
 * docs/cli.md against the code it describes.
 *
 * A reference page drifts one default at a time: the code changes, the
 * sentence stays, and the page goes on saying plan reviews take three rounds
 * for a year after they started taking two. These are the claims that have
 * drifted before, each checked against the value it is about.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function docs(): Promise<string> {
  return (await readFile(join(root, 'docs', 'cli.md'), 'utf8')).replace(/\r\n/g, '\n');
}

describe('docs/cli.md', () => {
  it('shows a config example that is the shipped defaults', async () => {
    const text = await docs();
    const start = text.indexOf('## Configuration\n\n`.relay/config.json`:\n\n```json\n');
    assert.ok(start !== -1, 'the configuration example has moved');
    const from = text.indexOf('{', start);
    const example = JSON.parse(text.slice(from, text.indexOf('\n```', from))) as Record<string, unknown>;

    // The one line that is there to show a shape rather than a default.
    assert.deepEqual(example['models'], { codeReviewer: 'haiku' });
    delete example['models'];

    // Loading it also proves every key in it is one Relay knows.
    assert.deepEqual(mergeConfig(DEFAULT_CONFIG, example), DEFAULT_CONFIG);
    // And key by key, so the message names the one that drifted. The example
    // may leave a key out; it may not show a value that is not the default.
    const defaults = DEFAULT_CONFIG as unknown as Record<string, Record<string, unknown>>;
    for (const [section, values] of Object.entries(example as Record<string, Record<string, unknown>>)) {
      for (const [key, value] of Object.entries(values)) {
        assert.deepEqual(value, defaults[section]?.[key], `the example shows ${section}.${key} as ${JSON.stringify(value)}`);
      }
    }
  });

  it('states the round limits the defaults actually set', async () => {
    const { maxPlanReviewRounds, maxCodeReviewRounds } = DEFAULT_CONFIG.workflow;
    assert.match(await docs(), new RegExp(`Round limits are enforced \\(plan ${maxPlanReviewRounds}, code ${maxCodeReviewRounds} by default\\)`));
  });

  it('lists every exit code Relay uses', async () => {
    const text = await docs();
    for (const code of Object.values(EXIT)) assert.match(text, new RegExp(`^\\| ${code} \\| `, 'm'), `exit code ${code}`);
  });

  it('names every file `relay init` gitignores', async () => {
    const text = await docs();
    for (const entry of RELAY_IGNORE_ENTRIES) assert.ok(text.includes(`\`${entry}\``), `${entry} is ignored and not documented`);
  });

  // Hidden from the help means hidden from the reference too: a flag the docs
  // describe is a flag the docs advertise.
  it('does not describe what the help deliberately leaves out', async () => {
    const text = await docs();
    assert.doesNotMatch(text, /--tuff|workflow\.typos/);
  });

  it('documents every flag `relay run` shows in its help', async () => {
    const text = await docs();
    const run = buildProgram('test').commands.find((command) => command.name() === 'run');
    assert.ok(run);
    for (const option of run.options) {
      if (option.hidden || option.long === undefined) continue;
      assert.ok(text.includes(`\`${option.long}`), `relay run ${option.long} is not in docs/cli.md`);
    }
  });

  it('documents the config keys a repository can set', async () => {
    const text = await docs();
    for (const key of [
      'workflow.maxConcurrentRuns',
      'workflow.baseBranch',
      'workflow.branchPrefix',
      'retention.artifactDays',
      'timeouts.planningMs',
      'timeouts.reviewMs',
      'timeouts.implementationMs',
      'timeouts.testsMs',
      'unattended.allowEnv',
    ]) {
      assert.ok(text.includes(`\`${key}\``), `${key} is not documented`);
    }
  });

  // The pipeline bypasses each CLI's own permission prompt. That is a fact a
  // reader deciding where to run this has to be able to find, in these words.
  it('discloses that the agents run without permission prompts', async () => {
    const text = await docs();
    assert.ok(text.includes('--permission-mode bypassPermissions'));
    assert.ok(text.includes('approval_policy="never"'));
    assert.match(text, /### Untrusted input/);
    assert.match(text, /run unattended on a private repository/);
  });
});
