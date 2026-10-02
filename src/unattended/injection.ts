import type { Issue, IssueComment } from '../github/types.ts';
import { oneLine } from '../util/text.ts';

/**
 * The injection screen: a tripwire over the text an unattended run is about
 * to hand to a model that has a shell.
 *
 * It looks for the phrasings a prompt injection is usually written in — an
 * instruction to ignore instructions, a forged system message, text hidden
 * from the person reading the rendered issue, a command that sends a secret
 * somewhere — and refuses to start the run when it finds one, saying which and
 * where. A person can still read the issue and run it by hand.
 *
 * It is a list of patterns, and it must not be mistaken for more. A hostile
 * issue written in words this list does not know walks straight past it, and
 * a harmless issue *about* prompt injection trips it. What actually bounds a
 * hostile issue is everything else an unattended run does: it reads only
 * trusted comments, withholds secret-named variables from its agents, runs its
 * reviewers read-only in a sandbox, scans for secrets before it pushes and
 * cannot publish past a draft pull request. The screen stops the lazy attempt
 * before it costs a run, and tells a maintainer to look before labelling.
 */

export interface InjectionRule {
  id: string;
  /** What the pattern looks for, as a clause that completes "the text …". */
  what: string;
  pattern: RegExp;
}

/**
 * Characters a rendered page does not show: zero-width spaces and joiners,
 * direction overrides, and the Unicode "tag" block, which spells ASCII that no
 * renderer draws. An issue has no honest use for a run of them.
 */
const INVISIBLE = /[​-‏‪-‮⁠-⁤﻿]{2,}|[\u{E0020}-\u{E007F}]/u;

export const INJECTION_RULES: readonly InjectionRule[] = [
  {
    id: 'override-instructions',
    what: 'tells the reader to ignore or replace its instructions',
    pattern: /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|preceding|original|system|all)\b[^.\n]{0,30}\b(?:instructions?|prompts?|rules?|directions?|guidelines?|context)\b/i,
  },
  {
    id: 'new-instructions',
    what: 'announces new instructions or a new role for the reader',
    pattern: /\b(?:new|updated|real|actual)\s+(?:system\s+)?(?:instructions?|prompt)\s*:|\byou\s+are\s+now\s+(?:a|an|the|in)\b|\bfrom\s+now\s+on,?\s+you\b/i,
  },
  {
    id: 'forged-system-message',
    what: 'is dressed as a system or developer message',
    pattern: /<\/?\s*(?:system|developer|assistant|instructions?)\s*>|\[\/?(?:INST|SYSTEM)\]|^\s*(?:system|developer)\s*(?:message|prompt)?\s*:/im,
  },
  {
    id: 'forged-relay-marker',
    what: 'contains Relay’s own section markers, which only an agent’s reply should',
    pattern: /===\s*RELAY:(?:BEGIN|END)\b/i,
  },
  {
    id: 'hidden-html-comment',
    what: 'hides instructions in an HTML comment, which the rendered issue does not show',
    pattern: /<!--[\s\S]{0,2000}?\b(?:instructions?|ignore|disregard|you\s+(?:must|should|are)|assistant|agent|claude|codex|curl|wget|token|secret|credentials?)\b[\s\S]{0,2000}?-->/i,
  },
  {
    id: 'invisible-characters',
    what: 'contains characters that are not drawn on the page',
    pattern: INVISIBLE,
  },
  {
    id: 'exfiltrate-secrets',
    what: 'pairs a network command with a credential, an environment dump or a key file',
    pattern: /\b(?:curl|wget|nc|ncat|netcat|scp)\b[^\n]{0,200}(?:\$\{?\w*(?:TOKEN|SECRET|PASSWORD|API_?KEY|CREDENTIAL)\w*|\bprintenv\b|\benv\b\s*\||\.env\b|~\/\.(?:ssh|aws|config)|\bid_(?:rsa|ed25519)\b)|(?:\bprintenv\b|\benv\b|\bcat\s+~?\/?[^\n|]{0,60}(?:\.env|\.ssh|\.aws|id_rsa|id_ed25519))[^\n]{0,80}\|\s*(?:curl|wget|nc|ncat|netcat|base64)\b/i,
  },
  {
    id: 'conceal-from-people',
    what: 'asks for something to be kept from the people reviewing the work',
    pattern: /\b(?:do\s+not|don['’]?t|never)\s+(?:tell|mention|reveal|report|disclose|show)\b[^.\n]{0,60}\b(?:user|users|reviewers?|maintainers?|humans?|anyone|owner)\b|\bwithout\s+(?:telling|mentioning|notifying|informing)\b[^.\n]{0,40}\b(?:user|reviewers?|maintainers?|anyone)\b/i,
  },
  {
    id: 'disable-safeguards',
    what: 'asks for a safeguard to be switched off',
    pattern: /\b(?:disable|turn\s+off|bypass|get\s+around)\b[^.\n]{0,30}\b(?:sandbox|guardrails?|secret\s+scan|safety\s+checks?)\b|\bskip\b[^.\n]{0,20}\b(?:secret\s+scan|safety\s+checks?)\b/i,
  },
];

export interface InjectionFinding {
  rule: string;
  what: string;
  /** Which part of the issue matched. */
  where: 'title' | 'description' | 'comment';
  /** Who wrote it, for a comment. */
  author?: string;
  /** The matched text, on one line and cut short, with anything invisible spelled out. */
  excerpt: string;
}

/** Makes what a page would not draw visible in a log line: `​` rather than nothing at all. */
function visible(text: string): string {
  return text.replace(/[​-‏‪-‮⁠-⁤﻿]|[\u{E0000}-\u{E007F}]/gu, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`);
}

/** Every rule a piece of text trips, each once. */
export function screenText(text: string): Array<{ rule: string; what: string; excerpt: string }> {
  const findings: Array<{ rule: string; what: string; excerpt: string }> = [];
  for (const rule of INJECTION_RULES) {
    const match = rule.pattern.exec(text);
    if (match === null) continue;
    findings.push({ rule: rule.id, what: rule.what, excerpt: oneLine(visible(match[0]), 100) });
  }
  return findings;
}

/**
 * Screens what an unattended run would read from an issue: its title, its
 * description, and the comments that survived the trust filter. The comments
 * left out by that filter never reach an agent, so they are not screened.
 */
export function screenIssue(issue: Pick<Issue, 'title' | 'body'>, comments: readonly IssueComment[]): InjectionFinding[] {
  return [
    ...screenText(issue.title).map((finding) => ({ ...finding, where: 'title' as const })),
    ...screenText(issue.body).map((finding) => ({ ...finding, where: 'description' as const })),
    ...comments.flatMap((comment) => screenText(comment.body).map((finding) => ({ ...finding, where: 'comment' as const, author: comment.author }))),
  ];
}

/** One sentence for a refusal or a warning: what matched, and where. */
export function describeFindings(findings: readonly InjectionFinding[]): string {
  const parts = findings.slice(0, 3).map((finding) => `its ${finding.where}${finding.author === undefined ? '' : ` by ${finding.author}`} ${finding.what} (“${finding.excerpt}”)`);
  const more = findings.length > 3 ? `, and ${findings.length - 3} more` : '';
  return `${parts.join('; ')}${more}`;
}
