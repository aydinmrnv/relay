import { deleteRemoteBranch, hasRemote, mergeReadiness } from '../../git/publish.ts';
import { removeWorktree } from '../../git/worktree.ts';
import { resolveExecutable } from '../../process/runner.ts';
import { RUN_FILES } from '../../storage/runs.ts';
import type { DeliveryPolicy } from '../../storage/config.ts';
import { errorMessage, isRelayError } from '../../util/errors.ts';
import type { EngineContext, PhaseResult } from '../context.ts';
import {
  issueLinkFor,
  labelFor,
  mergesRemotely,
  planDelivery,
  reachedPolicy,
  shortfall,
  type DeliveryCapabilities,
} from '../delivery.ts';
import { commitAndRecord, mergeRunBranch, openRunPullRequest, pushRunBranch } from '../publishRun.ts';
import { renderSummary } from '../summary.ts';
import type { DeliveryStep, DeliveryStepRecord, RunState } from '../state.ts';

/**
 * Everything delivery touches. Narrower than `EngineContext` on purpose: no
 * agent, no issue provider, nothing that could take another turn — which is
 * also what lets `relay deliver` re-run this phase on its own for a finished
 * run without standing up half an engine.
 */
export type DeliveryContext = Pick<EngineContext, 'state' | 'store' | 'observer' | 'signal'>;

/**
 * Delivers the finished work as far as the run is allowed to take it.
 *
 * This is the phase the whole pipeline was for. Everything before it produced a
 * diff nobody has yet: this one commits it, pushes it, opens the pull request
 * and — if that is what the repository asked for — merges it, without stopping
 * to ask, because a question at the end of a twenty-minute run is answered by
 * an empty terminal as often as by a person.
 *
 * What keeps that safe is that every step is gated before anything runs, and
 * nothing here is inferred: the plan says what will happen and why, the steps
 * record what did, and a step that fails stops the ones that depended on it
 * without failing the run — the work is on the branch either way.
 */
export async function delivering(context: DeliveryContext): Promise<PhaseResult> {
  const { state, store, observer } = context;
  const policy = state.config.workflow.deliver;
  const at = new Date().toISOString();

  const caps = await capabilities(state, policy);
  const plan = planDelivery(state, policy, caps);
  const steps: DeliveryStepRecord[] = [];

  if (policy === 'none') observer.note('Delivery is off (deliver: none) — the work stays in the worktree.');

  // The first failure ends the chain: a pull request for a branch that could
  // not be pushed would describe work nobody can fetch.
  let failed: DeliveryStep | undefined;

  for (const planned of plan) {
    if (failed !== undefined) {
      steps.push({ step: planned.step, status: 'skipped', detail: `the ${labelFor(failed)} failed`, at: now() });
      continue;
    }
    if (!planned.run) {
      steps.push({ step: planned.step, status: 'skipped', detail: planned.reason, at: now() });
      continue;
    }

    try {
      const detail = await perform(planned.step, context);
      if (detail === undefined) {
        steps.push({ step: planned.step, status: 'skipped', detail: 'nothing to commit', at: now() });
        continue;
      }
      steps.push({ step: planned.step, status: 'done', detail, at: now() });
    } catch (error) {
      failed = planned.step;
      steps.push({ step: planned.step, status: 'failed', detail: errorMessage(error), at: now() });
      observer.warn(`Could not ${labelFor(planned.step)}: ${errorMessage(error)}`);
      if (isRelayError(error) && error.hint !== undefined) {
        for (const line of error.hint.split('\n')) observer.note(line);
      }
    }
  }

  const reached = reachedPolicy(state);
  const previousCleanup = state.delivery?.cleanup;
  const link = issueLinkFor(state);
  state.delivery = {
    policy,
    reached,
    steps,
    at,
    ...(previousCleanup === undefined ? {} : { cleanup: previousCleanup }),
    ...(link === undefined ? {} : { issueLink: { ...link, at: now() } }),
  };

  if (state.merge?.via === 'pull-request' && state.pullRequest?.createdByRun === true && state.config.github.deleteBranchOnMerge) {
    await cleanupMergedRun(context);
  }

  // The ledger is persisted here rather than left to the caller: a crash right
  // after a merge must not lose the record of the merge.
  await store.writeArtifact(RUN_FILES.summary, renderSummary(state));
  await store.saveState(state);

  reportShortfall(context);

  await store.logEvent({
    timestamp: at,
    runId: state.runId,
    phase: 'DELIVERING',
    agent: null,
    type: 'delivered',
    message: `policy ${policy}, reached ${reached}`,
    data: { policy, reached, steps: steps.map(({ step, status }) => `${step}:${status}`) },
  });

  return { next: 'COMPLETE', note: `delivered as far as ${reached}` };
}

