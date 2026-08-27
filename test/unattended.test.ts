import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { lastLabelActor } from '../src/github/provider.ts';
import type { Issue, IssueProvider, IssueSummary } from '../src/github/types.ts';
import { DEFAULT_CONFIG, mergeConfig, type RelayConfig } from '../src/storage/config.ts';
import { RelayError } from '../src/util/errors.ts';
import { budgetAllows, dailySpend } from '../src/unattended/budget.ts';
import { killSwitch, stopFilePath } from '../src/unattended/killSwitch.ts';
import { claimIssue, loadLedger, releaseClaim } from '../src/unattended/ledger.ts';
import {
  applyUnattendedPolicy,
  assertUnattendedReady,
  decideTrigger,
  triggerLabelOf,
  unattendedOf,
} from '../src/unattended/policy.ts';
import { serve, type ServeDeps, type ServeEvent, type ServeStart } from '../src/unattended/serve.ts';
import { draftReasons, planDelivery, type DeliveryCapabilities } from '../src/workflow/delivery.ts';
import { createRunState, type RunState } from '../src/workflow/state.ts';
import { repositoryStats } from '../src/workflow/stats.ts';
import { statsToJson } from '../src/cli/commands/stats.ts';
import { serveToJson } from '../src/cli/commands/serve.ts';
import { executeRun } from '../src/cli/commands/run.ts';
import { discoverRepository } from '../src/git/repository.ts';
import { writesFile } from './helpers/engine.ts';
import { approveReview, FakeAgentHarness, planText, section } from './helpers/fakeHarness.ts';
import { createTempRepo, FakeIssueProvider, type TempRepo } from './helpers/tempRepo.ts';
import { buildProgram } from '../src/cli/program.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'relay-unattended-'));
  await mkdir(join(root, '.relay'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A config with every guardrail answered, which is the only kind that serves. */
function readyConfig(overrides: Partial<RelayConfig['unattended']> = {}): RelayConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.workflow.triggerLabel = 'relay:go';
  config.unattended = {
    ...config.unattended,
    enabled: true,
    authors: ['maintainer'],
    maxRunCostUsd: 2,
    maxDailyCostUsd: 10,
    pollSeconds: 5,
    ...overrides,
  };
  return config;
}

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'github:acme/widgets#142',
    number: 142,
    title: 'Rate limit the login endpoint',
    body: 'Please.',
    url: 'https://github.com/acme/widgets/issues/142',
    state: 'open',
    author: 'reporter',
    labels: ['relay:go'],
    repository: { owner: 'acme', name: 'widgets' },
    comments: [],
    ...overrides,
  };
}

describe('the unattended configuration', () => {
  it('ships closed: nothing enabled, nobody allowed, no budget', () => {
    const shipped = DEFAULT_CONFIG.unattended;
    assert.equal(shipped.enabled, false);
    assert.deepEqual(shipped.authors, []);
    assert.deepEqual(shipped.teams, []);
    assert.equal(shipped.maxRunCostUsd, null);
    assert.equal(shipped.maxDailyCostUsd, null);
  });

  it('refuses `merge` by name, because that is the rule and not a typo', () => {
    assert.throws(
      () => mergeConfig(DEFAULT_CONFIG, { unattended: { deliver: 'merge' } }),
      (error: unknown) => error instanceof RelayError && /never merges/.test(error.message),
    );
  });

  it('accepts every policy below a pull request', () => {
    for (const deliver of ['none', 'branch', 'push', 'pr']) {
      assert.equal(mergeConfig(DEFAULT_CONFIG, { unattended: { deliver } }).unattended.deliver, deliver);
    }
  });

  it('requires teams to name an organisation, so an allowlist cannot widen by guess', () => {
    assert.throws(
      () => mergeConfig(DEFAULT_CONFIG, { unattended: { teams: ['reviewers'] } }),
      (error: unknown) => error instanceof RelayError && /org\/team/.test(error.message),
    );
    assert.deepEqual(
      mergeConfig(DEFAULT_CONFIG, { unattended: { teams: ['acme/reviewers'] } }).unattended.teams,
      ['acme/reviewers'],
    );
  });

  it('reads the trigger label off workflow, trimmed', () => {
    const config = mergeConfig(DEFAULT_CONFIG, { workflow: { triggerLabel: '  relay:go  ' } });
    assert.equal(triggerLabelOf(config), 'relay:go');
  });

  it('defaults the block for a snapshot written before it existed', () => {
    const old = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>;
    delete old['unattended'];
    assert.equal(unattendedOf(old as unknown as RelayConfig).enabled, false);
  });
});

