import { mergeReadiness } from '../git/publish.ts';
import { autoMergeAllowed, enableAutoMerge } from '../github/pullRequest.ts';
import { RUN_FILES, type RunStore } from '../storage/runs.ts';
import { Prompter, isPromptCancelled, type PromptSession } from '../ui/prompt.ts';
import { errorMessage, isRelayError } from '../util/errors.ts';
import { mergeEvidence, mergeUnblock, reachedPolicy } from '../workflow/delivery.ts';
import type { RunObserver } from '../workflow/observer.ts';
import { delivering } from '../workflow/phases/delivery.ts';
import { renderSummary } from '../workflow/summary.ts';
import type { MergeOfferRecord, RunState } from '../workflow/state.ts';
import { dim, fail, hint, out } from './output.ts';

/**
 * The one decision delivery does not make for you.
 *
 * Everything up to the pull request is mechanical: it can be gated, checked
 * against git, and undone by closing a branch. Merging is where the work stops
 * being a proposal, and that is a call worth one question at the end of a run
 * rather than a policy set weeks earlier — so a pull request opened in this
 * session always ends with the merge question, or a stated reason there is none.
 *
 * Evidence shapes the question rather than silencing it. Bad evidence — failed
 * tests, blocking findings nobody accepted — is a refusal: the pull request is
 * a draft and no question is put. Missing evidence — no test command found,
 * `--no-tests` — goes into the question, gap named, default no. Where GitHub
 * can hold the decision, a third answer is offered: merge when the checks pass.
 *
 * Default no, and Enter is no. Nothing is asked behind a pipe or in CI — the
 * unanswered question is recorded on the run instead, and `relay deliver <run>
 * --to merge` answers it later. Agents never reach any of this: the question is
 * put to a person, and only a person's answer moves anything.
 */

export interface MergeAvailability {
  /** The question to ask, when a merge is genuinely on the table. */
  question?: string;
  /** The gaps and caveats the question carries, when it carries any. */
  detail?: string;
  /** Why it is not on the table, when that is worth saying out loud. */
  blocked?: string;
  /** What would change the refusal, when there is one worth naming. */
  unblock?: string;
  /** True when the merge lands through the pull request, where GitHub can wait on checks. */
  viaPullRequest?: boolean;
}

/**
 * Whether merging is possible right now, and how it would happen. A pull
 * request merges on GitHub; without one, the merge happens in the user's own
 * checkout, which has to be clean and on the base branch first.
 */
export async function mergeAvailability(state: RunState): Promise<MergeAvailability> {
  if (state.merge !== undefined || state.commit === undefined) return {};
  if (!state.config.workflow.offerMerge) return {};

  const base = state.workspace?.baseBranch ?? state.repository.defaultBranch;

  // Bad evidence opened a draft; offering to merge it would be offering
  // something GitHub will refuse, for a good reason. The refusal names what
  // would change it, because the command a refused user reaches for next —
  // `relay deliver --to merge` — refuses the same evidence.
  const evidence = mergeEvidence(state);
  if (evidence.blockers.length > 0) {
    const unblock = mergeUnblock(state);
    return { blocked: evidence.blockers.join('; '), ...(unblock === undefined ? {} : { unblock }) };
  }

  // Missing evidence and caveats ride the question: the user is standing right
  // there and has more context than this function does.
  const notes = [...evidence.gaps, ...evidence.caveats];
  const preamble = notes.length === 0 ? '' : `${notes.join(' ')} `;
  const closing = notes.length === 0 ? 'now' : 'anyway';
  const detail = notes.length === 0 ? {} : { detail: notes.join(' ') };

  if (state.pullRequest !== undefined) {
    if (state.pullRequest.createdByRun !== true) return { blocked: 'this run did not create the pull request' };
    return {
      question: `  ${preamble}Merge ${state.pullRequest.url} into ${base} ${closing}? (${state.config.github.mergeMethod})`,
      ...detail,
      viaPullRequest: true,
    };
  }

  const ready = await mergeReadiness(state.repository.root, base);
  if (!ready.ok) return { blocked: ready.reason ?? `${base} cannot be merged into from here` };

  return {
    question: `  ${preamble}Merge ${state.workspace?.branch ?? 'the run branch'} into ${base} in your checkout ${closing}?`,
    ...detail,
  };
}

