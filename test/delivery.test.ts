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
  mergeBlockers,
  planDelivery,
  reachedPolicy,
  shortfall,
  type DeliveryCapabilities,
} from '../src/workflow/delivery.ts';
import { delivering } from '../src/workflow/phases/delivery.ts';
import { RecordingObserver } from '../src/workflow/observer.ts';
import { pullRequestDraft } from '../src/workflow/publishRun.ts';
import { createRunState, transition, type DeliveryStep, type RunState } from '../src/workflow/state.ts';
import type { IssueProvider } from '../src/github/types.ts';
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

  it('refuses merge without passing test evidence', () => {
    const failed = finishedRun(repo.root);
    failed.tests = { ...failed.tests!, passed: false, exitCode: 1 };
    assert.match(reasonFor(failed, 'merge', capable(), 'merge'), /tests failed/);

    const skipped = finishedRun(repo.root);
    skipped.tests = { ...skipped.tests!, discovered: false, passed: false, skippedReason: '--no-tests' };
    assert.match(reasonFor(skipped, 'merge', capable(), 'merge'), /not verifiably run/);
    assert.match(mergeBlockers(skipped).join(' '), /not verifiably run/);
  });

  it('refuses merge with unresolved blocking findings', () => {
    const state = finishedRun(repo.root);
    state.reviews = [{
      round: 1, kind: 'code', reviewer: 'claude', decision: 'request_changes', at: 'x',
      findings: [{ id: 'F1', severity: 'high', category: 'correctness', summary: 'unsafe', impact: 'BLOCKING' }],
      responses: [{ findingId: 'F1', response: 'REJECT', reasoning: 'not fixed' }],
    }];
    assert.match(reasonFor(state, 'merge', capable(), 'merge'), /blocking review findings remain unresolved/);
  });

  it('refuses protected bases and pull requests not created by the run', () => {
    const protectedState = finishedRun(repo.root);
    assert.match(reasonFor(protectedState, 'merge', capable({ protectedBranches: ['main'] }), 'merge'), /protected branch/);

    const foreign = finishedRun(repo.root);
    foreign.commit = { sha: 'a'.repeat(40), branch: foreign.workspace!.branch, subject: 'x', at: 'x' };
    foreign.push = { remote: 'origin', branch: foreign.workspace!.branch, sha: 'a'.repeat(40), at: 'x' };
    foreign.pullRequest = { url: 'https://github.com/acme/widgets/pull/1', number: 1, base: 'main', head: foreign.workspace!.branch, createdByRun: false, at: 'x' };
    assert.match(reasonFor(foreign, 'merge', capable(), 'merge'), /did not create/);
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
    const worktree = await createWorktree({ repo: info, issue: 13, runShortId });
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

  it('writes the commit message with typos under --tuff, and the trailers without', async () => {
    const { state, store, observer } = await realRun('branch', 'del002');
    state.config.workflow.typos = true;
    // The typos are seeded on the run id, so the test pins one rather than
    // asserting against whichever id this run happened to be given.
    state.runId = '20260812T100000-tuff06';

    await delivering({ state, store, observer, signal: new AbortController().signal });

    const message = await repo.git('log', '-1', '--format=%B', state.workspace!.branch);
    assert.equal(state.commit?.subject, 'Take the serial waitnig out of a run (#13)');
    assert.match(message, /#13/, 'the issue number is not the orchestrator\'s to mistype');
    assert.match(message, /^Issue: https:\/\/x\/13$/m);
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

  it('comments once after a pull request exists and carries the success across re-delivery', async () => {
    const { state, store, observer } = await realRun('branch', 'del009');
    state.config.delivery.comment = true;
    state.pullRequest = {
      url: 'https://github.com/acme/widgets/pull/9',
      number: 9,
      base: 'main',
      head: state.workspace!.branch,
      createdByRun: true,
      at: state.createdAt,
    };
    let calls = 0;
    const provider: IssueProvider = {
      name: 'stub',
      getIssue: async () => { throw new Error('not used'); },
      listIssues: async () => null,
      checkAvailability: async () => ({ available: true, detail: 'available' }),
      comment: async (_ref, body, options) => {
        calls += 1;
        assert.match(body, /pull\/9/);
        assert.ok(body.includes(options?.marker ?? 'missing marker'));
        return { created: true, url: 'https://github.com/acme/widgets/issues/13#issuecomment-1' };
      },
    };

    await delivering({ state, store, observer, issueProvider: provider, signal: new AbortController().signal });
    await delivering({ state, store, observer, issueProvider: provider, signal: new AbortController().signal });

    assert.equal(calls, 1);
    assert.equal(state.delivery?.comment?.status, 'done');
    assert.match(state.delivery?.comment?.url ?? '', /issuecomment-1/);
  });

  it('records why an issue comment was not sent', async () => {
    const run = await realRun('none', 'del010');
    await delivering({ ...run, signal: new AbortController().signal });
    assert.equal(run.state.delivery?.comment?.detail, 'not enabled');

    run.state.config.delivery.comment = true;
    await delivering({ ...run, signal: new AbortController().signal });
    assert.equal(run.state.delivery?.comment?.detail, 'no pull request to link');
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

  it('records post-merge cleanup and does not repeat completed cleanup', async () => {
    await addRemote();
    const { state, store, observer } = await realRun('push', 'clean1');
    await delivering({ state, store, observer, signal: new AbortController().signal });
    const worktreePath = state.workspace!.path;
    const branch = state.workspace!.branch;

    state.pullRequest = {
      url: 'https://github.com/acme/widgets/pull/13', number: 13, base: 'main', head: branch,
      createdByRun: true, at: 'x',
    };
    state.merge = { into: 'main', via: 'pull-request', url: state.pullRequest.url, at: 'x' };
    state.config.github.deleteBranchOnMerge = true;
    state.config.workflow.deliver = 'merge';
    await delivering({ state, store, observer, signal: new AbortController().signal });

    assert.equal(state.delivery?.cleanup?.remoteBranch?.status, 'deleted');
    assert.equal(state.delivery?.cleanup?.worktree?.status, 'removed');
    assert.equal(await repo.git('ls-remote', '--heads', 'origin', branch), '');
    await assert.rejects(() => readFile(join(worktreePath, 'src', 'app.ts')));

    const first = structuredClone(state.delivery.cleanup);
    await delivering({ state, store, observer, signal: new AbortController().signal });
    assert.deepEqual(state.delivery?.cleanup, first);
    assert.deepEqual((await store.loadState()).delivery?.cleanup, first);
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