describe('starting a server at all', () => {
  it('refuses each missing guardrail by name', () => {
    const cases: Array<[Partial<RelayConfig['unattended']>, RegExp]> = [
      [{ enabled: false }, /switched off/],
      [{ authors: [], teams: [] }, /allowlist is empty/],
      [{ maxRunCostUsd: null }, /per-run budget/],
      [{ maxDailyCostUsd: null }, /daily budget/],
      [{ maxRunCostUsd: 50 }, /above unattended.maxDailyCostUsd/],
    ];
    for (const [overrides, pattern] of cases) {
      assert.throws(
        () => assertUnattendedReady(readyConfig(overrides)),
        (error: unknown) => error instanceof RelayError && pattern.test(error.message),
        `accepted ${JSON.stringify(overrides)}`,
      );
    }
  });

  it('refuses a repository with no trigger label configured', () => {
    const config = readyConfig();
    config.workflow.triggerLabel = '';
    assert.throws(() => assertUnattendedReady(config), /No trigger label/);
  });

  it('accepts a repository that answered all of them', () => {
    assert.doesNotThrow(() => assertUnattendedReady(readyConfig()));
  });
});

describe('the ceiling on an unattended run', () => {
  it('caps delivery at a pull request even when the repository says merge', () => {
    const config = readyConfig();
    config.workflow.deliver = 'merge';
    config.github.autoMerge = true;
    const capped = applyUnattendedPolicy(config);
    assert.equal(capped.workflow.deliver, 'pr');
    assert.equal(capped.github.autoMerge, false);
  });

  it('keeps a lower ceiling the repository chose for itself', () => {
    const config = readyConfig({ deliver: 'pr' });
    config.workflow.deliver = 'branch';
    assert.equal(applyUnattendedPolicy(config).workflow.deliver, 'branch');
  });

  it('turns off the one question, because there is nobody to ask', () => {
    assert.equal(applyUnattendedPolicy(readyConfig()).workflow.offerMerge, false);
    assert.equal(applyUnattendedPolicy(readyConfig()).workflow.confirmAboveUsd, null);
  });

  it('applies the tighter of the two per-run budgets', () => {
    const config = readyConfig({ maxRunCostUsd: 2 });
    assert.equal(applyUnattendedPolicy(config).workflow.maxCostUsd, 2);
    config.workflow.maxCostUsd = 0.5;
    assert.equal(applyUnattendedPolicy(config).workflow.maxCostUsd, 0.5);
  });

  it('reports back on the issue, since nobody is watching the terminal', () => {
    assert.equal(applyUnattendedPolicy(readyConfig()).delivery.comment, true);
  });

  it('leaves the repository config alone', () => {
    const config = readyConfig();
    config.workflow.deliver = 'merge';
    applyUnattendedPolicy(config);
    assert.equal(config.workflow.deliver, 'merge');
  });
});

describe('who is allowed to start a run', () => {
  const settings = (overrides: Partial<RelayConfig['unattended']> = {}) => unattendedOf(readyConfig(overrides));

  it('allows a login on the allowlist', async () => {
    const decision = await decideTrigger(settings(), { issue: issue(), label: 'relay:go', labelActor: 'maintainer' });
    assert.equal(decision.allowed, true);
    assert.equal(decision.actor, 'maintainer');
  });

  it('ignores an issue labelled by somebody outside it, and says who', async () => {
    const decision = await decideTrigger(settings(), { issue: issue(), label: 'relay:go', labelActor: 'stranger' });
    assert.equal(decision.allowed, false);
    assert.equal(decision.actor, 'stranger');
    assert.match(decision.reason, /stranger labelled #142 with relay:go but is not on the allowlist/);
  });

  it('judges the labeller, not the author — the labeller is who spent the money', async () => {
    const decision = await decideTrigger(settings(), {
      issue: issue({ author: 'maintainer' }),
      label: 'relay:go',
      labelActor: 'stranger',
    });
    assert.equal(decision.allowed, false);
  });

  it('falls back to the author only when the tracker records no labelling at all', async () => {
    const decision = await decideTrigger(settings(), {
      issue: issue({ author: 'maintainer' }),
      label: 'relay:go',
      labelActor: null,
    });
    assert.equal(decision.allowed, true);
  });

  it('refuses when nobody can be named, rather than letting anyone through', async () => {
    const decision = await decideTrigger(settings(), {
      issue: issue({ author: null }),
      label: 'relay:go',
      labelActor: null,
    });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /will not say who applied/);
  });

  it('allows a team member and records which team let them in', async () => {
    const decision = await decideTrigger(settings({ authors: [], teams: ['acme/reviewers'] }), {
      issue: issue(),
      label: 'relay:go',
      labelActor: 'colleague',
      teamMembership: async (login, teams) => (login === 'colleague' ? (teams[0] ?? null) : null),
    });
    assert.equal(decision.allowed, true);
    assert.equal(decision.team, 'acme/reviewers');
  });

  it('refuses a closed issue and an issue that lost the label', async () => {
    const closed = await decideTrigger(settings(), {
      issue: issue({ state: 'closed' }),
      label: 'relay:go',
      labelActor: 'maintainer',
    });
    assert.equal(closed.allowed, false);
    const unlabelled = await decideTrigger(settings(), {
      issue: issue({ labels: [] }),
      label: 'relay:go',
      labelActor: 'maintainer',
    });
    assert.equal(unlabelled.allowed, false);
  });
});

