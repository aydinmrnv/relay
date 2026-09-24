import type { Issue, IssueProvider } from '../github/types.ts';
import type { RelayConfig } from '../storage/config.ts';
import { errorMessage } from '../util/errors.ts';
import type { RunState, TriggerRecord } from '../workflow/state.ts';
import { budgetAllows, dailySpend, type BudgetVerdict } from './budget.ts';
import { killSwitch } from './killSwitch.ts';
import { claimIssue, loadLedger, releaseClaim, type UnattendedClaim } from './ledger.ts';
import { applyUnattendedPolicy, decideTrigger, triggerLabelOf, unattendedOf } from './policy.ts';

/**
 * The loop that starts runs nobody asked for.
 *
 * It is deliberately dull, and everything interesting about it is a refusal.
 * Each pass re-reads config from disk (so the kill switch reaches a server that
 * is already running), asks the tracker what carries the trigger label, and
 * then applies the four guardrails in the order that costs least to fail:
 *
 *   1. **The kill switch** — before anything, because it is the answer that
 *      overrides every other one.
 *   2. **Concurrency** — the same repository-wide limit `relay run` obeys.
 *   3. **The budget** — checked before the claim, because a run that has
 *      started cannot be un-started.
 *   4. **The allowlist** — checked before the label comes off, so a refusal
 *      leaves the label in place where the person who applied it can see it.
 *
 * Only then does it claim the issue: ledger first (local, and reversible),
 * label removal second (public, and the acknowledgement). A server that dies
 * between the two restarts into a repository that does not hand it the same
 * work twice, which is the whole reason the ledger is on disk.
 *
 * Nothing here spawns a process, reads a credential or talks to git. Everything
 * it needs is injected, so the guardrails can be tested by asserting on a list
 * of events rather than by pointing a daemon at a real repository.
 */

export interface ServeStart {
  issue: Issue;
  trigger: TriggerRecord;
  /** The repository config with the unattended ceiling already applied. */
  config: RelayConfig;
  /** The run id the ledger recorded, so the run and the claim agree. */
  runId: string;
}

/** Everything the loop reads or does, so a test can supply all of it. */
export interface ServeDeps {
  repoRoot: string;
  provider: IssueProvider;
  /** Re-read every pass: a config flag is only a kill switch if it reaches a live server. */
  loadConfig: () => Promise<RelayConfig>;
  listRuns: () => Promise<RunState[]>;
  /** Mints the id for a run before it exists, so the claim can name it. */
  createRunId: (now: Date) => string;
  /** Drives one run to completion. Resolves with its exit code; never throws. */
  startRun: (start: ServeStart) => Promise<number>;
  log: (event: ServeEvent) => void;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Aborted by the signal half of the kill switch. */
  signal: AbortSignal;
  now?: () => Date;
  /** Stop after this many passes. `--once` passes 1. */
  maxPasses?: number;
  /** Consider only this issue reference — what the GitHub Action passes. */
  only?: string;
  /**
   * What to write in the trigger record: the daemon, or the same thing running
   * in CI. Read from the environment by the caller rather than inferred here,
   * because "was this CI?" is a question about the process, not the loop.
   */
  source: 'serve' | 'action';
  /** Decide everything, start nothing, and leave every label where it is. */
  dryRun?: boolean;
  /** Issues to look at per pass. */
  limit?: number;
}

export type ServeEvent =
  | {
      type: 'watching';
      label: string;
      pollSeconds: number;
      maxConcurrentRuns: number;
      maxRunCostUsd: number;
      maxDailyCostUsd: number;
      once: boolean;
    }
  | { type: 'considered'; issueRef: string; count: number }
  | { type: 'skipped'; issueRef: string; reason: string; actor: string | null }
  | { type: 'claimed'; issueRef: string; runId: string; actor: string | null; reason: string; dryRun: boolean }
  | { type: 'finished'; issueRef: string; runId: string; exitCode: number }
  | { type: 'deferred'; reason: string }
  | { type: 'budget'; detail: string }
  | { type: 'stopping'; reason: string; inFlight: number }
  | { type: 'error'; detail: string };

export interface ServeOutcome {
  /** Why the loop ended: a kill switch, the budget, or `--once` finishing. */
  stoppedBy: 'kill-switch' | 'signal' | 'budget' | 'once' | 'error';
  reason: string;
  started: string[];
  /** Exit codes of the runs this server drove, keyed by run id. */
  results: Record<string, number>;
  passes: number;
}

const DEFAULT_LIMIT = 50;

