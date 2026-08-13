import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { discoverRepository } from '../src/git/repository.ts';
import { createWorktree } from '../src/git/worktree.ts';
import { runProcess } from '../src/process/runner.ts';
import { RunStore } from '../src/storage/runs.ts';
import { DEFAULT_CONFIG, type DeliveryPolicy } from '../src/storage/config.ts';
import { createRunId } from '../src/util/ids.ts';
import {
  draftReasons,
  planDelivery,
  reachedPolicy,
  shortfall,
  type DeliveryCapabilities,
} from '../src/workflow/delivery.ts';
import { delivering } from '../src/workflow/phases/delivery.ts';
import { RecordingObserver } from '../src/workflow/observer.ts';
import { pullRequestDraft } from '../src/workflow/publishRun.ts';
import { createRunState, transition, type DeliveryStep, type RunState } from '../src/workflow/state.ts';
import { createTempRepo, type TempRepo } from './helpers/tempRepo.ts';

let repo: TempRepo;

beforeEach(async () => {
  repo = await createTempRepo();
});

afterEach(async () => {
  delete process.env['RELAY_HOME'];
  await repo.cleanup();
});

/** A finished run holding real work: a branch, a diff, nothing delivered yet. */
function finishedRun(root: string, policy: DeliveryPolicy = 'pr'): RunState {
  const config = structuredClone(DEFAULT_CONFIG);
  config.workflow.deliver = policy;

  const state = createRunState({
    runId: createRunId(new Date('2026-08-12T10:00:00Z')),
    shortId: 'bg6pcf',
    issueRef: '13',
    repository: { root, owner: 'acme', name: 'widgets', defaultBranch: 'main' },
    config,
    now: new Date('2026-08-12T10:00:00Z'),
  });

  state.issue = { number: 13, title: 'Take the serial waiting out of a run', url: 'https://x/13', state: 'open' };
  state.workspace = {
    path: `${root}/worktree`,
    branch: 'relay/13-ce2ubs',
    baseSha: 'b'.repeat(40),
    baseRef: 'refs/heads/main',
    baseBranch: 'main',
  };
  state.diff = {
    fileCount: 3,
    additions: 40,
    deletions: 7,
    files: ['src/a.ts'],
    patchFile: 'patches/final.patch',
    at: '2026-08-12T10:05:00Z',
  };
  state.planApproved = true;
  state.tests = {
    discovered: true,
    command: ['npm', 'test'],
    reason: 'package.json',
    exitCode: 0,
    passed: true,
    durationMs: 12_000,
    timedOut: false,
    at: '2026-08-12T10:04:00Z',
  };
  return state;
}

/** Everything available: a remote, a `gh`, a repository, a clean checkout. */
function capable(overrides: Partial<DeliveryCapabilities> = {}): DeliveryCapabilities {
  return { remote: 'origin', gh: true, repoSlug: 'acme/widgets', merge: { ok: true }, ...overrides };
}

function stepsThatRun(state: RunState, policy: DeliveryPolicy, caps: DeliveryCapabilities): DeliveryStep[] {
  return planDelivery(state, policy, caps)
    .filter((step) => step.run)
    .map((step) => step.step);
}

function reasonFor(state: RunState, policy: DeliveryPolicy, caps: DeliveryCapabilities, step: DeliveryStep): string {
  return planDelivery(state, policy, caps).find((planned) => planned.step === step)?.reason ?? '';
}