describe('the daily budget', () => {
  const runAt = (at: string, costUsd?: number, unattended = true): RunState => {
    const state = createRunState({
      runId: `${at.replace(/[-:]/g, '').replace(/\..*/, '')}-aaaaaa`,
      shortId: 'aaaaaa',
      issueRef: '1',
      repository: { root, owner: 'acme', name: 'widgets', defaultBranch: 'main' },
      config: structuredClone(DEFAULT_CONFIG),
      now: new Date(at),
      ...(unattended ? { trigger: { source: 'serve' as const, label: 'relay:go', actor: 'maintainer', at } } : {}),
    });
    if (costUsd !== undefined) {
      state.usage = {
        total: { inputTokens: 10, outputTokens: 10, costUsd, turns: 2, pricedTurns: 1 },
        byPhase: {},
      };
    }
    return state;
  };

  it('counts only what started without a person, and only today', () => {
    const now = new Date('2026-08-25T12:00:00Z');
    const spend = dailySpend(
      [
        runAt('2026-08-25T09:00:00Z', 3),
        runAt('2026-08-24T09:00:00Z', 40),
        runAt('2026-08-25T10:00:00Z', 5, false),
      ],
      now,
    );
    assert.equal(spend.day, '2026-08-25');
    assert.equal(spend.runs, 1);
    assert.equal(spend.spentUsd, 3);
    assert.equal(spend.unpriced, 1);
  });

  it('reserves the per-run cap for every run in flight before starting another', () => {
    const spend = { day: '2026-08-25', spentUsd: 4, unpriced: 0, runs: 2 };
    assert.equal(budgetAllows({ spend, inFlight: 0, maxRunCostUsd: 2, maxDailyCostUsd: 10 }).ok, true);
    // 4 spent + 2 held for the run in flight + 2 for the next = 8, still inside.
    assert.equal(budgetAllows({ spend, inFlight: 1, maxRunCostUsd: 2, maxDailyCostUsd: 10 }).ok, true);
    // 4 + 6 + 2 = 12, which is past the day.
    assert.equal(budgetAllows({ spend, inFlight: 3, maxRunCostUsd: 2, maxDailyCostUsd: 10 }).ok, false);
  });

  it('says how much of the day is gone when it refuses', () => {
    const verdict = budgetAllows({
      spend: { day: '2026-08-25', spentUsd: 9.5, unpriced: 3, runs: 5 },
      inFlight: 0,
      maxRunCostUsd: 2,
      maxDailyCostUsd: 10,
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /daily budget reached/);
    assert.match(verdict.detail, /\$9\.50 spent today across 5 unattended run\(s\)/);
    assert.match(verdict.detail, /3 turn\(s\) reported no price/);
  });
});

describe('the kill switch', () => {
  it('is engaged by the file, and says which file', async () => {
    await writeFile(stopFilePath(root), 'deploy freeze\n', 'utf8');
    const state = await killSwitch(root, readyConfig());
    assert.equal(state.engaged, true);
    assert.match(state.reason ?? '', /\.relay\/STOP is present: deploy freeze/);
  });

  it('is engaged by the config flag', async () => {
    const state = await killSwitch(root, readyConfig({ enabled: false }));
    assert.equal(state.engaged, true);
    assert.match(state.reason ?? '', /unattended\.enabled is false/);
  });

  it('is not engaged by an ordinary repository', async () => {
    assert.equal((await killSwitch(root, readyConfig())).engaged, false);
  });
});

describe('the claim ledger', () => {
  const claim = { issueId: 'github:acme/widgets#142', issueRef: '142', runId: 'r1', label: 'relay:go', actor: 'maintainer', at: '2026-08-25T09:00:00Z' };

  it('claims an issue once and refuses the second claim', async () => {
    assert.equal((await claimIssue(root, claim)).claimed, true);
    const second = await claimIssue(root, { ...claim, runId: 'r2' });
    assert.equal(second.claimed, false);
    assert.equal(second.existing?.runId, 'r1');
  });

  it('survives a restart, so the same work is not started twice', async () => {
    await claimIssue(root, claim);
    assert.equal(loadLedger(root) instanceof Promise, true);
    assert.equal((await loadLedger(root)).claims[0]?.runId, 'r1');
  });

  it('releases a claim whose run never started', async () => {
    await claimIssue(root, claim);
    await releaseClaim(root, claim.issueId);
    assert.deepEqual((await loadLedger(root)).claims, []);
  });

  it('reads an absent or corrupt ledger as empty rather than failing', async () => {
    assert.deepEqual((await loadLedger(root)).claims, []);
    await writeFile(join(root, '.relay', 'unattended.json'), '{ not json', 'utf8');
    assert.deepEqual((await loadLedger(root)).claims, []);
  });
});

/** A tracker that answers from memory and records what was asked of it. */
class FakeTracker implements IssueProvider {
  readonly name = 'fake';
  readonly removed: string[] = [];
  readonly issues = new Map<string, Issue>();
  actors = new Map<string, string | null>();
  labelRemovalFails = false;

  constructor(issues: Issue[]) {
    for (const entry of issues) this.issues.set(String(entry.number), entry);
  }

  async getIssue(ref: string): Promise<Issue> {
    const found = this.issues.get(ref);
    if (found === undefined) throw new RelayError(`no such issue ${ref}`, { code: 'ISSUE_NOT_FOUND' });
    return found;
  }

  async listIssues(filters: { labels?: string[] }): Promise<IssueSummary[]> {
    const label = filters.labels?.[0];
    return [...this.issues.values()]
      .filter((entry) => label === undefined || entry.labels.includes(label))
      .map((entry) => ({
        number: entry.number ?? 0,
        title: entry.title,
        labels: entry.labels,
        createdAt: '',
        url: entry.url,
        author: entry.author,
        state: entry.state,
      }));
  }

  async removeLabel(ref: string, label: string): Promise<boolean> {
    if (this.labelRemovalFails) throw new RelayError('gh said no', { code: 'GH_FAILED' });
    const found = this.issues.get(ref);
    if (found === undefined || !found.labels.includes(label)) return false;
    found.labels = found.labels.filter((name) => name !== label);
    this.removed.push(`${ref}:${label}`);
    return true;
  }

  async labelActor(ref: string): Promise<string | null> {
    return this.actors.get(ref) ?? null;
  }

  async checkAvailability(): Promise<{ available: boolean; detail: string }> {
    return { available: true, detail: 'fake' };
  }
}

interface ServeHarness {
  events: ServeEvent[];
  starts: ServeStart[];
  deps: ServeDeps;
  controller: AbortController;
}

function harness(
  tracker: FakeTracker,
  overrides: Partial<ServeDeps> = {},
  config: RelayConfig = readyConfig(),
): ServeHarness {
  const events: ServeEvent[] = [];
  const starts: ServeStart[] = [];
  const controller = new AbortController();
  let counter = 0;
  const deps: ServeDeps = {
    repoRoot: root,
    provider: tracker,
    loadConfig: async () => config,
    listRuns: async () => [],
    createRunId: () => `20260825T12000${(counter += 1)}-serve${counter}`,
    startRun: async (start) => {
      starts.push(start);
      return 0;
    },
    log: (event) => events.push(event),
    sleep: async () => undefined,
    signal: controller.signal,
    source: 'serve',
    maxPasses: 1,
    now: () => new Date('2026-08-25T12:00:00Z'),
    ...overrides,
  };
  return { events, starts, deps, controller };
}

describe('serve', () => {
  it('starts a run per labelled issue and takes the label off first', async () => {
    const tracker = new FakeTracker([issue(), issue({ id: 'github:acme/widgets#143', number: 143 })]);
    tracker.actors.set('142', 'maintainer');
    tracker.actors.set('143', 'maintainer');
    const { deps, starts, events } = harness(tracker, {}, readyConfig());
    // Two at once, so both are started in the same pass.
    const config = readyConfig();
    config.workflow.maxConcurrentRuns = 2;
    const outcome = await serve({ ...deps, loadConfig: async () => config });

    assert.equal(outcome.started.length, 2);
    assert.deepEqual(tracker.removed, ['142:relay:go', '143:relay:go']);
    assert.equal(starts.length, 2);
    // The label came off before the run was handed over.
    assert.deepEqual(tracker.issues.get('142')?.labels, []);
    assert.equal(events.filter((event) => event.type === 'claimed').length, 2);
  });

  it('hands each run a trigger record naming who asked', async () => {
    const tracker = new FakeTracker([issue()]);
    tracker.actors.set('142', 'maintainer');
    const { deps, starts } = harness(tracker);
    await serve(deps);
    assert.deepEqual(starts[0]?.trigger, {
      source: 'serve',
      label: 'relay:go',
      actor: 'maintainer',
      at: '2026-08-25T12:00:00.000Z',
    });
  });

  it('ignores an issue labelled by someone outside the allowlist, with a log line', async () => {
    const tracker = new FakeTracker([issue()]);
    tracker.actors.set('142', 'stranger');
    const { deps, starts, events } = harness(tracker);
    const outcome = await serve(deps);

    assert.deepEqual(outcome.started, []);
    assert.equal(starts.length, 0);
    const skipped = events.find((event) => event.type === 'skipped');
    assert.ok(skipped && skipped.type === 'skipped');
    assert.match(skipped.reason, /not on the allowlist/);
    assert.equal(skipped.actor, 'stranger');
    // The label stays on, so the refusal is visible on the issue itself.
    assert.deepEqual(tracker.issues.get('142')?.labels, ['relay:go']);
    assert.deepEqual(tracker.removed, []);
  });

  it('never exceeds the concurrency limit, and leaves the rest labelled', async () => {
    const tracker = new FakeTracker([
      issue(),
      issue({ id: 'github:acme/widgets#143', number: 143 }),
      issue({ id: 'github:acme/widgets#144', number: 144 }),
    ]);
    for (const ref of ['142', '143', '144']) tracker.actors.set(ref, 'maintainer');
    let peak = 0;
    let active = 0;
    const { deps, events } = harness(tracker, {
      startRun: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active -= 1;
        return 0;
      },
    });
    const outcome = await serve(deps);

    assert.equal(peak, 1, 'started more than maxConcurrentRuns at once');
    assert.equal(outcome.started.length, 1);
    assert.ok(events.some((event) => event.type === 'deferred'));
    assert.deepEqual(tracker.issues.get('143')?.labels, ['relay:go']);
  });

  it('stops starting runs when the day is spent, loudly and without queueing', async () => {
    const tracker = new FakeTracker([issue()]);
    tracker.actors.set('142', 'maintainer');
    const spent: RunState = createRunState({
      runId: '20260825T090000-spenta',
      shortId: 'spenta',
      issueRef: '9',
      repository: { root, owner: 'acme', name: 'widgets', defaultBranch: 'main' },
      config: structuredClone(DEFAULT_CONFIG),
      now: new Date('2026-08-25T09:00:00Z'),
      trigger: { source: 'serve', label: 'relay:go', actor: 'maintainer', at: '2026-08-25T09:00:00Z' },
    });
    spent.usage = { total: { inputTokens: 1, outputTokens: 1, costUsd: 9.5, turns: 1, pricedTurns: 1 }, byPhase: {} };

    const { deps, starts, events } = harness(tracker, { listRuns: async () => [spent] });
    const outcome = await serve(deps);

    assert.equal(outcome.stoppedBy, 'budget');
    assert.equal(starts.length, 0);
    assert.ok(events.some((event) => event.type === 'budget'));
    // Nothing was queued and nothing was claimed: the label is still asking.
    assert.deepEqual(tracker.issues.get('142')?.labels, ['relay:go']);
  });

  it('starts nothing when the kill switch is engaged, and lets in-flight runs finish', async () => {
    const tracker = new FakeTracker([issue(), issue({ id: 'github:acme/widgets#143', number: 143 })]);
    tracker.actors.set('142', 'maintainer');
    tracker.actors.set('143', 'maintainer');
    let finished = false;
    const { deps, starts } = harness(tracker, {
      maxPasses: 5,
      startRun: async (start) => {
        starts.push(start);
        // Engaged while this run is in flight, synchronously so the next pass
        // cannot race it: the loop must stop starting and must not touch this.
        writeFileSync(stopFilePath(root), 'stop\n', 'utf8');
        await new Promise((resolve) => setTimeout(resolve, 30));
        finished = true;
        return 0;
      },
    });

    const outcome = await serve(deps);
    assert.equal(outcome.stoppedBy, 'kill-switch');
    assert.equal(starts.length, 1, 'started something after the switch was thrown');
    assert.equal(finished, true, 'the in-flight run was cut short');
    // #143 still carries the label: stopping means starting nothing more.
    assert.deepEqual(tracker.issues.get('143')?.labels, ['relay:go']);
  });

  it('does not re-run work after a restart, because the claim is on disk', async () => {
    const tracker = new FakeTracker([issue()]);
    tracker.actors.set('142', 'maintainer');
    await serve(harness(tracker).deps);
    // Somebody labels it again while the first run is still going.
    tracker.issues.get('142')!.labels = ['relay:go'];
    const second = harness(tracker);
    const outcome = await serve(second.deps);

    assert.deepEqual(outcome.started, []);
    const skipped = second.events.find((event) => event.type === 'skipped');
    assert.ok(skipped && skipped.type === 'skipped');
    assert.match(skipped.reason, /already started as /);
  });

  it('gives the claim back when the label will not come off', async () => {
    const tracker = new FakeTracker([issue()]);
    tracker.actors.set('142', 'maintainer');
    tracker.labelRemovalFails = true;
    const { deps, starts, events } = harness(tracker);
    await serve(deps);

    assert.equal(starts.length, 0);
    assert.deepEqual((await loadLedger(root)).claims, []);
    assert.ok(events.some((event) => event.type === 'error'));
  });

  it('decides everything and starts nothing on a dry run', async () => {
    const tracker = new FakeTracker([issue()]);
    tracker.actors.set('142', 'maintainer');
    const { deps, starts, events } = harness(tracker, { dryRun: true });
    await serve(deps);

    assert.equal(starts.length, 0);
    assert.deepEqual(tracker.removed, []);
    assert.deepEqual((await loadLedger(root)).claims, []);
    const claimed = events.find((event) => event.type === 'claimed');
    assert.ok(claimed && claimed.type === 'claimed' && claimed.dryRun);
  });

  it('looks at one issue only when the Action names one', async () => {
    const tracker = new FakeTracker([issue(), issue({ id: 'github:acme/widgets#143', number: 143 })]);
    tracker.actors.set('142', 'maintainer');
    tracker.actors.set('143', 'maintainer');
    const { deps, starts } = harness(tracker, { only: '143', source: 'action' });
    await serve(deps);

    assert.equal(starts.length, 1);
    assert.equal(starts[0]?.issue.number, 143);
    assert.equal(starts[0]?.trigger.source, 'action');
  });

  it('keeps watching when the tracker is briefly unreachable', async () => {
    const tracker = new FakeTracker([]);
    const { deps, events } = harness(tracker, {
      maxPasses: 2,
      provider: {
        ...tracker,
        name: 'fake',
        listIssues: async () => {
          throw new Error('connection reset');
        },
        getIssue: (ref: string) => tracker.getIssue(ref),
        checkAvailability: () => tracker.checkAvailability(),
      } as IssueProvider,
    });
    const outcome = await serve(deps);
    assert.equal(outcome.stoppedBy, 'once');
    assert.equal(events.filter((event) => event.type === 'error').length, 2);
  });

  it('hands the run a config already capped at a pull request', async () => {
    const tracker = new FakeTracker([issue()]);
    tracker.actors.set('142', 'maintainer');
    const config = readyConfig();
    config.workflow.deliver = 'merge';
    const { deps, starts } = harness(tracker, {}, config);
    await serve({ ...deps, loadConfig: async () => config });
    assert.equal(starts[0]?.config.workflow.deliver, 'pr');
    assert.equal(starts[0]?.config.workflow.offerMerge, false);
  });
});

