import type { ReviewRound } from '../reviews/types.ts';
import type { LoggedEvent } from '../storage/runs.ts';
import type { Role } from '../storage/config.ts';
import type { Phase } from '../workflow/phases.ts';
import { providerFor, type RunState } from '../workflow/state.ts';
import { unpricedTurns } from '../workflow/usage.ts';
import { formatDuration } from '../util/text.ts';

/**
 * Receipts: what somebody said about a run, beside what Relay measured.
 *
 * Relay's rule is that an agent saying "done" proves nothing: the diff comes
 * from git, the tests are judged by exit code, the cost is what the CLIs
 * report. A receipt is one of those checks written down as a row — the claim,
 * the measurement, where each came from, and whether they agree.
 *
 * Everything here is read from what a finished run already left on disk. It
 * adds no check of its own, so a receipt can only say what the run recorded:
 * where the record has no claim to compare, the row says `measured`, and where
 * it has no measurement, `unverified`. Neither is dressed up as agreement.
 */

/**
 * `match`      — the claim and the measurement agree.
 * `mismatch`   — they do not.
 * `measured`   — Relay measured it and nobody claimed anything to compare.
 * `unverified` — something was claimed, or expected, and the run holds no measurement that settles it.
 */
export type ReceiptVerdict = 'match' | 'mismatch' | 'measured' | 'unverified';

export interface ReceiptSide {
  /** Who said it, or what measured it: `codex`, `claude`, `git`, `Relay`. */
  by: string;
  text: string;
  /** Where in the run's record this comes from, so a reader can go and look. */
  source: string;
}

export interface Receipt {
  id: string;
  /** What the row is about: `Tests`, `Files changed`, `Finding F2`. */
  subject: string;
  /** The phase whose end made the measurement available. */
  phase: Phase;
  /** When it became known. A replay shows the receipt once it has played past this. */
  at: string;
  claim: ReceiptSide | null;
  measured: ReceiptSide | null;
  verdict: ReceiptVerdict;
  /** What the row cannot tell you, when that matters for reading it. */
  note?: string;
}

export interface ReceiptInputs {
  state: RunState;
  events: readonly LoggedEvent[];
  /** Every patch the run captured, by label: `implementation`, `revision-round-1`, … */
  patches: ReadonlyArray<{ label: string; patch: string }>;
  /** Whether each plan revision rewrote `plan.md`, by round, from `discussion/plan-round-N.json`. */
  planRevised?: Readonly<Record<number, boolean>>;
}

export function receiptsFor(inputs: ReceiptInputs): Receipt[] {
  const receipts = [
    ...independence(inputs.state),
    ...files(inputs),
    ...emptyImplementation(inputs.state),
    ...findings(inputs),
    ...tests(inputs),
    ...delivery(inputs.state),
    ...cost(inputs.state),
  ];
  // Stable: rows known at the same instant keep the order they were built in.
  return receipts.map((receipt, index) => ({ receipt, index })).sort((a, b) => a.receipt.at.localeCompare(b.receipt.at) || a.index - b.index).map((entry) => entry.receipt);
}

/* ------------------------------------------------------------------ */
/* Nothing grades its own homework                                     */
/* ------------------------------------------------------------------ */

function independence(state: RunState): Receipt[] {
  const receipts: Receipt[] = [];
  const pairs: Array<{ kind: 'plan' | 'code'; author: Role; reviewer: Role; what: string; phase: Phase }> = [
    { kind: 'plan', author: 'planner', reviewer: 'planReviewer', what: 'plan', phase: 'REVIEWING_PLAN' },
    { kind: 'code', author: 'implementer', reviewer: 'codeReviewer', what: 'diff', phase: 'REVIEWING_CODE' },
  ];
  for (const pair of pairs) {
    const first = state.reviews.find((review) => review.kind === pair.kind);
    const claim: ReceiptSide = { by: 'Relay', text: `The model that reviews a ${pair.what} is not the one that wrote it.`, source: 'the engine’s rule' };
    if (first === undefined) {
      // A run with no code review on record still has a diff, and somebody should know no review stands behind it.
      if (pair.kind === 'code' && state.diff !== undefined) {
        // A reviewer that ran and never returned a verdict Relay could read is not the same as no reviewer at all.
        const attempted = state.error?.phase === 'REVIEWING_CODE';
        receipts.push({
          id: 'independence:code',
          subject: 'Independent code review',
          phase: attempted ? 'REVIEWING_CODE' : 'IMPLEMENTING',
          at: attempted ? (state.finishedAt ?? state.diff.at) : state.diff.at,
          claim,
          measured: null,
          verdict: 'unverified',
          note: attempted
            ? `${providerFor(state, 'codeReviewer')} read the diff ${providerFor(state, 'implementer')} wrote, and the run ended before a verdict was recorded: ${state.error?.message ?? 'the review failed'}`
            : 'No code review ran on this run: the diff was read by nobody but its author.',
        });
      }
      continue;
    }
    const author = providerFor(state, pair.author);
    // The review records who actually read it; the configured role is the fallback for an older record.
    const reviewer = first.reviewer.length > 0 ? first.reviewer : providerFor(state, pair.reviewer);
    receipts.push({
      id: `independence:${pair.kind}`,
      subject: pair.kind === 'plan' ? 'Independent plan review' : 'Independent code review',
      phase: pair.phase,
      at: first.at,
      claim,
      measured: { by: 'Relay', text: `Written by ${author}, reviewed by ${reviewer}.`, source: 'state.json: agents, reviews' },
      verdict: author === reviewer ? 'mismatch' : 'match',
    });
  }
  return receipts;
}