/**
 * Runs one step and returns what it produced, for the record. The publishing
 * functions announce themselves and persist their own record, so a run that
 * dies between two steps still knows which one it got to.
 */
async function perform(step: DeliveryStep, context: DeliveryContext): Promise<string | undefined> {
  const publish = {
    state: context.state,
    store: context.store,
    observer: context.observer,
    signal: context.signal,
  };

  switch (step) {
    case 'commit': {
      const committed = await commitAndRecord(publish);
      const commit = context.state.commit;
      return committed && commit !== undefined ? `${commit.sha.slice(0, 8)} on ${commit.branch}` : undefined;
    }
    case 'push': {
      const record = await pushRunBranch(publish);
      return `${record.remote}/${record.branch}`;
    }
    case 'pullRequest': {
      const record = await openRunPullRequest(publish);
      return record.url;
    }
    case 'merge': {
      const record = await mergeRunBranch(publish);
      return record.via === 'pull-request'
        ? `${record.url ?? 'the pull request'} into ${record.into}`
        : `into ${record.into} at ${record.sha?.slice(0, 8) ?? 'HEAD'}`;
    }
  }
}

/**
 * Says once, out loud, why the run did not get as far as it was asked to.
 *
 * A silent shortfall is the failure mode of anything autonomous: the run
 * reports success, the branch is committed, and nobody notices for a week that
 * no pull request was ever opened.
 */
function reportShortfall(context: DeliveryContext): void {
  const { state } = context;
  if (state.delivery?.policy === 'none') return;

  const blocked = shortfall(state.delivery);
  // A failure has already been announced with its hint; a gate has not.
  if (blocked === undefined || blocked.status === 'failed') return;

  context.observer.warn(`No ${labelFor(blocked.step)}: ${blocked.detail}.`);
}

/**
 * What the world permits, asked only about the steps this run might take. Each
 * probe is a subprocess, and a `deliver: branch` run has no business shelling
 * out to find out whether some remote exists.
 */
async function capabilities(state: RunState, policy: DeliveryPolicy): Promise<DeliveryCapabilities> {
  const root = state.repository.root;
  const publishes = policy === 'push' || policy === 'pr' || policy === 'merge';
  const opensPullRequest = policy === 'pr' || policy === 'merge';

  const caps: DeliveryCapabilities = {
    remote: publishes && (await hasRemote(root)) ? 'origin' : null,
    gh: opensPullRequest && (await resolveExecutable('gh')) !== null,
    repoSlug:
      state.repository.owner !== null && state.repository.name !== null
        ? `${state.repository.owner}/${state.repository.name}`
        : null,
    merge: { ok: false, reason: 'a merge was not requested' },
    protectedBranches: state.config.github.protectedBranches,
  };

  // Only a merge that would happen in this checkout needs to know whether this
  // checkout is ready for one.
  if (policy === 'merge' && !mergesRemotely(caps)) {
    caps.merge = await mergeReadiness(root, state.workspace?.baseBranch ?? state.repository.defaultBranch);
  }
  return caps;
}

async function cleanupMergedRun(context: DeliveryContext): Promise<void> {
  const { state, store, observer } = context;
  const cleanup = state.delivery?.cleanup ?? {};
  if (state.delivery !== undefined) state.delivery.cleanup = cleanup;

  if (cleanup.remoteBranch === undefined && state.push !== undefined) {
    try {
      const result = await deleteRemoteBranch(state.repository.root, state.push.remote, state.push.branch, {
        ...(context.signal ? { signal: context.signal } : {}),
      });
      cleanup.remoteBranch = { status: result, detail: `${state.push.remote}/${state.push.branch}`, at: now() };
    } catch (error) {
      cleanup.remoteBranch = { status: 'failed', detail: errorMessage(error), at: now() };
      observer.warn(`Post-merge cleanup could not delete the remote branch: ${errorMessage(error)}`);
    }
    await store.saveState(state);
  }

  if (cleanup.worktree === undefined && state.workspace !== undefined) {
    try {
      await removeWorktree(state.repository.root, state.workspace.path, { force: true });
      cleanup.worktree = { status: 'removed', detail: state.workspace.path, at: now() };
    } catch (error) {
      if (isRelayError(error) && error.code === 'UNKNOWN_WORKTREE') {
        cleanup.worktree = { status: 'absent', detail: state.workspace.path, at: now() };
      } else {
        cleanup.worktree = { status: 'failed', detail: errorMessage(error), at: now() };
        observer.warn(`Post-merge cleanup could not remove the worktree: ${errorMessage(error)}`);
      }
    }
    await store.saveState(state);
  }
}

function now(): string {
  return new Date().toISOString();
}