describe('what an unattended run may deliver', () => {
  const unattendedRun = (): RunState => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.workflow.deliver = 'merge';
    const state = createRunState({
      runId: '20260825T120000-abcdef',
      shortId: 'abcdef',
      issueRef: '142',
      repository: { root, owner: 'acme', name: 'widgets', defaultBranch: 'main' },
      config,
      trigger: { source: 'serve', label: 'relay:go', actor: 'maintainer', at: '2026-08-25T12:00:00Z' },
    });
    state.workspace = {
      path: join(root, 'worktree'),
      branch: 'relay/142-abcdef',
      baseSha: 'b'.repeat(40),
      baseRef: 'refs/heads/main',
      baseBranch: 'main',
    };
    state.diff = { fileCount: 1, additions: 3, deletions: 0, files: ['a.ts'], patchFile: 'patches/x.patch', at: '' };
    state.commit = { sha: 'c'.repeat(40), branch: 'relay/142-abcdef', subject: 'work', at: '' };
    state.push = { remote: 'origin', branch: 'relay/142-abcdef', sha: 'c'.repeat(40), at: '' };
    state.pullRequest = { url: 'https://github.com/acme/widgets/pull/9', number: 9, base: 'main', head: 'relay/142-abcdef', createdByRun: true, at: '' };
    state.planApproved = true;
    state.tests = { discovered: true, command: ['npm', 'test'], reason: 'npm', exitCode: 0, passed: true, durationMs: 1, timedOut: false, at: '' };
    return state;
  };

  const caps: DeliveryCapabilities = {
    remote: 'origin',
    gh: true,
    repoSlug: 'acme/widgets',
    merge: { ok: true },
  };

  it('refuses the merge at the last gate, even asked for one directly', () => {
    const plan = planDelivery(unattendedRun(), 'merge', caps);
    const merge = plan.find((step) => step.step === 'merge');
    assert.equal(merge?.run, false);
    assert.match(merge?.reason ?? '', /started unattended \(relay:go\), and unattended runs never merge/);
  });

  it('still lets it commit, push and open the pull request', () => {
    const state = unattendedRun();
    delete state.push;
    delete state.pullRequest;
    const plan = planDelivery(state, 'merge', caps);
    assert.equal(plan.find((step) => step.step === 'push')?.run, true);
    assert.equal(plan.find((step) => step.step === 'pullRequest')?.run, true);
  });

  it('opens the pull request as a draft, because nobody has looked at it', () => {
    const reasons = draftReasons(unattendedRun());
    assert.match(reasons.join(' '), /started from the relay:go label, so no person has seen it yet/);
  });

  it("leaves an attended run's pull request alone", () => {
    const state = unattendedRun();
    delete state.trigger;
    assert.deepEqual(draftReasons(state), []);
  });
});