describe('delivery plan', () => {
  it('takes the work to a pull request by default, and stops there', () => {
    const state = finishedRun(repo.root);
    assert.deepEqual(stepsThatRun(state, 'pr', capable()), ['commit', 'push', 'pullRequest']);
    assert.match(reasonFor(state, 'pr', capable(), 'merge'), /not requested \(deliver: pr\)/);
  });

  it('reaches exactly as far as each policy allows', () => {
    const state = finishedRun(repo.root);
    assert.deepEqual(stepsThatRun(state, 'none', capable()), []);
    assert.deepEqual(stepsThatRun(state, 'branch', capable()), ['commit']);
    assert.deepEqual(stepsThatRun(state, 'push', capable()), ['commit', 'push']);
    assert.deepEqual(stepsThatRun(state, 'merge', capable()), ['commit', 'push', 'pullRequest', 'merge']);
  });

  it('stops at the first thing the world will not allow, and says why downstream', () => {
    const state = finishedRun(repo.root);
    const noRemote = capable({ remote: null });

    assert.deepEqual(stepsThatRun(state, 'pr', noRemote), ['commit']);
    assert.match(reasonFor(state, 'pr', noRemote, 'push'), /no `origin` remote/);
    // The pull request inherits the push's reason rather than inventing one.
    assert.match(reasonFor(state, 'pr', noRemote, 'pullRequest'), /no push: this repository has no `origin` remote/);
  });

  it('will not open a pull request without the CLI that owns the credentials', () => {
    const state = finishedRun(repo.root);
    const caps = capable({ gh: false });

    assert.deepEqual(stepsThatRun(state, 'pr', caps), ['commit', 'push']);
    assert.match(reasonFor(state, 'pr', caps, 'pullRequest'), /GitHub CLI is not installed/);
  });

  it('merges through the pull request when there is one, and never touches the checkout', () => {
    const state = finishedRun(repo.root);
    // A checkout sitting on another branch blocks a *local* merge only: with a
    // remote and a `gh`, the merge happens on GitHub.
    const elsewhere = capable({ merge: { ok: false, reason: 'your checkout is on brisbane, not main' } });
    assert.deepEqual(stepsThatRun(state, 'merge', elsewhere), ['commit', 'push', 'pullRequest', 'merge']);

    // Without a remote there is no pull request to merge, so the merge happens
    // here — and then the checkout matters again.
    const local = capable({ remote: null, gh: false, merge: { ok: true } });
    assert.deepEqual(stepsThatRun(state, 'merge', local), ['commit', 'merge']);

    const dirty = capable({ remote: null, gh: false, merge: { ok: false, reason: 'your checkout is on brisbane' } });
    assert.deepEqual(stepsThatRun(state, 'merge', dirty), ['commit']);
    assert.match(reasonFor(state, 'merge', dirty, 'merge'), /your checkout is on brisbane/);
  });

  it('skips what is already done rather than doing it twice', () => {
    const state = finishedRun(repo.root);
    state.commit = { sha: 'a'.repeat(40), branch: 'relay/13-ce2ubs', subject: 'x', at: 'x' };
    state.push = { remote: 'origin', branch: 'relay/13-ce2ubs', sha: 'a'.repeat(40), at: 'x' };

    assert.deepEqual(stepsThatRun(state, 'pr', capable()), ['pullRequest']);
    assert.match(reasonFor(state, 'pr', capable(), 'commit'), /already committed as aaaaaaaa/);
    assert.match(reasonFor(state, 'pr', capable(), 'push'), /already pushed to origin/);
    // Which is what makes re-running delivery safe, and `relay deliver` useful.
    assert.equal(reachedPolicy(state), 'push');
  });

  it('delivers nothing for a run that produced nothing', () => {
    const state = finishedRun(repo.root);
    delete state.diff;

    assert.deepEqual(stepsThatRun(state, 'pr', capable()), []);
    assert.match(reasonFor(state, 'pr', capable(), 'commit'), /changed no files/);
  });
});

describe('draft pull requests', () => {
  it('opens normally when the run\'s own evidence is clean', () => {
    assert.deepEqual(draftReasons(finishedRun(repo.root)), []);
    assert.equal(pullRequestDraft(finishedRun(repo.root)).draft, undefined);
  });

  it('opens as a draft when the tests failed', () => {
    const state = finishedRun(repo.root);
    state.tests = { ...state.tests!, passed: false, exitCode: 1 };

    assert.deepEqual(draftReasons(state), ['the tests failed']);
    const draft = pullRequestDraft(state);
    assert.equal(draft.draft, true);
    assert.match(draft.body, /Opened as a draft:\*\* the tests failed/);
  });

  it('opens as a draft when blocking findings were never accepted', () => {
    const state = finishedRun(repo.root);
    state.reviews = [
      {
        round: 1,
        kind: 'code',
        reviewer: 'claude',
        decision: 'request_changes',
        findings: [
          { id: 'F1', severity: 'critical', category: 'correctness', summary: 'races on the index', impact: 'BLOCKING' },
        ],
        responses: [{ findingId: 'F1', response: 'REJECT', reasoning: 'disagree' }],
        at: 'x',
      },
    ];

    assert.match(draftReasons(state).join(' '), /1 blocking review finding\(s\) were never accepted/);
    assert.equal(pullRequestDraft(state).draft, true);
  });

  it('opens as a draft when the plan was never approved', () => {
    const state = finishedRun(repo.root);
    state.planApproved = false;

    assert.match(draftReasons(state).join(' '), /plan was never approved/);
  });
});

/**
 * The phase itself, against real git and a real remote. The plan tests above
 * cover what it decides; this covers what actually moves when it runs.
 */
