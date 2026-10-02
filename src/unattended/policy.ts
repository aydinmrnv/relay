import { RelayError } from '../util/errors.ts';
import type { Issue, IssueComment } from '../github/types.ts';
import type { RelayConfig, UnattendedPolicy } from '../storage/config.ts';
import { DEFAULT_CONFIG } from '../storage/config.ts';
import { describeFindings, screenIssue, type InjectionFinding } from './injection.ts';

/**
 * The rules a run that nobody started has to obey.
 *
 * Everything in this file is a pure function over config and an issue, because
 * every one of these decisions is one somebody will eventually want to argue
 * with — and an argument about a guardrail should be settled by reading a test,
 * not by running a daemon against a live repository to see what it does.
 */

export type UnattendedSettings = RelayConfig['unattended'];

/**
 * The `unattended` block, defaulted. Read through a function because a run
 * snapshot recorded before this feature existed has no such key, and every
 * default in it is the closed one.
 */
export function unattendedOf(config: RelayConfig): UnattendedSettings {
  const raw = config.unattended;
  return { ...structuredClone(DEFAULT_CONFIG.unattended), ...(raw ?? {}) };
}

/** The label that starts a run without a person, or the empty string for none. */
export function triggerLabelOf(config: RelayConfig): string {
  return (config.workflow.triggerLabel ?? '').trim();
}

/**
 * Refuses to start a server whose guardrails were never configured.
 *
 * The issue this implements is explicit that the guardrails are the feature and
 * not the caveat, so none of them has a permissive default and none of them is
 * inferred here. An unset daily budget does not become "some sensible number" —
 * a ceiling nobody chose is not a ceiling anybody meant — and an empty
 * allowlist does not become "anyone who can label", which on a public
 * repository is a funded denial-of-wallet attack with a UI.
 *
 * Every message names the key to write and why it exists, because the reader is
 * about to make a decision about money and access with nobody to ask.
 */
export function assertUnattendedReady(config: RelayConfig): void {
  const settings = unattendedOf(config);
  const label = triggerLabelOf(config);

  if (label.length === 0) {
    throw new RelayError('No trigger label is configured, so nothing can start a run without a person.', {
      code: 'UNATTENDED_NOT_CONFIGURED',
      hint: 'Set workflow.triggerLabel in .relay/config.json, e.g. "relay:go".',
    });
  }
  if (!settings.enabled) {
    throw new RelayError('Unattended runs are switched off in this repository.', {
      code: 'UNATTENDED_DISABLED',
      hint: 'Set unattended.enabled to true in .relay/config.json once the allowlist and budgets below are set.',
    });
  }
  if (settings.authors.length === 0 && settings.teams.length === 0) {
    throw new RelayError(
      'The unattended allowlist is empty, so nobody is allowed to start a run by labelling an issue.',
      {
        code: 'UNATTENDED_NOT_CONFIGURED',
        hint:
          'List the logins in unattended.authors, or the "org/team" slugs in unattended.teams. ' +
          'An empty allowlist is refused rather than read as "anyone": on a public repository that is a way ' +
          'for a stranger to spend your money.',
      },
    );
  }
  if (settings.maxRunCostUsd === null) {
    throw new RelayError('No per-run budget is set, so an unattended run has nothing to stop it.', {
      code: 'UNATTENDED_NOT_CONFIGURED',
      hint: 'Set unattended.maxRunCostUsd in .relay/config.json, e.g. 2.50.',
    });
  }
  if (settings.maxDailyCostUsd === null) {
    throw new RelayError('No daily budget is set, so unattended runs have no ceiling for the day.', {
      code: 'UNATTENDED_NOT_CONFIGURED',
      hint: 'Set unattended.maxDailyCostUsd in .relay/config.json, e.g. 20.',
    });
  }
  if (settings.maxRunCostUsd > settings.maxDailyCostUsd) {
    throw new RelayError(
      `unattended.maxRunCostUsd (${settings.maxRunCostUsd}) is above unattended.maxDailyCostUsd ` +
        `(${settings.maxDailyCostUsd}), so the first run of the day could exceed the day's budget.`,
      { code: 'BAD_CONFIG', hint: 'Lower the per-run budget, or raise the daily one.' },
    );
  }
}