describe('the audit trail in relay stats', () => {
  const run = (overrides: Partial<RunState> = {}): RunState => {
    const state = createRunState({
      runId: '20260825T120000-audita',
      shortId: 'audita',
      issueRef: '142',
      repository: { root, owner: 'acme', name: 'widgets', defaultBranch: 'main' },
      config: structuredClone(DEFAULT_CONFIG),
      now: new Date('2026-08-25T12:00:00Z'),
      trigger: { source: 'serve', label: 'relay:go', actor: 'maintainer', at: '2026-08-25T12:00:00Z' },
    });
    state.issue = { number: 142, title: 'Rate limit', url: 'https://github.com/acme/widgets/issues/142', state: 'open' };
    state.usage = { total: { inputTokens: 1, outputTokens: 1, costUsd: 1.25, turns: 2, pricedTurns: 2 }, byPhase: {} };
    state.commit = { sha: 'c'.repeat(40), branch: 'relay/142', subject: 's', at: '' };
    state.push = { remote: 'origin', branch: 'relay/142', sha: 'c'.repeat(40), at: '' };
    state.pullRequest = { url: 'https://github.com/acme/widgets/pull/9', number: 9, base: 'main', head: 'relay/142', createdByRun: true, at: '' };
    return Object.assign(state, overrides);
  };

  it('answers which issue, who labelled it, what it cost and what it delivered', () => {
    const stats = repositoryStats([run()], new Date('2026-08-25T18:00:00Z'));
    const summary = stats.unattended?.recent[0];
    assert.equal(stats.unattended?.runs, 1);
    assert.equal(summary?.issueRef, '142');
    assert.equal(summary?.actor, 'maintainer');
    assert.equal(summary?.label, 'relay:go');
    assert.equal(summary?.costUsd, 1.25);
    assert.equal(summary?.delivered, 'pr');
    assert.equal(summary?.pullRequest, 'https://github.com/acme/widgets/pull/9');
  });

  it("says why a run stopped, in the run's own words", () => {
    const stopped = run();
    stopped.phase = 'CANCELLED';
    stopped.stopped = { reason: 'budget', detail: 'budget exceeded: $2.10 spent of $2.00', at: '' };
    const stats = repositoryStats([stopped], new Date('2026-08-25T18:00:00Z'));
    assert.match(stats.unattended?.recent[0]?.stopped ?? '', /budget exceeded/);
  });

  it('counts today against the same day the server checks', () => {
    const stats = repositoryStats([run()], new Date('2026-08-25T18:00:00Z'));
    assert.equal(stats.unattended?.today.day, '2026-08-25');
    assert.equal(stats.unattended?.today.costUsd, 1.25);
  });

  it('says nothing at all in a repository that never turned it on', () => {
    const attended = run();
    delete attended.trigger;
    const stats = repositoryStats([attended]);
    assert.equal(stats.unattended, undefined);
    assert.equal(statsToJson(root, stats).unattended, null);
  });

  it('is in the machine-readable form too', () => {
    const json = statsToJson(root, repositoryStats([run()], new Date('2026-08-25T18:00:00Z')));
    assert.equal(json.unattended?.runs, 1);
    assert.deepEqual(json.unattended?.actors, [{ actor: 'maintainer', runs: 1, costUsd: 1.25 }]);
  });
});