export interface MergeOfferDeps {
  prompter?: PromptSession;
  /** Performs the merge. Injected so the flow is testable without git or gh. */
  merge?: () => Promise<void>;
  /** Whether GitHub would hold an auto-merge here. Injected so tests never probe `gh`. */
  autoMergeAvailable?: () => Promise<boolean>;
  /** Arms auto-merge on the pull request. Injected so the flow is testable without gh. */
  enableAuto?: () => Promise<void>;
  observer?: RunObserver;
}

const POLICY_RANK = { none: 0, branch: 1, push: 2, pr: 3, merge: 4 } as const;

interface PublishingRung {
  policy: 'push' | 'pr';
  question: string;
  /** What answering yes also does, when that is more than the question says. */
  note?: string;
}

/**
 * What is left to authorize, as questions.
 *
 * A push on its own is not a decision anybody makes — it is the first half of
 * opening a pull request, and asking about it separately turns one intention
 * into two prompts at the end of a twenty-minute run. So a repository Relay can
 * open a pull request against is asked exactly that, once, and the push happens
 * as part of it. Only a repository with no GitHub side to it is asked about the
 * push by itself, because there the push *is* the whole step.
 */
function publishingRungs(state: RunState): PublishingRung[] {
  const branch = state.workspace?.branch ?? 'the run branch';
  const base = state.workspace?.baseBranch ?? state.repository.defaultBranch;

  if (state.repository.owner === null || state.repository.name === null) {
    return [{ policy: 'push', question: `  Push ${branch} to origin now?` }];
  }

  return [
    {
      policy: 'pr',
      question: `  Open a pull request into ${base} now?`,
      ...(state.push === undefined ? { note: `${branch} is pushed to origin first.` } : {}),
    },
  ];
}

/** Offers each still-unauthorized publishing rung in dependency order. */
export async function offerDelivery(
  state: RunState,
  store: RunStore,
  deps: MergeOfferDeps = {},
): Promise<void> {
  if (!state.config.workflow.offerMerge || state.commit === undefined) return;
  const owned = deps.prompter === undefined;
  const prompter = deps.prompter ?? new Prompter();
  try {
    for (const rung of publishingRungs(state)) {
      if (POLICY_RANK[reachedPolicy(state)] >= POLICY_RANK[rung.policy]) continue;
      if (!prompter.interactive) {
        hint(`Not a terminal, so nothing was published. To continue: relay deliver ${state.runId} --to ${rung.policy}`);
        return;
      }
      out();
      if (rung.note !== undefined) out(dim(`  ${rung.note}`));
      if (!(await prompter.confirm(rung.question, false))) return;
      state.config.workflow.deliver = rung.policy;
      await delivering({ state, store, observer: deps.observer ?? printingObserver, signal: new AbortController().signal });
      if (reachedPolicy(state) !== rung.policy) return;
    }
    await offerMerge(state, store, { ...deps, prompter });
  } finally {
    if (owned) prompter.close();
  }
}

type MergeAnswer = 'now' | 'when-checks-pass' | 'no';

/**
 * Asks, once, and merges if the answer is yes. Returns whether it merged.
 *
 * Answering "now" raises this run's delivery policy to `merge` and re-runs the
 * delivery phase, which is idempotent: the commit, push and pull request are
 * already recorded as done, so only the merge itself happens — through the same
 * gates, with the same ledger, as if the run had been configured that way.
 * Answering "when checks pass" arms GitHub's auto-merge instead: the decision
 * is made here, and GitHub holds it until the required checks pass.
 */