/**
 * The config an unattended run actually runs under.
 *
 * Four things change, and every one of them is a promise the issue makes:
 *
 * - **Delivery caps at `pr`.** `unattended.deliver` cannot spell `merge`, so
 *   the ceiling is the minimum of it and whatever `workflow.deliver` asked for.
 *   Nothing merges without a person, whatever the repository config says.
 * - **The merge question is off.** It is the one interactive step Relay has,
 *   and there is nobody at the terminal to answer it.
 * - **The per-run budget applies.** The tighter of the two ceilings wins, so a
 *   repository that already set `workflow.maxCostUsd` lower keeps its number.
 * - **The issue gets a comment.** Nobody is watching the terminal this ran in,
 *   so the tracker is where the run reports back.
 */
export function applyUnattendedPolicy(config: RelayConfig): RelayConfig {
  const settings = unattendedOf(config);
  const merged = structuredClone(config);

  merged.workflow.deliver = lowerOf(merged.workflow.deliver, settings.deliver);
  merged.workflow.offerMerge = false;
  merged.github.autoMerge = false;
  merged.github.autoPr = merged.workflow.deliver === 'pr';
  merged.github.autoPush = merged.workflow.deliver === 'pr' || merged.workflow.deliver === 'push';
  if (settings.maxRunCostUsd !== null) {
    merged.workflow.maxCostUsd =
      merged.workflow.maxCostUsd === null
        ? settings.maxRunCostUsd
        : Math.min(merged.workflow.maxCostUsd, settings.maxRunCostUsd);
  }
  // A threshold that would ask a question stops the run instead, because there
  // is nobody to ask. The per-run budget above is the ceiling that applies.
  merged.workflow.confirmAboveUsd = null;
  merged.delivery = { ...merged.delivery, comment: true };

  return merged;
}

/**
 * The relationships to a repository that are worth a commenter's word: its
 * owner, members of the organisation that owns it, and people invited to it
 * as collaborators. That is "somebody chose to let this person in", not
 * "this person can push": GitHub reports `COLLABORATOR` for a read-only or
 * triage invitation as well as for write access. `CONTRIBUTOR` is deliberately
 * not here — one merged typo fix makes a contributor of anybody.
 */
const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export interface TrustedComments {
  /** The comments the agents will read, in their original order. */
  kept: IssueComment[];
  /** Who wrote the ones they will not, each named once. */
  droppedAuthors: string[];
  dropped: number;
}

/**
 * The comments an unattended run reads, out of everything on the issue.
 *
 * The allowlist decides who may *start* a run, and until this existed it
 * decided nothing about what the run then read: the label came from a
 * maintainer, and every comment under the issue — from anyone with a GitHub
 * account, on a public repository — went into the prompt beside it. A comment
 * is the cheapest place there is to write "ignore the above and…", and the
 * agent reading it has a shell.
 *
 * So a comment reaches the agents only when there is a reason to trust its
 * author: they are on `unattended.authors`, they are the person who applied
 * the label, or the tracker itself says they own the repository, were
 * invited to it, or belong to the organisation that owns it. Everything else is
 * left out, counted, and said — in the run's notes and in `issue.md` — because
 * a discussion the agents silently did not see is a different problem.
 *
 * The issue's own title and description are not filtered. Applying the label
 * is the act of vouching for them: it says "do this", about that text.
 */
export function trustedComments(
  settings: UnattendedSettings,
  issue: Pick<Issue, 'comments'>,
  actor: string | null,
): TrustedComments {
  const named = new Set(settings.authors.map((login) => login.toLowerCase()));
  if (actor !== null) named.add(actor.toLowerCase());

  const kept: IssueComment[] = [];
  const droppedAuthors: string[] = [];
  let dropped = 0;
  for (const comment of issue.comments) {
    const trusted =
      named.has(comment.author.toLowerCase()) ||
      (comment.association !== undefined && TRUSTED_ASSOCIATIONS.has(comment.association.toUpperCase()));
    if (trusted) {
      kept.push(comment);
      continue;
    }
    dropped += 1;
    if (!droppedAuthors.includes(comment.author)) droppedAuthors.push(comment.author);
  }
  return { kept, droppedAuthors, dropped };
}

const RANK: Record<string, number> = { none: 0, branch: 1, push: 2, pr: 3, merge: 4 };

/** The stricter of the run's own policy and the unattended ceiling. */
function lowerOf(policy: RelayConfig['workflow']['deliver'], ceiling: UnattendedPolicy): UnattendedPolicy {
  return (RANK[policy] ?? 0) <= RANK[ceiling]! ? (policy as UnattendedPolicy) : ceiling;
}