describe('the serve command', () => {
  it('is registered, grouped apart from the commands a person types', () => {
    const program = buildProgram('test');
    const serve = program.commands.find((command) => command.name() === 'serve');
    assert.ok(serve, '`relay serve` is not registered');
    const flags = serve.options.map((option) => option.long);
    for (const flag of ['--once', '--issue', '--label', '--interval', '--limit', '--dry-run', '--json']) {
      assert.ok(flags.includes(flag), `\`relay serve\` has no ${flag}`);
    }
    assert.match(program.helpInformation(), /Unattended:\n\s+serve/);
  });

  it('reports what it started, and what each run exited with', () => {
    assert.deepEqual(
      serveToJson({
        stoppedBy: 'budget',
        reason: 'daily budget reached',
        started: ['20260825T120000-aaaaaa', '20260825T120001-bbbbbb'],
        results: { '20260825T120000-aaaaaa': 0 },
        passes: 3,
      }),
      {
        stoppedBy: 'budget',
        reason: 'daily budget reached',
        started: [
          { runId: '20260825T120000-aaaaaa', exitCode: 0 },
          // Still in flight when the summary was written: null, never 0. A run
          // that has not finished has not succeeded.
          { runId: '20260825T120001-bbbbbb', exitCode: null },
        ],
        passes: 3,
      },
    );
  });
});