export async function serve(deps: ServeDeps): Promise<ServeOutcome> {
  const now = deps.now ?? ((): Date => new Date());
  const inFlight = new Map<string, Promise<void>>();
  const results: Record<string, number> = {};
  const started: string[] = [];
  // Refusals are logged once per server rather than once per pass: an issue
  // whose label nobody is allowed to have applied stays labelled on purpose, so
  // the same refusal is true every sixty seconds and saying so every sixty
  // seconds would bury everything else in the log.
  const announced = new Set<string>();

  let config = await deps.loadConfig();
  let passes = 0;
  let outcome: ServeOutcome | undefined;

  const settings = unattendedOf(config);
  deps.log({
    type: 'watching',
    label: triggerLabelOf(config),
    pollSeconds: settings.pollSeconds,
    maxConcurrentRuns: config.workflow.maxConcurrentRuns,
    maxRunCostUsd: settings.maxRunCostUsd ?? 0,
    maxDailyCostUsd: settings.maxDailyCostUsd ?? 0,
    once: deps.maxPasses === 1,
  });

  while (outcome === undefined) {
    passes += 1;

    // A config that will not parse mid-edit must not take the server down with
    // it: the last one that did parse is still a truthful description of what
    // this repository asked for, and the next pass is a second later.
    try {
      config = await deps.loadConfig();
    } catch (error) {
      deps.log({ type: 'error', detail: `could not re-read .relay/config.json: ${errorMessage(error)}` });
    }

    if (deps.signal.aborted) {
      outcome = end('signal', 'a signal asked this server to stop');
      break;
    }
    const stop = await killSwitch(deps.repoRoot, config);
    if (stop.engaged) {
      outcome = end('kill-switch', stop.reason ?? 'the kill switch is engaged');
      break;
    }

    try {
      const verdict = await pass(config);
      if (verdict !== undefined) outcome = verdict;
    } catch (error) {
      // A tracker that is briefly unreachable is not a reason to stop watching
      // it; a tracker that is permanently unreachable says so once a minute.
      deps.log({ type: 'error', detail: errorMessage(error) });
    }

    if (outcome !== undefined) break;
    if (deps.maxPasses !== undefined && passes >= deps.maxPasses) {
      outcome = end('once', 'this was a single pass');
      break;
    }

    try {
      await deps.sleep(unattendedOf(config).pollSeconds * 1_000, deps.signal);
    } catch {
      outcome = end('signal', 'a signal asked this server to stop');
    }
  }

  // Nothing above kills a run. What is in flight was already paid for, and is
  // allowed to reach the end of its own pipeline and deliver what it has.
  deps.log({ type: 'stopping', reason: outcome.reason, inFlight: inFlight.size });
  await Promise.all([...inFlight.values()]);
  return { ...outcome, started: [...started], results, passes };

  function end(stoppedBy: ServeOutcome['stoppedBy'], reason: string): ServeOutcome {
    return { stoppedBy, reason, started: [], results: {}, passes };
  }

  /** One look at the tracker. Returns an outcome only when the loop must end. */
  async function pass(active: RelayConfig): Promise<ServeOutcome | undefined> {
    const settingsNow = unattendedOf(active);
    const label = triggerLabelOf(active);
    const maxRunCostUsd = settingsNow.maxRunCostUsd ?? 0;
    const maxDailyCostUsd = settingsNow.maxDailyCostUsd ?? 0;

    const refs = await candidates(label);
    deps.log({ type: 'considered', issueRef: deps.only ?? label, count: refs.length });

    for (const ref of refs) {
      if (deps.signal.aborted) return end('signal', 'a signal asked this server to stop');

      if (inFlight.size >= active.workflow.maxConcurrentRuns) {
        // The label stays on, so the next pass — or the next server — finds it.
        deps.log({
          type: 'deferred',
          reason: `${active.workflow.maxConcurrentRuns} run(s) already in flight, which is the limit`,
        });
        return undefined;
      }

      const spend = dailySpend(await deps.listRuns(), now());
      const budget: BudgetVerdict = budgetAllows({
        spend,
        inFlight: inFlight.size,
        maxRunCostUsd,
        maxDailyCostUsd,
      });
      if (!budget.ok) {
        // Loudly, and not by queueing: an issue held until midnight is the same
        // money with a delay in front of it, and the label left on the issue is
        // a request that is still visibly outstanding.
        deps.log({ type: 'budget', detail: budget.detail });
        return end('budget', budget.detail);
      }

      const outcomeForRef = await consider(active, label, ref);
      if (outcomeForRef !== undefined) return outcomeForRef;
    }
    return undefined;
  }

  /** The issue references this pass will look at, newest request first. */
  async function candidates(label: string): Promise<string[]> {
    if (deps.only !== undefined) return [deps.only];
    if (label.length === 0) return [];
    const summaries = await deps.provider.listIssues({ labels: [label], limit: deps.limit ?? DEFAULT_LIMIT });
    if (summaries === null) return [];
    return summaries.map((summary) => summary.ref ?? String(summary.number));
  }

  /** Everything that has to be true about one issue before a run starts. */
  async function consider(active: RelayConfig, label: string, ref: string): Promise<ServeOutcome | undefined> {
    const issue = await deps.provider.getIssue(ref);
    const refuse = (reason: string, actor: string | null): void => {
      if (announced.has(issue.id)) return;
      announced.add(issue.id);
      deps.log({ type: 'skipped', issueRef: ref, reason, actor });
    };

    const ledger = await loadLedger(deps.repoRoot);
    const existing = ledger.claims.find((claim) => claim.issueId === issue.id);
    if (existing !== undefined) {
      refuse(`already started as ${existing.runId}`, existing.actor);
      return undefined;
    }

    // Asked of the tracker, never taken from an event payload or a flag: the
    // person who applied the label is the person who authorised the spending,
    // and this is the only account of that GitHub will vouch for.
    let labelActor: string | null = null;
    try {
      labelActor = (await deps.provider.labelActor?.(ref, label)) ?? null;
    } catch (error) {
      refuse(`could not read who applied ${label}: ${errorMessage(error)}`, null);
      return undefined;
    }

    const decision = await decideTrigger(unattendedOf(active), {
      issue,
      label,
      labelActor,
      ...(deps.provider.teamMembership === undefined
        ? {}
        : { teamMembership: (login, teams) => deps.provider.teamMembership!(login, teams) }),
    });
    if (!decision.allowed) {
      // The label stays exactly where it is. Taking it off would make the
      // refusal invisible to the person who applied it, and Relay's answer to
      // "why did nothing happen?" should be readable from the issue itself.
      refuse(decision.reason, decision.actor);
      return undefined;
    }

    const runId = deps.createRunId(now());
    if (deps.dryRun === true) {
      deps.log({ type: 'claimed', issueRef: ref, runId, actor: decision.actor, reason: decision.reason, dryRun: true });
      announced.add(issue.id);
      return undefined;
    }

    const claim: UnattendedClaim = {
      issueId: issue.id,
      issueRef: ref,
      runId,
      label,
      actor: decision.actor,
      at: now().toISOString(),
    };
    const { claimed, existing: raced } = await claimIssue(deps.repoRoot, claim, { now: now() });
    if (!claimed) {
      refuse(`already started as ${raced?.runId ?? 'another run'}`, raced?.actor ?? null);
      return undefined;
    }

    // The label comes off before the run starts, so a crash between here and
    // the first agent turn leaves an issue that is not asking again.
    try {
      const removed = await deps.provider.removeLabel?.(ref, label);
      if (removed === false) {
        await releaseClaim(deps.repoRoot, issue.id);
        refuse(`${label} was already gone — somebody else took this one`, decision.actor);
        return undefined;
      }
    } catch (error) {
      // A label that would not come off means the next pass would pick the same
      // issue up again, so the claim goes back too rather than stranding it.
      await releaseClaim(deps.repoRoot, issue.id);
      deps.log({ type: 'error', detail: `could not remove ${label} from ${ref}: ${errorMessage(error)}` });
      return undefined;
    }

    const trigger: TriggerRecord = {
      source: deps.source,
      label,
      actor: decision.actor,
      ...(decision.team === undefined ? {} : { team: decision.team }),
      at: claim.at,
    };
    deps.log({ type: 'claimed', issueRef: ref, runId, actor: decision.actor, reason: decision.reason, dryRun: false });
    started.push(runId);

    const running = deps
      .startRun({ issue, trigger, config: applyUnattendedPolicy(active), runId })
      .then((exitCode) => {
        results[runId] = exitCode;
        deps.log({ type: 'finished', issueRef: ref, runId, exitCode });
      })
      .catch((error: unknown) => {
        results[runId] = 1;
        deps.log({ type: 'error', detail: `run ${runId} for ${ref}: ${errorMessage(error)}` });
      })
      .finally(() => {
        inFlight.delete(runId);
      });
    inFlight.set(runId, running);
    return undefined;
  }
}