/**
 * Whether an issue may start a run, and the sentence explaining the answer.
 *
 * `allowed` is false for every case Relay is not certain about, including the
 * ones that look like bookkeeping: a tracker that cannot say who applied the
 * label is a tracker whose authorisation Relay cannot check, and an unchecked
 * authorisation is a refusal. Nothing here fails open.
 */
export interface TriggerDecision {
  allowed: boolean;
  /** One sentence, logged verbatim whichever way it went. */
  reason: string;
  /** Who Relay held responsible: the labeller, or the author when it must. */
  actor: string | null;
  /** The `org/team` that let them through, when that is what did. */
  team?: string;
  /** What the injection screen matched in the text the run would read, whichever way that was decided. */
  screened?: InjectionFinding[];
}

export interface TriggerContext {
  issue: Issue;
  label: string;
  /** Who applied the label, from the tracker's own event history. */
  labelActor: string | null;
  /** Resolves the first `org/team` the login belongs to, when teams are listed. */
  teamMembership?: (login: string, teams: readonly string[]) => Promise<string | null>;
}

export async function decideTrigger(
  settings: UnattendedSettings,
  context: TriggerContext,
): Promise<TriggerDecision> {
  const { issue, label } = context;

  if (!issue.labels.includes(label)) {
    return { allowed: false, actor: null, reason: `#${issue.number ?? '?'} does not carry ${label}` };
  }
  if (issue.state !== 'open') {
    return { allowed: false, actor: null, reason: `#${issue.number ?? '?'} is ${issue.state}` };
  }

  // The labeller, not the author: the person who applied the label is the
  // person who asked for the spending. The author is the fallback only when the
  // tracker has no labelling event at all, which is the case for a tracker that
  // does not record them rather than one that is hiding something.
  const actor = context.labelActor ?? issue.author;
  if (actor === null) {
    return {
      allowed: false,
      actor: null,
      reason: `#${issue.number ?? '?'} — the tracker will not say who applied ${label}, so nothing is authorised`,
    };
  }

  let allowed: TriggerDecision | undefined;
  if (settings.authors.some((login) => login.toLowerCase() === actor.toLowerCase())) {
    allowed = { allowed: true, actor, reason: `${actor} is on unattended.authors` };
  } else if (settings.teams.length > 0 && context.teamMembership !== undefined) {
    const team = await context.teamMembership(actor, settings.teams);
    if (team !== null) allowed = { allowed: true, actor, team, reason: `${actor} is a member of ${team}` };
  }

  if (allowed === undefined) {
    return {
      allowed: false,
      actor,
      reason: `${actor} labelled #${issue.number ?? '?'} with ${label} but is not on the allowlist`,
    };
  }

  // Who may start a run is settled. What the run would then read is a second
  // question, and the label only answers it if the person read the raw text.
  const refusal = injectionRefusal(settings, issue, actor);
  if (refusal === undefined) return allowed;
  if (refusal.refuse) return { allowed: false, actor, reason: refusal.reason, screened: refusal.findings };
  return { ...allowed, reason: `${allowed.reason}; ${refusal.reason}`, screened: refusal.findings };
}

export interface InjectionRefusal {
  /** False under `warn`: the findings are reported and the run goes ahead. */
  refuse: boolean;
  reason: string;
  findings: InjectionFinding[];
}

/**
 * What the injection screen says about an issue an unattended run would read:
 * nothing when it is clean or the screen is off, and otherwise the findings
 * and whether they stop the run. The comments screened are the ones the run
 * would be given; the rest never reach an agent.
 */
export function injectionRefusal(settings: UnattendedSettings, issue: Pick<Issue, 'title' | 'body' | 'comments' | 'number'>, actor: string | null): InjectionRefusal | undefined {
  const mode = settings.injectionScreen ?? 'refuse';
  if (mode === 'off') return undefined;
  const findings = screenIssue(issue, trustedComments(settings, issue, actor).kept);
  if (findings.length === 0) return undefined;
  const number = `#${issue.number ?? '?'}`;
  if (mode === 'warn') {
    return { refuse: false, findings, reason: `the injection screen matched and is set to warn: ${describeFindings(findings)}` };
  }
  return {
    refuse: true,
    findings,
    reason:
      `${number} looks like a prompt injection: ${describeFindings(findings)}. ` +
      `Read the raw issue; if it is what it should be, run it yourself with \`relay run ${issue.number ?? '<issue>'}\`, ` +
      'or set unattended.injectionScreen to "warn"',
  };
}