describe('reading who applied a label', () => {
  it('takes the most recent labelling, not the first', () => {
    const events = [
      { event: 'labeled', label: { name: 'relay:go' }, actor: { login: 'first' } },
      { event: 'unlabeled', label: { name: 'relay:go' }, actor: { login: 'someone' } },
      { event: 'labeled', label: { name: 'other' }, actor: { login: 'noise' } },
      { event: 'labeled', label: { name: 'relay:go' }, actor: { login: 'second' } },
    ];
    assert.equal(lastLabelActor(events, 'relay:go'), 'second');
  });

  it('is null when the history has no such event, or none at all', () => {
    assert.equal(lastLabelActor([], 'relay:go'), null);
    assert.equal(lastLabelActor([{ event: 'closed' }], 'relay:go'), null);
    assert.equal(lastLabelActor({ message: 'Not Found' }, 'relay:go'), null);
  });

  it('is null when the actor was deleted, rather than inventing one', () => {
    assert.equal(lastLabelActor([{ event: 'labeled', label: { name: 'relay:go' }, actor: null }], 'relay:go'), null);
  });
});

/**
 * The kill switch's promise reaches all the way down: a run started by `relay
 * serve` must not install a signal handler of its own, because the first
 * Ctrl-C means "stop starting" and a run that claimed SIGINT would cancel
 * itself on it. This is that contract, checked against the real `executeRun`.
 */