export async function offerMerge(state: RunState, store: RunStore, deps: MergeOfferDeps = {}): Promise<boolean> {
  const availability = await mergeAvailability(state);

  if (availability.question === undefined) {
    if (availability.blocked !== undefined) {
      out(dim(`  No merge offered: ${availability.blocked}.`));
      if (availability.unblock !== undefined) hint(availability.unblock);
    }
    return false;
  }

  const owned = deps.prompter === undefined;
  const prompter = deps.prompter ?? new Prompter();

  try {
    // Behind a pipe or in CI the run is over: a question nobody can answer is a
    // hang. The question itself is recorded as state instead, so `relay status`
    // shows it and the command that lands it later is one line away.
    if (!prompter.interactive) {
      if (state.pullRequest !== undefined) await recordOffer(state, store, 'pending', availability.detail);
      hint(`Not a terminal, so nothing was merged. To land it: relay deliver ${state.runId} --to merge`);
      return false;
    }

    // Recorded as unanswered before it is put: a terminal that closes at the
    // prompt leaves a run that still knows its pull request is waiting.
    if (state.pullRequest !== undefined) await recordOffer(state, store, 'pending', availability.detail);

    out();
    const answer = await askMerge(state, prompter, availability, deps);

    if (answer === 'no') {
      if (state.pullRequest !== undefined) await recordOffer(state, store, 'declined', availability.detail);
      out(dim('  Left unmerged.'));
      hint(`To land it later: relay deliver ${state.runId} --to merge`);
      return false;
    }

    if (answer === 'when-checks-pass') {
      await (
        deps.enableAuto ??
        (() =>
          enableAutoMerge(state.pullRequest!.url, state.config.github.mergeMethod, {
            cwd: state.repository.root,
          }))
      ).call(null);
      await recordOffer(
        state,
        store,
        'auto',
        `auto-merge (${state.config.github.mergeMethod}) armed; GitHub merges when the checks pass`,
      );
      out(dim('  Auto-merge is on: GitHub merges it when its checks pass.'));
      return false;
    }

    await (deps.merge ?? (() => mergeNow(state, store, deps.observer))).call(null);
    if (state.merge !== undefined && state.mergeOffer !== undefined) {
      await recordOffer(state, store, 'accepted', availability.detail);
    }
    return state.merge !== undefined;
  } catch (error) {
    if (isPromptCancelled(error)) {
      out(dim('  Left unmerged.'));
      return false;
    }
    fail(errorMessage(error));
    if (isRelayError(error) && error.hint !== undefined) {
      for (const line of error.hint.split('\n')) hint(line, '    ');
    }
    return false;
  } finally {
    if (owned) prompter.close();
  }
}

/**
 * Puts the question, in whichever shape the world supports.
 *
 * "When checks pass" is GitHub holding a decision the person makes now, so it
 * is offered only where GitHub can actually hold it: a pull request, in a
 * repository whose settings allow auto-merge. Everywhere else the question
 * stays a plain yes/no. The default is "no" in both shapes, and Enter takes it.
 */
async function askMerge(
  state: RunState,
  prompter: PromptSession,
  availability: MergeAvailability,
  deps: MergeOfferDeps,
): Promise<MergeAnswer> {
  const auto =
    availability.viaPullRequest === true &&
    (await (deps.autoMergeAvailable ?? (() => probeAutoMerge(state))).call(null));

  if (!auto) return (await prompter.confirm(availability.question!, false)) ? 'now' : 'no';

  return prompter.choice<MergeAnswer>(
    availability.question!,
    [
      { value: 'now', label: `merge immediately (${state.config.github.mergeMethod})` },
      { value: 'when-checks-pass', label: 'let GitHub merge it once its checks pass' },
      { value: 'no', label: 'leave the pull request open' },
    ],
    'no',
  );
}

/** Whether this repository would hold an auto-merge. Any failure to answer is "no". */
async function probeAutoMerge(state: RunState): Promise<boolean> {
  const repo =
    state.repository.owner !== null && state.repository.name !== null
      ? `${state.repository.owner}/${state.repository.name}`
      : undefined;
  try {
    return await autoMergeAllowed(repo, { cwd: state.repository.root });
  } catch {
    return false;
  }
}

/** Persists what became of the question, so the answer survives the terminal. */
async function recordOffer(
  state: RunState,
  store: RunStore,
  status: MergeOfferRecord['status'],
  detail?: string,
): Promise<void> {
  state.mergeOffer = { status, ...(detail === undefined ? {} : { detail }), at: new Date().toISOString() };
  await store.writeArtifact(RUN_FILES.summary, renderSummary(state));
  await store.saveState(state);
}

/** Raises the policy and re-runs delivery, which now has exactly one step left. */
async function mergeNow(state: RunState, store: RunStore, observer?: RunObserver): Promise<void> {
  state.config.workflow.deliver = 'merge';
  await delivering({
    state,
    store,
    observer: observer ?? printingObserver,
    signal: new AbortController().signal,
  });
}

/** Prints what the merge reports, in the CLI's own voice. */
const printingObserver: RunObserver = {
  phaseChanged() {},
  roleStatus() {},
  agentEvent() {},
  reviewCompleted() {},
  testStatus() {},
  note: (text) => out(`  ${text}`),
  warn: (text) => out(`  ${text}`),
};