describe('the delivery phase', () => {
  async function realRun(
    policy: DeliveryPolicy,
    runShortId = 'del001',
  ): Promise<{ state: RunState; store: RunStore; observer: RecordingObserver }> {
    process.env['RELAY_HOME'] = repo.relayHome;
    const info = await discoverRepository(repo.root);
    const worktree = await createWorktree({ repo: info, issueNumber: 13, runShortId });
    await writeFile(join(worktree.path, 'src', 'app.ts'), 'export const value = 13;\n', 'utf8');

    const state = finishedRun(repo.root, policy);
    state.workspace = worktree;
    for (const phase of [
      'FETCHING_ISSUE',
      'CREATING_WORKSPACE',
      'PLANNING',
      'REVIEWING_PLAN',
      'IMPLEMENTING',
      'REVIEWING_CODE',
      'TESTING',
      'DELIVERING',
    ] as const) {
      transition(state, phase);
    }

    const store = new RunStore(repo.root, state.runId);
    await store.init();
    return { state, store, observer: new RecordingObserver() };
  }

  async function addRemote(): Promise<void> {
    const origin = join(repo.relayHome, 'origin.git');
    await mkdir(origin, { recursive: true });
    await runProcess('git', ['init', '--bare', '-q', '-b', 'main', origin], { cwd: repo.root });
    await repo.git('remote', 'add', 'origin', origin);
    await repo.git('push', '-q', 'origin', 'main');
  }

  it('commits and pushes on its own, and records every step', async () => {
    process.env['RELAY_HOME'] = repo.relayHome;
    await addRemote();
    const { state, store, observer } = await realRun('push');

    const result = await delivering({ state, store, observer, signal: new AbortController().signal });

    assert.equal(result.next, 'COMPLETE');
    assert.equal(state.delivery?.reached, 'push');
    assert.deepEqual(
      state.delivery?.steps.map((step) => `${step.step}:${step.status}`),
      ['commit:done', 'push:done', 'pullRequest:skipped', 'merge:skipped'],
    );

    // The branch really is on the remote, at the commit delivery made.
    assert.match(await repo.git('ls-remote', '--heads', 'origin', state.workspace!.branch), new RegExp(state.push!.sha));
    assert.equal(state.push?.sha, state.commit?.sha);

    // …and the record survives the process that made it.
    assert.equal((await store.loadState()).push?.remote, 'origin');
    assert.match((await store.readArtifact('summary.md')) ?? '', /## Delivery/);
  });

  it('stops at the commit when there is nowhere to push, and says so out loud', async () => {
    const { state, store, observer } = await realRun('pr');

    await delivering({ state, store, observer, signal: new AbortController().signal });

    assert.equal(state.delivery?.reached, 'branch');
    assert.equal(state.commit?.branch, state.workspace!.branch);
    assert.equal(state.push, undefined);
    // A shortfall nobody mentions is the failure mode of anything autonomous.
    assert.match(observer.warnings.join(' '), /No push: this repository has no `origin` remote/);
  });

  it('names the one step that explains a shortfall, and nothing else', async () => {
    const { state, store, observer } = await realRun('pr');
    await delivering({ state, store, observer, signal: new AbortController().signal });

    const blocked = shortfall(state.delivery);
    assert.equal(blocked?.step, 'push');
    assert.match(blocked?.detail ?? '', /no `origin` remote/);

    // A run that got everywhere it was asked to has no shortfall to report.
    const done = await realRun('branch', 'del002');
    await delivering({ ...done, signal: new AbortController().signal });
    assert.equal(shortfall(done.state.delivery), undefined);
  });

  it('leaves the work alone when delivery is off', async () => {
    const { state, store, observer } = await realRun('none');

    await delivering({ state, store, observer, signal: new AbortController().signal });

    assert.equal(state.commit, undefined);
    assert.equal(state.delivery?.reached, 'none');
    assert.deepEqual(
      state.delivery?.steps.map((step) => step.detail),
      Array(4).fill('not requested (deliver: none)'),
    );
  });

  it('is idempotent, so running it again picks up where it stopped', async () => {
    const { state, store, observer } = await realRun('push');

    // First pass: no remote, so it commits and stops.
    await delivering({ state, store, observer, signal: new AbortController().signal });
    assert.equal(state.delivery?.reached, 'branch');
    const committed = state.commit?.sha;

    // The remote appears, and the second pass does only what is left.
    await addRemote();
    await delivering({ state, store, observer, signal: new AbortController().signal });

    assert.equal(state.delivery?.reached, 'push');
    assert.equal(state.commit?.sha, committed, 'the work was not committed twice');
    assert.equal(state.delivery?.steps.find((step) => step.step === 'commit')?.status, 'skipped');
    assert.match(state.delivery?.steps.find((step) => step.step === 'commit')?.detail ?? '', /already committed/);
  });

  it('merges into the base branch itself when there is no remote to merge through', async () => {
    const { state, store, observer } = await realRun('merge');

    await delivering({ state, store, observer, signal: new AbortController().signal });

    assert.equal(state.merge?.via, 'local');
    assert.equal(state.merge?.into, 'main');
    assert.match(await readFile(join(repo.root, 'src', 'app.ts'), 'utf8'), /13/);
    assert.equal(state.delivery?.reached, 'merge');
  });
});
