import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setTheme } from '../src/cli/output.ts';
import { mergeAvailability, offerMerge } from '../src/cli/mergeOffer.ts';
import { RunStore } from '../src/storage/runs.ts';
import { DEFAULT_CONFIG } from '../src/storage/config.ts';
import { createRunId } from '../src/util/ids.ts';
import { createRunState, transition, type RunState } from '../src/workflow/state.ts';
import type { Theme } from '../src/ui/theme.ts';
import { ScriptedPrompter } from './helpers/scriptedPrompter.ts';
import { createTempRepo, type TempRepo } from './helpers/tempRepo.ts';

let repo: TempRepo;

const PIPED: Theme = { color: false, unicode: true, interactive: false };

beforeEach(async () => {
  repo = await createTempRepo();
  setTheme(PIPED);
});

afterEach(async () => {
  setTheme(undefined);
  await repo.cleanup();
});

/** A run that delivered to a pull request: committed, pushed, open for review. */
function delivered(root: string): RunState {
  const state = createRunState({
    runId: createRunId(new Date('2026-08-12T10:00:00Z')),
    shortId: 'bg6pcf',
    issueRef: '13',
    repository: { root, owner: 'acme', name: 'widgets', defaultBranch: 'main' },
    config: structuredClone(DEFAULT_CONFIG),
    now: new Date('2026-08-12T10:00:00Z'),
  });

  state.workspace = {
    path: `${root}/worktree`,
    branch: 'relay/13-ce2ubs',
    baseSha: 'b'.repeat(40),
    baseRef: 'refs/heads/main',
    baseBranch: 'main',
  };
  state.diff = { fileCount: 3, additions: 40, deletions: 7, files: [], patchFile: 'p', at: 'x' };
  state.planApproved = true;
  state.tests = {
    discovered: true,
    command: ['npm', 'test'],
    reason: 'package.json',
    exitCode: 0,
    passed: true,
    durationMs: 12_000,
    timedOut: false,
    at: 'x',
  };
  state.commit = { sha: 'a'.repeat(40), branch: 'relay/13-ce2ubs', subject: 'x', at: 'x' };
  state.push = { remote: 'origin', branch: 'relay/13-ce2ubs', sha: 'a'.repeat(40), at: 'x' };
  state.pullRequest = {
    url: 'https://github.com/acme/widgets/pull/21',
    number: 21,
    base: 'main',
    head: 'relay/13-ce2ubs',
    createdByRun: true,
    at: 'x',
  };
  state.delivery = { policy: 'pr', reached: 'pr', steps: [], at: 'x' };

  for (const phase of [
    'FETCHING_ISSUE',
    'CREATING_WORKSPACE',
    'PLANNING',
    'REVIEWING_PLAN',
    'IMPLEMENTING',
    'REVIEWING_CODE',
    'TESTING',
    'DELIVERING',
    'COMPLETE',
  ] as const) {
    transition(state, phase);
  }
  return state;
}

interface Session {
  output: string;
  merged: boolean;
  asked: string[];
  merges: number;
}

/** Runs the offer against a scripted terminal, capturing what it printed. */
async function offer(
  answers: readonly string[],
  state: RunState,
  options: { interactive?: boolean } = {},
): Promise<Session> {
  const prompter = new ScriptedPrompter(answers, options.interactive ?? true);
  const store = new RunStore(repo.root, state.runId);
  await store.init();

  let merges = 0;
  const originalWrite = process.stdout.write.bind(process.stdout);
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;

  try {
    const merged = await offerMerge(state, store, {
      prompter,
      merge: async () => {
        merges += 1;
        state.merge = {
          into: 'main',
          via: 'pull-request',
          ...(state.pullRequest === undefined ? {} : { url: state.pullRequest.url }),
          at: 'x',
        };
      },
    });
    return { output, merged, asked: prompter.asked, merges };
  } finally {
    process.stdout.write = originalWrite;
  }
}

describe('the merge offer', () => {
  it('asks once, naming the pull request and how it would land', async () => {
    const session = await offer(['y'], delivered(repo.root));

    assert.equal(session.asked.length, 1);
    assert.match(session.asked[0] ?? '', /Merge https:\/\/github\.com\/acme\/widgets\/pull\/21 into main now\? \(squash\)/);
    assert.equal(session.merged, true);
    assert.equal(session.merges, 1);
  });

  it('does nothing on no, which is what pressing Enter does', async () => {
    const state = delivered(repo.root);
    const declined = await offer(['n'], state);
    assert.equal(declined.merged, false);
    assert.equal(state.merge, undefined);

    // An exhausted script takes the default, exactly as Enter would.
    const enter = await offer([], delivered(repo.root));
    assert.equal(enter.merges, 0);
    assert.match(enter.output, /Left unmerged/);
  });

  it('offers a merge in your own checkout when there is no pull request', async () => {
    const state = delivered(repo.root);
    delete state.pullRequest;
    delete state.push;

    // The temp repo is on main with a clean tree, which is the only state a
    // local merge is allowed to run in.
    const session = await offer(['y'], state);
    assert.match(session.asked[0] ?? '', /Merge relay\/13-ce2ubs into main in your checkout now\?/);
    assert.equal(session.merged, true);
  });

  it('does not offer a merge the checkout cannot take', async () => {
    const state = delivered(repo.root);
    delete state.pullRequest;
    await repo.git('checkout', '-q', '-b', 'somewhere-else');

    const session = await offer(['y'], state);
    assert.equal(session.asked.length, 0);
    assert.match(session.output, /No merge offered: your checkout is on somewhere-else, not main/);
  });

  it('does not offer to merge work the run itself could not vouch for', async () => {
    const failing = delivered(repo.root);
    failing.tests = { ...failing.tests!, passed: false, exitCode: 1 };

    const session = await offer(['y'], failing);
    assert.equal(session.asked.length, 0);
    // The pull request is a draft for the same reason, so the answer is honest
    // rather than a question GitHub would refuse anyway.
    assert.match(session.output, /No merge offered: the tests failed/);
  });

  it('says nothing when there is nothing to merge, or it is already merged', async () => {
    const nothing = delivered(repo.root);
    delete nothing.commit;
    assert.deepEqual(await mergeAvailability(nothing), {});

    const already = delivered(repo.root);
    already.merge = { into: 'main', via: 'pull-request', at: 'x' };
    assert.deepEqual(await mergeAvailability(already), {});

    const session = await offer(['y'], already);
    assert.equal(session.asked.length, 0);
    assert.equal(session.output, '');
  });

  it('never asks when the config turned the question off', async () => {
    const state = delivered(repo.root);
    state.config.workflow.offerMerge = false;

    const session = await offer(['y'], state);
    assert.equal(session.asked.length, 0);
    assert.equal(session.merges, 0);
  });

  it('never asks a terminal nobody is watching, and names the command instead', async () => {
    const session = await offer([], delivered(repo.root), { interactive: false });

    assert.equal(session.asked.length, 0);
    assert.equal(session.merged, false);
    assert.match(session.output, /relay deliver .* --to merge/);
  });
});
