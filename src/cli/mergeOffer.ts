import { mergeReadiness } from '../git/publish.ts';
import type { RunStore } from '../storage/runs.ts';
import { Prompter, isPromptCancelled, type PromptSession } from '../ui/prompt.ts';
import { errorMessage, isRelayError } from '../util/errors.ts';
import { draftReasons } from '../workflow/delivery.ts';
import type { RunObserver } from '../workflow/observer.ts';
import { delivering } from '../workflow/phases/delivery.ts';
import type { RunState } from '../workflow/state.ts';
import { dim, fail, hint, out } from './output.ts';

/**
 * The one decision delivery does not make for you.
 *
 * Everything up to the pull request is mechanical: it can be gated, checked
 * against git, and undone by closing a branch. Merging is where the work stops
 * being a proposal, and that is a call worth one question at the end of a run
 * rather than a policy set weeks earlier — so a run that delivered to `pr`
 * finishes by asking, once, whether to land it.
 *
 * It is a single yes/no, never a menu, and never asked when the answer could
 * only be no: an unmergeable state, a draft-worthy run, a terminal nobody is
 * watching, or `workflow.deliver: merge`, which already merged it.
 */

export interface MergeAvailability {
  /** The question to ask, when a merge is genuinely on the table. */
  question?: string;
  /** Why it is not on the table, when that is worth saying out loud. */
  blocked?: string;
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

  // A run whose own evidence is not clean opened a draft; offering to merge it
  // would be offering something GitHub will refuse, for a good reason.
  const drafting = draftReasons(state);
  if (drafting.length > 0) return { blocked: drafting.join('; ') };

  if (state.pullRequest !== undefined) {
    return {
      question: `  Merge ${state.pullRequest.url} into ${base} now? (${state.config.workflow.mergeMethod})`,
    };
  }

  const ready = await mergeReadiness(state.repository.root, base);
  if (!ready.ok) return { blocked: ready.reason ?? `${base} cannot be merged into from here` };

  return { question: `  Merge ${state.workspace?.branch ?? 'the run branch'} into ${base} in your checkout now?` };
}

export interface MergeOfferDeps {
  prompter?: PromptSession;
  /** Performs the merge. Injected so the flow is testable without git or gh. */
  merge?: () => Promise<void>;
  observer?: RunObserver;
}

/**
 * Asks, once, and merges if the answer is yes. Returns whether it merged.
 *
 * Answering yes raises this run's delivery policy to `merge` and re-runs the
 * delivery phase, which is idempotent: the commit, push and pull request are
 * already recorded as done, so only the merge itself happens — through the same
 * gates, with the same ledger, as if the run had been configured that way.
 */
export async function offerMerge(state: RunState, store: RunStore, deps: MergeOfferDeps = {}): Promise<boolean> {
  const availability = await mergeAvailability(state);

  if (availability.question === undefined) {
    if (availability.blocked !== undefined) out(dim(`  No merge offered: ${availability.blocked}.`));
    return false;
  }

  const owned = deps.prompter === undefined;
  const prompter = deps.prompter ?? new Prompter();

  try {
    // Behind a pipe or in CI the run is over: a question nobody can answer is a
    // hang, and the command that lands it later is one line away.
    if (!prompter.interactive) {
      hint(`Not a terminal, so nothing was merged. To land it: relay deliver ${state.runId} --to merge`);
      return false;
    }

    out();
    // Enter is "no". Merging is the one step that moves a branch other people
    // pull from, so it never happens because someone was pressing return.
    if (!(await prompter.confirm(availability.question, false))) {
      out(dim('  Left unmerged.'));
      return false;
    }

    await (deps.merge ?? (() => mergeNow(state, store, deps.observer))).call(null);
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
  note: (text) => out(`  ${text}`),
  warn: (text) => out(`  ${text}`),
};
