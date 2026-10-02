/**
 * The injection screen's patterns, for the studio: what the Injection screen
 * node matches in a test run, and what the builder says about it.
 *
 * This is a copy. The engine's list (`src/unattended/injection.ts` in the CLI)
 * is the one a real run enforces; the studio and the CLI are separate packages,
 * so the rules are restated here and `test/injection.test.ts` fails when the
 * two differ. A test run that refused what a real run would let through, or
 * the other way round, would be the simulator lying about a guardrail.
 *
 * It is a list of patterns and nothing more: text written in words the list
 * does not know passes it. What bounds a hostile issue in a real run is the
 * rest of what an unattended run does — trusted comments only, secret-named
 * variables withheld, reviewers sandboxed read-only, a secret scan before the
 * push, and nothing published past a draft pull request.
 */

export interface InjectionRule {
  id: string;
  /** What the pattern looks for, as a clause that completes "the text …". */
  what: string;
  pattern: RegExp;
}

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

export interface InjectionMatch {
  rule: string;
  what: string;
  /** The matched text, on one line and cut short, with anything invisible spelled out. */
  excerpt: string;
}

function visible(text: string): string {
  return text.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]|[\u{E0000}-\u{E007F}]/gu, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`);
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Every rule a piece of text trips, each once. */
export function screenText(text: string): InjectionMatch[] {
  const matches: InjectionMatch[] = [];
  for (const rule of INJECTION_RULES) {
    const match = rule.pattern.exec(text);
    if (match !== null) matches.push({ rule: rule.id, what: rule.what, excerpt: oneLine(visible(match[0]), 100) });
  }
  return matches;
}