describe('a run driven by something that owns the signals', () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo({ withPackageJson: true });
    process.env['RELAY_HOME'] = repo.relayHome;
  });

  afterEach(async () => {
    delete process.env['RELAY_HOME'];
    await repo.cleanup();
  });

  it('does not cancel itself on the signal its server treats as "stop starting"', async () => {
    // The happy path, except that the implementer's turn raises a SIGINT the
    // way a real Ctrl-C would arrive mid-run. `process.emit` rather than a real
    // signal: it reaches every listener without risking the default behaviour
    // of killing the test runner.
    const harnesses = {
      claude: new FakeAgentHarness('claude', {
        planner: [{ text: planText() }],
        codeReviewer: [{ text: approveReview('Implementation matches the plan.') }],
      }),
      codex: new FakeAgentHarness('codex', {
        planReviewer: [{ text: approveReview('Plan is sound.') }],
        implementer: [
          {
            text: section('NOTES', 'Edited src/app.ts'),
            effect: async (cwd: string) => {
              await writesFile('src/app.ts', 'export const value = 2;\n')(cwd);
              process.emit('SIGINT');
            },
          },
        ],
      }),
    };
    // The server's own handler, which is what SIGINT is for here.
    const serverHandler = (): void => {};
    process.on('SIGINT', serverHandler);

    const info = await discoverRepository(repo.root);
    const config = applyUnattendedPolicy(readyConfig());
    const state = createRunState({
      runId: '20260825T120000-outers',
      shortId: 'outers',
      issueRef: '142',
      repository: { root: repo.root, owner: 'acme', name: 'widgets', defaultBranch: info.defaultBranch },
      config,
      trigger: { source: 'serve', label: 'relay:go', actor: 'maintainer', at: '2026-08-25T12:00:00Z' },
    });

    const outer = new AbortController();
    const code = await executeRun(
      {
        repo: info,
        config,
        harnesses: { claude: harnesses.claude, codex: harnesses.codex },
        issueProvider: new FakeIssueProvider({ labels: ['relay:go'] }),
      },
      state,
      { compact: true },
      'run',
      { signal: outer.signal },
    );

    process.off('SIGINT', serverHandler);

    // The run saw a SIGINT and finished anyway: only the server decides what
    // that signal means, and what it means is "start nothing more".
    assert.equal(state.phase, 'COMPLETE', 'the run cancelled itself on a signal it does not own');
    // A repository with no remote delivers as far as its own branch, which is
    // an unlanded success rather than a failure.
    assert.ok(code === 0 || code === 4, `unexpected exit code ${code}`);
    assert.equal(state.merge, undefined);

    // The outer signal is the one that does reach it.
    outer.abort();
    assert.equal(outer.signal.aborted, true);
  });
});