/* ------------------------------------------------------------------ */
/* What changed                                                        */
/* ------------------------------------------------------------------ */

function agentEvents(events: readonly LoggedEvent[], type: string, role: Role): LoggedEvent[] {
  return events.filter((event) => event.agent !== null && event.type === type && event.data?.['role'] === role);
}

/** A path as git would print it: relative to the worktree, forward slashes. */
function relativeTo(path: string, worktree: string | undefined): string {
  let out = path.replace(/\\/g, '/');
  const root = worktree?.replace(/\\/g, '/').replace(/\/+$/, '');
  if (root !== undefined && root.length > 0 && out.startsWith(`${root}/`)) out = out.slice(root.length + 1);
  return out.replace(/^\.\//, '');
}

function listFiles(paths: readonly string[], max = 4): string {
  if (paths.length <= max) return paths.join(', ');
  return `${paths.slice(0, max).join(', ')} and ${paths.length - max} more`;
}

function files({ state, events }: ReceiptInputs): Receipt[] {
  const diff = state.diff;
  if (diff === undefined) return [];
  const implementer = providerFor(state, 'implementer');
  const reported = [...new Set(agentEvents(events, 'file_changed', 'implementer').map((event) => relativeTo(String(event.data?.['path'] ?? ''), state.workspace?.path)).filter((path) => path.length > 0))].sort();
  const measured: ReceiptSide = {
    by: 'git',
    text: diff.fileCount === 0 ? 'No files changed against the base commit.' : `${diff.fileCount} ${diff.fileCount === 1 ? 'file' : 'files'} changed, +${diff.additions} −${diff.deletions}: ${listFiles(diff.files)}.`,
    source: `git diff against ${state.workspace?.baseSha.slice(0, 7) ?? 'the base'} (${diff.patchFile})`,
  };
  const base = { id: 'files', subject: 'Files changed', phase: 'IMPLEMENTING' as Phase, at: diff.at, measured };
  if (reported.length === 0) {
    return [{ ...base, claim: null, verdict: 'measured', note: `${implementer} reported no file edits as events, so there is nothing to compare the diff with.` }];
  }
  const inDiff = new Set(diff.files.map((file) => file.replace(/\\/g, '/')));
  const unseen = reported.filter((path) => !inDiff.has(path));
  const unreported = [...inDiff].filter((path) => !reported.includes(path));
  const claim: ReceiptSide = {
    by: implementer,
    text: `Edited ${reported.length} ${reported.length === 1 ? 'file' : 'files'}: ${listFiles(reported)}.`,
    source: 'events.jsonl: the implementer’s file_changed events',
  };
  if (unseen.length > 0) {
    return [{ ...base, claim, verdict: 'mismatch', note: `Reported as edited, and unchanged in the diff: ${listFiles(unseen)}. An edit that was undone, or a file outside the repository, reads this way.` }];
  }
  if (unreported.length > 0) {
    // Not a contradiction: edits made by a shell command are not reported as file events.
    return [{ ...base, claim, verdict: 'measured', note: `The diff also holds ${listFiles(unreported)}, changed outside the edit tool; shell edits are not reported as file events.` }];
  }
  return [{ ...base, claim, verdict: 'match' }];
}

function emptyImplementation(state: RunState): Receipt[] {
  if (state.error?.code !== 'EMPTY_IMPLEMENTATION') return [];
  const at = state.finishedAt ?? state.updatedAt;
  return [
    {
      id: 'empty-implementation',
      subject: 'Implementation',
      phase: 'IMPLEMENTING',
      at,
      claim: { by: providerFor(state, 'implementer'), text: 'Finished its turn and reported success.', source: 'events.jsonl: the implementer’s turn_completed' },
      measured: { by: 'git', text: 'No files changed against the base commit.', source: 'git diff against the base' },
      verdict: 'mismatch',
      note: 'The run stopped here: a success with an empty diff is treated as a failure.',
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Review findings and what became of them                             */
/* ------------------------------------------------------------------ */

/** The per-file sections of a patch, by path. */
export function patchSections(patch: string): Map<string, string> {
  const sections = new Map<string, string>();
  const starts = [...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)];
  starts.forEach((match, index) => {
    const end = starts[index + 1]?.index ?? patch.length;
    sections.set(match[2]!.trim(), patch.slice(match.index, end));
  });
  return sections;
}

/** Files whose part of the patch differs between two captures of the same worktree. */
export function changedBetween(before: string, after: string): string[] {
  const a = patchSections(before);
  const b = patchSections(after);
  const changed: string[] = [];
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(path) !== b.get(path)) changed.push(path);
  }
  return changed.sort();
}

/** When the n-th visit to a phase ended, from the run's own transitions. */
function phaseEnd(state: RunState, phase: Phase, nth: number): string | undefined {
  let seen = 0;
  for (let index = 0; index < state.history.length; index += 1) {
    if (state.history[index]!.phase !== phase) continue;
    seen += 1;
    if (seen === nth) return state.history[index + 1]?.at ?? state.history[index]!.at;
  }
  return undefined;
}

function findings({ state, patches, planRevised }: ReceiptInputs): Receipt[] {
  const receipts: Receipt[] = [];
  const byLabel = new Map(patches.map((entry) => [entry.label, entry.patch]));
  const planRounds = state.reviews.filter((review) => review.kind === 'plan');
  const codeRounds = state.reviews.filter((review) => review.kind === 'code');

  planRounds.forEach((review, index) => {
    const responses = review.responses;
    if (responses === undefined || responses.length === 0) return;
    const accepted = responses.filter((response) => response.response === 'ACCEPT').length;
    const rejected = responses.filter((response) => response.response === 'REJECT').length;
    const revised = planRevised?.[review.round];
    const planner = providerFor(state, 'planner');
    receipts.push({
      id: `plan-revision:${review.round}`,
      subject: `Plan review, round ${review.round}`,
      phase: 'REVISING_PLAN',
      at: phaseEnd(state, 'REVISING_PLAN', index + 1) ?? review.at,
      claim: { by: planner, text: `Accepted ${accepted} and rejected ${rejected} of ${responses.length} ${responses.length === 1 ? 'finding' : 'findings'} from ${review.reviewer}.`, source: `state.json: reviews (plan, round ${review.round})` },
      measured: revised === undefined ? null : { by: 'Relay', text: revised ? 'plan.md was rewritten.' : 'plan.md was kept as it was.', source: `discussion/plan-round-${review.round}.json` },
      verdict: revised === undefined ? 'unverified' : (accepted > 0) === revised ? 'match' : 'mismatch',
      ...(revised === undefined ? { note: 'This run recorded no discussion file for the round.' } : { note: 'Each plan revision overwrites plan.md, so this is checked per round, not per finding.' }),
    });
  });

  codeRounds.forEach((review, index) => {
    const responses = review.responses;
    if (responses === undefined || responses.length === 0) return;
    const after = byLabel.get(`revision-round-${review.round}`);
    const before = byLabel.get(review.round <= 1 ? 'implementation' : `revision-round-${review.round - 1}`);
    const changed = before === undefined || after === undefined ? undefined : changedBetween(before, after);
    const next = codeRounds[index + 1];
    const implementer = providerFor(state, 'implementer');
    const at = phaseEnd(state, 'REVISING_CODE', index + 1) ?? review.at;
    for (const response of responses) {
      const finding = review.findings.find((candidate) => candidate.id === response.findingId);
      const subject = `Finding ${response.findingId}${finding === undefined ? '' : `: ${finding.summary}`}`;
      const claim: ReceiptSide = { by: implementer, text: `${response.response}${response.reasoning.trim().length > 0 ? `: ${response.reasoning.trim()}` : ''}`, source: `state.json: reviews (code, round ${review.round})` };
      const base = { id: `finding:code:${review.round}:${response.findingId}`, subject, phase: 'REVISING_CODE' as Phase, at, claim };
      const source = `patches/${review.round <= 1 ? 'implementation' : `revision-round-${review.round - 1}`}.patch → patches/revision-round-${review.round}.patch`;

      if (response.response === 'ACCEPT') {
        if (changed === undefined) {
          receipts.push({ ...base, measured: null, verdict: 'unverified', note: 'The patches before and after this round were not both kept.' });
        } else if (changed.length === 0) {
          receipts.push({ ...base, measured: { by: 'git', text: 'The revision changed nothing: the diff is identical before and after.', source }, verdict: 'mismatch' });
        } else if (finding?.file === undefined) {
          receipts.push({ ...base, measured: { by: 'git', text: `The revision changed ${listFiles(changed)}.`, source }, verdict: 'unverified', note: 'The finding names no file, so the change cannot be tied to it.' });
        } else if (changed.includes(finding.file.replace(/\\/g, '/'))) {
          receipts.push({ ...base, measured: { by: 'git', text: `The revision changed ${finding.file}.`, source }, verdict: 'match', note: 'That the file changed is measured; whether the change fixes the finding is the next review’s call.' });
        } else {
          receipts.push({ ...base, measured: { by: 'git', text: `The revision changed ${listFiles(changed)}, and not ${finding.file}.`, source }, verdict: 'unverified', note: 'A fix can live in another file; the next review decides.' });
        }
        continue;
      }
      if (response.response === 'REJECT') {
        if (next === undefined) receipts.push({ ...base, measured: null, verdict: 'unverified', note: 'No further review round ran to accept or contest the rejection.' });
        else {
          receipts.push({
            ...base,
            measured: { by: next.reviewer, text: next.decision === 'approve' ? `Approved the next round (${next.round}).` : `Requested changes again in round ${next.round}.`, source: `state.json: reviews (code, round ${next.round})` },
            verdict: next.decision === 'approve' ? 'match' : 'unverified',
          });
        }
        continue;
      }
      receipts.push({ ...base, measured: null, verdict: 'unverified', note: 'A request for clarification is neither a fix nor a rejection.' });
    }
  });

  for (const verdict of [reviewVerdict(planRounds, 'plan'), reviewVerdict(codeRounds, 'code')]) {
    if (verdict !== undefined) receipts.push(verdict);
  }
  return receipts;
}

/**
 * How a debate ended. An approval and a round limit both let the run go on,
 * and afterwards they look the same unless somebody writes down which it was.
 */
function reviewVerdict(rounds: ReviewRound[], kind: 'plan' | 'code'): Receipt | undefined {
  const last = rounds.at(-1);
  if (last === undefined) return undefined;
  const open = kind === 'code' ? last.findings.filter((finding) => finding.impact === 'BLOCKING').length : last.findings.length;
  const what = kind === 'code' ? 'blocking finding' : 'finding';
  return {
    id: `${kind}-review`,
    subject: kind === 'plan' ? 'Plan review verdict' : 'Code review verdict',
    phase: kind === 'plan' ? 'REVIEWING_PLAN' : 'REVIEWING_CODE',
    at: last.at,
    claim: null,
    measured: {
      by: last.reviewer,
      text:
        last.decision === 'approve'
          ? `Approved in round ${last.round}${last.findings.length === 0 ? '.' : `, with ${last.findings.length} ${last.findings.length === 1 ? 'finding' : 'findings'} left as advice.`}`
          : `Still requesting changes after round ${last.round}: ${open} ${what}${open === 1 ? '' : 's'} open.`,
      source: `state.json: reviews (${kind}, round ${last.round})`,
    },
    verdict: 'measured',
    ...(last.decision === 'approve' ? {} : { note: kind === 'plan' ? 'The round limit ended the debate, not an approval: the plan was implemented as it stood.' : 'The round limit ended the debate, not an approval.' }),
  };
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

/**
 * What a shell was asked to run, for an agent that wraps every command in one
 * (`/bin/zsh -lc "npm test"`).
 *
 * Only the suite run on its own counts as the implementer's claim about the
 * suite. A filtered run (`npm test -- --test-name-pattern=…`) or a line that
 * does three things and happens to end with the tests exits for its own
 * reasons, and comparing that code with Relay's full run would invent a
 * disagreement.
 */
function unwrapShell(command: string): string {
  const wrapped = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  return (wrapped?.[2] ?? command).trim();
}

function tests({ state, events }: ReceiptInputs): Receipt[] {
  const record = state.tests;
  if (record === undefined) return [];
  const printable = record.command.join(' ');
  const implementer = providerFor(state, 'implementer');
  // The implementer's own run of the same command, when its CLI reported how it exited.
  const own = printable.length === 0 ? undefined : [...agentEvents(events, 'command', 'implementer')].reverse().find((event) => typeof event.data?.['exitCode'] === 'number' && unwrapShell(String(event.data?.['command'] ?? '')) === printable);
  const claim: ReceiptSide | null =
    own === undefined ? null : { by: implementer, text: `Ran \`${String(own.data?.['command'])}\` itself: exit ${String(own.data?.['exitCode'])}.`, source: 'events.jsonl: the implementer’s command events' };
  const base = { id: 'tests', subject: 'Tests', phase: 'TESTING' as Phase, at: record.at, claim };

  if (!record.discovered || record.skippedReason !== undefined) {
    return [{ ...base, measured: null, verdict: 'unverified', note: `Relay ran no test command: ${record.skippedReason ?? record.reason}.` }];
  }
  const measured: ReceiptSide = {
    by: 'Relay',
    text: `\`${printable}\` ${record.timedOut ? 'timed out' : `exited ${String(record.exitCode)}`} after ${formatDuration(record.durationMs)}: ${record.passed ? 'passed' : 'failed'}.`,
    source: record.outputFile === undefined ? 'state.json: tests' : `${record.outputFile}, judged by exit code`,
  };
  if (own === undefined) {
    return [{ ...base, measured, verdict: 'measured', note: `${implementer} reported no run of exactly this command with an exit code. Relay’s own run is the result.` }];
  }
  const agentPassed = own.data?.['exitCode'] === 0;
  return [{ ...base, measured, verdict: agentPassed === record.passed ? 'match' : 'mismatch' }];
}

/* ------------------------------------------------------------------ */
/* Delivery and cost                                                   */
/* ------------------------------------------------------------------ */

const POLICY_WORDS: Record<string, string> = { none: 'nothing: the work stays in the worktree', branch: 'a commit on the run branch', push: 'a pushed branch', pr: 'a pull request', merge: 'a merge' };

function delivery(state: RunState): Receipt[] {
  const record = state.delivery;
  if (record === undefined) return [];
  const done = record.steps.filter((step) => step.status === 'done').map((step) => step.detail);
  const failed = record.steps.filter((step) => step.status === 'failed');
  const stopped = record.steps.find((step) => step.status !== 'done');
  const reached = record.reached === record.policy;
  return [
    {
      id: 'delivery',
      subject: 'Delivery',
      phase: 'DELIVERING',
      at: record.at,
      claim: { by: 'the workflow', text: `Deliver as far as ${POLICY_WORDS[record.policy] ?? record.policy}.`, source: 'state.json: config.workflow.deliver' },
      measured: {
        by: 'Relay',
        text: deliveredText(done, state.pullRequest?.url),
        source: 'state.json: delivery, commit, push, pullRequest',
      },
      verdict: reached ? 'match' : 'mismatch',
      ...(reached || stopped === undefined ? {} : { note: `Stopped at ${stopped.step}${failed.length > 0 ? ' (failed)' : ''}: ${stopped.detail}` }),
    },
  ];
}

/** The steps taken, with the pull request named once: a step's own detail usually carries its address already. */
function deliveredText(done: readonly string[], pullRequest: string | undefined): string {
  if (done.length === 0) return 'No step was taken.';
  const steps = done.join(' · ');
  return pullRequest === undefined || steps.includes(pullRequest) ? steps : `${steps} · ${pullRequest}`;
}

function cost(state: RunState): Receipt[] {
  const usage = state.usage;
  if (usage === undefined) return [];
  const total = usage.total;
  const unpriced = unpricedTurns(total);
  const tokens = `${total.inputTokens.toLocaleString('en-US')} tokens in, ${total.outputTokens.toLocaleString('en-US')} out`;
  return [
    {
      id: 'cost',
      subject: 'Cost',
      phase: state.phase,
      at: state.finishedAt ?? state.updatedAt,
      claim: null,
      measured: {
        by: 'the coding CLIs',
        text: total.costUsd === undefined ? `No price reported over ${total.turns} ${total.turns === 1 ? 'turn' : 'turns'}: ${tokens}.` : `$${total.costUsd.toFixed(2)} over ${total.turns} ${total.turns === 1 ? 'turn' : 'turns'}: ${tokens}.`,
        source: 'state.json: usage, as each CLI reported it',
      },
      verdict: 'measured',
      ...(unpriced > 0 ? { note: `${unpriced} ${unpriced === 1 ? 'turn' : 'turns'} reported no price, so the figure is a floor. Codex publishes token counts, not costs.` } : {}),
    },
  ];
}
