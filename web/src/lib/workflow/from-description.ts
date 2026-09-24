/**
 * "Describe it": one sentence in, a whole workflow out, with no model behind it.
 *
 * A small, deterministic reader picks out what a coding-agent workflow is made
 * of — what starts it, the guardrails in front of the agents, triage, the
 * pipeline, how far the change goes, and who hears about it — and builds the
 * graph against the live catalog the way the starter templates do: connectors
 * by id, triggers and actions by keyword, handles resolved against real ports.
 * So it runs in the browser, costs nothing, sends nothing anywhere, and what it
 * hands back always validates. Whatever it could not place is handed back too,
 * so the UI can say so instead of guessing quietly.
 */
import { nanoid } from 'nanoid';
import type { Brand } from '../brand';
import { CONNECTORS, defaultConfig, getConnector, getNodeType, nodeTypeId, pickAction, pickTrigger, type ActionSpec, type Connector, type FieldSpec, type NodeKind, type NodeTypeDef, type PortType } from '../connectors';
import { isUnattendedTrigger, portsCompatible, validateWorkflow } from './validate';
import type { Workflow, WorkflowEdge, WorkflowNode } from './schema';

export interface DescribedStep {
  kind: 'trigger' | 'guardrail' | 'logic' | 'pipeline' | 'delivery' | 'notify' | 'action';
  /** What the reader made of it, e.g. "Linear · Issue assigned to @relay-bot". */
  label: string;
  typeId: string;
}

export interface DescriptionResult {
  workflow: Workflow;
  /** One per node, main line first, then its branches. */
  steps: DescribedStep[];
  /** Phrases we could not map, for a gentle hint. */
  unmatched: string[];
  /** Decisions taken on the writer's behalf: a default budget, a merge capped at a pull request. */
  notes: string[];
  /** 0..1: how much of the sentence was understood. */
  confidence: number;
}

/** Sentences that read well and, between them, touch every part of the reader. */
export const DESCRIPTION_EXAMPLES: string[] = [
  'When a GitHub issue is labelled bug, fix it under $5 and open a draft PR, then tell Slack #eng.',
  'When a Linear issue is assigned to the bot, have Claude plan and Codex implement with a thorough review, then comment on the issue.',
  "When Sentry reports a new error in production, triage it: if it's a regression, quick-fix it with Codex and open a draft PR; otherwise open a Linear ticket.",
  'Every weeknight at 2am, upgrade our dependencies with a budget of $20 a day and push a branch.',
  'When a Zendesk ticket is tagged bug, wait for my approval in Slack, then fix it carefully with Claude, open a PR and reply to the customer.',
  'When CI fails on main, have Codex fix it under $3 a run, at most one at a time, and post to #builds.',
];

/* ------------------------------------------------------------------ */
/* The sentence, and what has been understood of it                    */
/* ------------------------------------------------------------------ */

type Span = [number, number];

/** Commas, "then" and arrows separate the steps of a sentence. */
const CLAUSE_BREAK = /[,;!?\n→]|:(?=\s)|\.(?=\s|$)|\s(?:then|and then|but)\s/g;
/** "Otherwise …" runs to the end of its sentence, commas included. */
const SENTENCE_BREAK = /[;!?\n]|\.(?=\s|$)|,\s*then\s/g;

class Reader {
  readonly text: string;
  readonly low: string;
  private readonly used: Uint8Array;

  constructor(text: string) {
    this.text = text;
    this.low = lowerKeepingLength(text);
    this.used = new Uint8Array(text.length);
  }

  get length(): number {
    return this.text.length;
  }

  isFree(start: number, end: number): boolean {
    for (let index = start; index < end; index++) if (this.used[index] === 1) return false;
    return true;
  }

  isUsed(index: number): boolean {
    return this.used[index] === 1;
  }

  take(start: number, end: number): void {
    if (end > start) this.used.fill(1, Math.max(0, start), Math.min(this.text.length, end));
  }

  takeMatch(match: RegExpExecArray | undefined): void {
    if (match !== undefined) this.take(match.index, match.index + match[0].length);
  }

  /** Every match of `pattern` inside [from, to) that overlaps nothing already understood. */
  find(pattern: RegExp, from = 0, to = this.text.length): RegExpExecArray[] {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    const out: RegExpExecArray[] = [];
    re.lastIndex = from;
    let match: RegExpExecArray | null;
    while ((match = re.exec(this.low)) !== null && match.index < to) {
      const end = match.index + match[0].length;
      // A word glued on with "-", ":" or "/" is part of something else: "triage" in the label "needs-triage".
      const glued = match.index > 0 && /[a-z0-9]/.test(this.low[match.index]!) && /[-:/.@_]/.test(this.low[match.index - 1]!);
      if (match[0].length === 0 || end > to || glued || !this.isFree(match.index, end)) {
        re.lastIndex = match.index + 1;
        continue;
      }
      out.push(match);
      re.lastIndex = end;
    }
    return out;
  }

  first(pattern: RegExp, from?: number, to?: number): RegExpExecArray | undefined {
    return this.find(pattern, from, to)[0];
  }

  /** `pattern` matched exactly at `at`, if nothing there is understood yet. */
  at(pattern: RegExp, at: number): RegExpExecArray | undefined {
    const re = new RegExp(pattern.source, 'y');
    re.lastIndex = at;
    const match = re.exec(this.low);
    return match !== null && match[0].length > 0 && this.isFree(match.index, match.index + match[0].length) ? match : undefined;
  }

  /** A capture group in its original case, and where it sits. */
  group(match: RegExpExecArray, index: number): { value: string; start: number; end: number } | undefined {
    const captured = match[index];
    if (captured === undefined || captured === '') return undefined;
    const start = match.index + Math.max(0, match[0].lastIndexOf(captured));
    return { value: this.text.slice(start, start + captured.length), start, end: start + captured.length };
  }

  slice(start: number, end: number): string {
    return this.text.slice(start, end);
  }

  clause(at: number, breaks: RegExp = CLAUSE_BREAK): Span {
    const re = new RegExp(breaks.source, 'g');
    let start = 0;
    let end = this.text.length;
    let match: RegExpExecArray | null;
    while ((match = re.exec(this.low)) !== null) {
      if (match[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const stop = match.index + match[0].length;
      if (stop <= at) start = stop;
      else if (match.index >= at) {
        end = match.index;
        break;
      }
    }
    return [start, end];
  }

  /** Where the first already-understood character after `start` is, or `limit`. */
  nextUsed(start: number, limit: number): number {
    for (let index = start; index < limit; index++) if (this.used[index] === 1) return index;
    return limit;
  }
}

function lowerKeepingLength(text: string): string {
  let out = '';
  for (const char of text) {
    const lower = char.toLowerCase();
    out += lower.length === char.length ? lower : char;
  }
  return out;
}

/** Same length in, same length out, so every offset still points at the original text. */
function normalize(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/->/g, ' →').replace(/\t/g, ' ');
}

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, single: 1, 'a single': 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, 'forty-five': 45, sixty: 60 };

function toNumber(word: string | undefined): number | undefined {
  if (word === undefined) return undefined;
  const value = Number(word);
  if (Number.isFinite(value)) return value;
  return NUMBER_WORDS[word.trim()];
}

/* ------------------------------------------------------------------ */
/* Apps, by name                                                       */
/* ------------------------------------------------------------------ */

interface Mention {
  connectorId: string;
  start: number;
  end: number;
}

/** App names that are also everyday words: only the capitalised name counts. */
const EVERYDAY = new Set([
  'amplitude', 'apollo', 'axiom', 'box', 'canny', 'chromatic', 'clerk', 'coda', 'confluence', 'contentful', 'crisp', 'fireflies', 'framer', 'front', 'ghost', 'granola', 'height', 'honeycomb',
  'intercom', 'loom', 'loops', 'mux', 'neon', 'notion', 'obsidian', 'outlook', 'paddle', 'payload', 'percy', 'plain', 'plane', 'plausible', 'postman', 'postmark', 'railway', 'render', 'resend',
  'sanity', 'segment', 'shortcut', 'sketch', 'snowflake', 'socket', 'storybook', 'stripe', 'tally', 'things', 'threads', 'twist', 'twitch', 'unleash', 'warp', 'zoom',
]);
/** Never read as an app: the coding agents are roles in the pipeline, not apps to connect. */
const NOT_APPS = new Set(['claude-code', 'codex-cli', 'gemini-cli', 'aider', 'anthropic-api', 'openai-api', 'cursor', 'github-copilot', 'ollama', 'x', 'monday', 'terminal']);
const EXTRA_ALIASES: Array<[string, string, string?]> = [
  ['github-issues', 'github issue'],
  ['github-issues', 'gh issue'],
  ['microsoft-teams', 'ms teams'],
  ['microsoft-teams', 'teams', 'Teams'],
  ['x', 'twitter'],
  ['monday', 'monday.com'],
  ['pagerduty', 'pager duty'],
  ['app-store-connect', 'app store'],
  ['google-play-console', 'play store'],
  ['github-actions', 'gh actions'],
];
const PLURAL_TAILS = new Set(['issues', 'actions', 'docs', 'notes', 'forms', 'tasks', 'reminders', 'teams']);

interface Alias {
  connectorId: string;
  phrase: string;
  exact?: string;
}

let aliasCache: Alias[] | undefined;

function aliases(): Alias[] {
  if (aliasCache !== undefined) return aliasCache;
  const list: Alias[] = [];
  const add = (connectorId: string, phrase: string, exact?: string) => {
    const lower = phrase.trim().toLowerCase();
    if (lower.length < 2 || list.some((alias) => alias.phrase === lower)) return;
    list.push({ connectorId, phrase: lower, ...(exact === undefined ? {} : { exact: exact.trim() }) });
  };
  for (const connector of CONNECTORS) {
    if (connector.category === 'core' || NOT_APPS.has(connector.id)) continue;
    const everyday = EVERYDAY.has(connector.id);
    for (const name of connector.name.replace(/\([^)]*\)/g, ' ').split('/').map((part) => part.trim()).filter(Boolean)) {
      add(connector.id, name, everyday ? name : undefined);
      const words = name.toLowerCase().split(/\s+/);
      if (words.length > 1 && PLURAL_TAILS.has(words[words.length - 1]!)) add(connector.id, name.slice(0, -1), everyday ? name.slice(0, -1) : undefined);
    }
    const fromId = connector.id.replace(/-/g, ' ');
    if (!everyday && fromId.split(' ').every((word) => word.length > 2)) add(connector.id, fromId);
  }
  for (const [connectorId, phrase, exact] of EXTRA_ALIASES) if (getConnector(connectorId) !== undefined) add(connectorId, phrase, exact);
  // Longest first, so "GitHub Issues" wins over "GitHub" and "Google Chat" over nothing at all.
  aliasCache = list.sort((a, b) => b.phrase.length - a.phrase.length);
  return aliasCache;
}

function findMentions(reader: Reader): Mention[] {
  const found: Mention[] = [];
  const taken = new Uint8Array(reader.length);
  for (const alias of aliases()) {
    let from = 0;
    for (;;) {
      const at = reader.low.indexOf(alias.phrase, from);
      if (at < 0) break;
      from = at + 1;
      const end = at + alias.phrase.length;
      if (at > 0 && /[a-z0-9_@#/.-]/.test(reader.low[at - 1]!)) continue;
      if (end < reader.length && /[a-z0-9_-]/.test(reader.low[end]!)) continue;
      if (alias.exact !== undefined && reader.slice(at, end) !== alias.exact) continue;
      if (taken.subarray(at, end).some((value) => value === 1)) continue;
      taken.fill(1, at, end);
      found.push({ connectorId: alias.connectorId, start: at, end });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/* ------------------------------------------------------------------ */
/* Catalog lookups                                                     */
/* ------------------------------------------------------------------ */

/** Like `pickTrigger` / `pickAction`, but says "nothing" instead of falling back to the first spec. */
function strictPick<T extends { id: string; name: string }>(specs: T[], keywords: string[]): T | undefined {
  for (const keyword of keywords) {
    const needle = keyword.toLowerCase();
    const hit = specs.find((spec) => spec.id.includes(needle) || spec.name.toLowerCase().includes(needle));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** A core node by connector id and keyword, the way the templates ask for one. */
function coreNode(connectorId: string, kind: NodeKind, keywords: string[]): NodeTypeDef | undefined {
  const connector = getConnector(connectorId);
  if (connector === undefined) return undefined;
  const spec = kind === 'trigger' ? pickTrigger(connector, keywords) : pickAction(connector, keywords);
  return spec === undefined ? undefined : getNodeType(nodeTypeId(connectorId, kind, spec.id));
}

function actionDef(connector: Connector, spec: ActionSpec): NodeTypeDef | undefined {
  return getNodeType(nodeTypeId(connector.id, 'action', spec.id));
}

/** An action of `connector` whose input takes what `from` produces, by keyword; `fallback` allows any action that fits. */
function actionFor(connector: Connector, keywords: string[], from: PortType, fallback: boolean): NodeTypeDef | undefined {
  const fits = connector.actions.filter((spec) => (spec.inputs ?? []).some((port) => portsCompatible(from, port.type)));
  const hit = strictPick(fits, keywords) ?? (fallback ? (strictPick(fits, ['post', 'send', 'message']) ?? fits[0]) : undefined);
  return hit === undefined ? undefined : actionDef(connector, hit);
}

function hasField(def: NodeTypeDef, key: string): boolean {
  return def.fields.some((field) => field.key === key);
}

/* ------------------------------------------------------------------ */
/* What the sentence asks for                                          */
/* ------------------------------------------------------------------ */

type Agent = 'claude' | 'codex' | 'gemini' | 'aider';
type Role = 'planner' | 'planReviewer' | 'implementer' | 'codeReviewer';
type Policy = 'none' | 'branch' | 'push' | 'pr' | 'merge';
type Branch = 'main' | 'false' | 'refused';

interface TriggerRead {
  def: NodeTypeDef;
  config: Record<string, unknown>;
  /** Somebody asked for this trigger, rather than it being the manual default. */
  explicit: boolean;
  /** "Linear issue", "Weeknights at 02:00": the first half of the workflow's name. */
  short: string;
  /** The step label, configuration included where it helps. */
  label: string;
  /** Where the trigger was described, so later readers leave that part alone. */
  zone?: Span;
}

interface BudgetRead {
  run?: number;
  day?: number;
  from?: string;
}

interface TriageRead {
  /** Whether a model classifies first, or the condition reads a field straight off the ticket. */
  ai: boolean;
  category: string;
  prompt: string;
  left: string;
  op: string;
  right: string;
  /** The clause it was said in: a ticket filed in the same breath belongs on the main line. */
  clause: Span;
}

interface OutputRead {
  role: 'ticket' | 'notify' | 'comment' | 'reply' | 'label' | 'action';
  connectorId: string;
  branch: Branch;
  keywords: string[];
  channel?: string;
  to?: string;
  user?: string;
  dm?: boolean;
  label?: string;
  at: number;
}

const WHEN = /\b(?:when(?:ever)?|each time|every time|any ?time|as soon as|once (?:a|an|new|someone|somebody)|on (?:every|each|a|an|new|any)|for (?:every|each|any|new)|if (?:a|an|new|someone|somebody|anyone))\b/g;

/** Event words, most specific first; the first family the trigger app has a spec for wins. */
const EVENTS: Array<[RegExp, string[]]> = [
  [/\b(?:label(?:l)?ed|labels?|tagged|tags?)\b/g, ['label', 'tag']],
  [/\bassign(?:ed|s)?\b|\bgiven to\b|\bowner (?:is )?set\b/g, ['assign', 'owner', 'member']],
  [/\bregress(?:ed|es|ion|ions)?\b/g, ['regress']],
  [/\bmention(?:ed|s)?\b|\b@-?mentions?\b/g, ['mention']],
  [/\b(?:moved?|moves|transitioned|transitions)\b|\b(?:state|status) (?:changes?|changed)\b/g, ['state', 'status', 'transition', 'moved', 'section']],
  [/\bfail(?:s|ed|ing|ures?)?\b|\bbreaks?\b|\bbroke(?:n)?\b|\bgoes red\b|\bturns red\b/g, ['fail']],
  [/\balert(?:s|ed)?\b|\bfires?\b|\bfired\b|\bmonitors?\b/g, ['alert', 'monitor', 'incident']],
  [/\bincidents?\b|\bpaged?\b/g, ['incident']],
  [/\bescalat(?:ed|es|ion)\b/g, ['escalat']],
  [/\breact(?:s|ed|ions?)?\b|\bemoji\b/g, ['reaction']],
  [/\breview(?:s)? (?:is )?requested\b|\brequests? (?:a )?review\b/g, ['review']],
  [/\b(?:pull requests?|prs?|merge requests?)\b/g, ['pr-', 'mr-', 'pull', 'patch']],
  [/\bpush(?:es|ed)?\b/g, ['push']],
  [/\breleas(?:e|es|ed)\b|\bpublish(?:ed|es)?\b/g, ['release', 'publish']],
  [/\bcomment(?:s|ed)?\b|\brepl(?:y|ies|ied)\b/g, ['comment', 'note', 'reply']],
  [/\b(?:closed|solved|resolved|completed|recovered)\b/g, ['closed', 'solved', 'resolved', 'completed', 'recovered']],
  [/\bmessages?\b|\bposted\b/g, ['message', 'posted']],
  [/\b(?:new|created|opens?|opened|filed|reports?|reported|submitted|raised|comes? in|arrives?|received|started|appears?|shows up|triggered|fires?|errors?|exceptions?|crash(?:es)?)\b/g, ['created', 'opened', 'new', 'received', 'triggered', 'submitted', 'started']],
];
/** The generic "it happened" family: always part of the trigger phrase, whichever event was picked. */
const HAPPENED = EVENTS[EVENTS.length - 1]![0];
const LABEL_VALUE = '[a-z0-9][\\w:/-]*(?:\\.[\\w:/-]+)*';

/** Nouns that make a bare app mention sound like the thing that starts a workflow. */
const TRIGGER_NOUN = /\s*(?:'s\s+)?(?:[a-z-]+\s+)?(?:issues?|tickets?|errors?|exceptions?|alerts?|incidents?|messages?|e-?mails?|prs?|pull requests?|tasks?|cards?|stor(?:y|ies)|crash(?:es)?|conversations?|comments?|mentions?|reports?|failures?|events?|monitors?|regressions?|builds?|deploys?|deployments?|submissions?|responses?|posts?)\b/;

const TASK_VERBS = 'fix|add|update|upgrade|bump|refactor|migrate|remove|delete|rename|implement|build|write|improve|optimi[sz]e|clean up|speed up|port|convert|document|translate|replace|investigate|debug|support|change|split|extract|drop|deprecate|enable|disable|increase|decrease|reduce|harden|patch|audit|rewrite|tidy|regenerate|triage';
const TASK = new RegExp(
  `(?:^|[,;:.]\\s*|\\b(?:then|and|to|please)\\s+)(?:please\\s+|let'?s\\s+|go\\s+|we\\s+(?:need|want)\\s+to\\s+|i\\s+want\\s+(?:you\\s+)?to\\s+)?((?:${TASK_VERBS})\\b(?!\\s+(?:it|them|this|that|those|these|things|stuff|everything|the (?:issue|ticket|error|bug|problem|failure|alert|incident|card|task|story|build|rest)s?)\\b))`,
  'g',
);
const TASK_CUT = /\s(?:with|using|via)\s+(?:claude|codex|gemini|aider)\b|\s(?:and|then)\s+(?:open|raise|create|send|file|tell|ping|notify|post|message|email|comment|commit|push|merge|deliver|ship|ask|request|put|leave|reply|run)\b|\s(?:under|below|within|for less than|for under)\s+\$|\s(?:as|in|into)\s+a\s+(?:draft|pr\b|pull|branch)|\s(?:quickly|carefully|thoroughly|fast)\b|\s(?:no|without|skip)\s+(?:reviews?|tests?)|\s(?:after|once|only|if|unless|when|whenever|every|each|nightly|daily)\s/g;

const AGENT = '(claude(?:\\s+code)?|codex(?:\\s+cli)?|gemini(?:\\s+cli)?|aider|gpt(?:-?5)?|openai)';
const AGENT_WORDS = new Set(['claude', 'codex', 'gemini', 'aider', 'gpt', 'gpt5', 'gpt-5', 'openai']);
const AGENT_NAMES: Record<Agent, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', aider: 'Aider' };

/** Role patterns, most specific first: "Codex reviews the plan" before "Codex reviews". */
const ROLE_PATTERNS: Array<[RegExp, Role[] | 'all' | 'generic' | 'bare']> = [
  [new RegExp(`\\b(?:only|just|all|entirely(?:\\s+with)?|everything(?:\\s+with|\\s+by)?)\\s+${AGENT}\\b|\\b${AGENT}\\s+(?:only|for everything|does everything|all the way|end to end)\\b`, 'g'), 'all'],
  [new RegExp(`\\b${AGENT}\\s+(?:reviews?|checks?)\\s+the\\s+plans?\\b|\\bplans?\\s+(?:is\\s+|are\\s+)?review(?:ed|s)?\\s+(?:by|with)\\s+${AGENT}\\b|\\bplan[- ]reviewer:?\\s+${AGENT}\\b`, 'g'), ['planReviewer']],
  [new RegExp(`\\b${AGENT}\\s+(?:reviews?|checks?)\\s+(?:the\\s+)?(?:code|diff|changes?|pr|pull request|implementation|work)\\b|\\bcode\\s+(?:is\\s+)?review(?:ed|s)?\\s+(?:by|with)\\s+${AGENT}\\b|\\bcode[- ]reviewer:?\\s+${AGENT}\\b`, 'g'), ['codeReviewer']],
  [new RegExp(`\\b${AGENT}\\s+(?:to\\s+)?(?:plans?|planning|writes the plan|does the planning|makes the plan)\\b|\\bplan(?:ned|ning|s)?\\s+(?:by|with|using)\\s+${AGENT}\\b|\\bplanner:?\\s+${AGENT}\\b`, 'g'), ['planner']],
  [new RegExp(`\\b${AGENT}\\s+(?:to\\s+)?(?:reviews?|reviewing|does (?:the )?reviews?|as (?:the )?reviewer)\\b|\\breview(?:ed|s)?\\s+(?:by|with|using)\\s+${AGENT}\\b|\\breviewer:?\\s+${AGENT}\\b`, 'g'), ['planReviewer', 'codeReviewer']],
  [new RegExp(`\\b${AGENT}\\s+(?:to\\s+)?(?:implements?|implementing|codes|writes (?:the )?code|does the (?:work|coding|implementation|fix)|fix(?:es)?|builds?)\\b|\\bimplement(?:ed|s|ation)?\\s+(?:by|with|using)\\s+${AGENT}\\b|\\b(?:coded|written|fixed|built)\\s+by\\s+${AGENT}\\b|\\bimplementer:?\\s+${AGENT}\\b`, 'g'), ['implementer']],
  [new RegExp(`\\b(?:with|using|via|by|through|have|let|ask|get|in)\\s+${AGENT}\\b|\\b${AGENT}\\s+(?:does|do|handles?|takes?)\\s+(?:it|them|the work)\\b`, 'g'), 'generic'],
  [new RegExp(`\\b${AGENT}\\b`, 'g'), 'bare'],
];

function agentOf(word: string): Agent {
  if (word.startsWith('claude')) return 'claude';
  if (word.startsWith('gemini')) return 'gemini';
  if (word.startsWith('aider')) return 'aider';
  return 'codex';
}

interface PipelineRead {
  fast: boolean;
  review: 'light' | 'standard' | 'thorough';
  roles: Partial<Record<Role, Agent>>;
  /** "with Claude": the agent doing the work, whichever pipeline that ends up being. */
  worker?: Agent;
  runTests: boolean;
  baseBranch?: string;
  testCommand?: string;
}

interface DeliveryRead {
  policy: Policy;
  draft: boolean;
  reviewers?: string;
  labels?: string;
}

/** Triage words and what the model is asked, so the condition can test for the answer. */
const CATEGORIES: Array<{ words: string[]; right: string; prompt: string }> = [
  { words: ['bug', 'bugs', 'real bug'], right: 'bug', prompt: 'Classify this as bug, feature or chore, and say why in one line.' },
  { words: ['regression', 'regressions'], right: 'regression', prompt: 'Is this a regression from the last release? Answer regression or other, then one line of reasoning.' },
  { words: ['small', 'tiny', 'trivial', 'easy', 'simple', 'quick win', 'small one', 'small ones', 'small fix', 'small fixes'], right: 'small', prompt: 'Estimate the size of this ticket as small, medium or large. Small means under an hour for one engineer.' },
  { words: ['typo', 'typos'], right: 'typo', prompt: 'Is this a typo or copy fix? Answer typo or other.' },
  { words: ['crash', 'crashes'], right: 'crash', prompt: 'Is this a crash? Answer crash or other, then one line of reasoning.' },
  { words: ['security issue', 'security bug', 'security problem', 'security', 'vulnerability'], right: 'security', prompt: 'Is this a security issue? Answer security or other, then one line of reasoning.' },
  { words: ['feature', 'features', 'feature request', 'feature requests'], right: 'feature', prompt: 'Classify this as bug, feature or chore, and say why in one line.' },
  { words: ['chore', 'chores'], right: 'chore', prompt: 'Classify this as bug, feature or chore, and say why in one line.' },
  { words: ['docs', 'documentation', 'docs issue', 'docs change'], right: 'docs', prompt: 'Is this a documentation change? Answer docs or other.' },
  { words: ['flaky test', 'flaky tests', 'flake', 'flaky'], right: 'flaky', prompt: 'Is this about a flaky test? Answer flaky or other.' },
  { words: ['urgent'], right: 'urgent', prompt: 'Is this urgent? Answer urgent or other, then one line of reasoning.' },
  { words: ['dependency update', 'dependency', 'dependencies'], right: 'dependency', prompt: 'Is this a dependency update? Answer dependency or other.' },
  { words: ['performance issue', 'performance', 'perf issue'], right: 'performance', prompt: 'Is this a performance problem? Answer performance or other.' },
  { words: ['good first issue'], right: 'good first issue', prompt: 'Would this make a good first issue: small, well specified, low risk? Answer good first issue or other.' },
];
const CATEGORY_WORDS = CATEGORIES.flatMap((category) => category.words).sort((a, b) => b.length - a.length);
const CATEGORY_ALT = CATEGORY_WORDS.map((word) => word.replace(/ /g, '\\s+')).join('|');
const CATEGORY_PLURALS = 'bugs|regressions|crashes|typos|small (?:ones|issues|tickets|fixes)|features|chores|security issues|docs changes';

function categoryFor(word: string): { right: string; prompt: string } {
  const clean = word.toLowerCase().replace(/\s+/g, ' ').trim();
  return CATEGORIES.find((category) => category.words.includes(clean)) ?? { right: clean, prompt: `Is this ${clean}? Answer ${clean} or other, then one line of reasoning.` };
}

const NAME_STOP = new Set([
  'then', 'with', 'under', 'below', 'if', 'when', 'whenever', 'who', 'that', 'which', 'in', 'on', 'to', 'a', 'an', 'it', 'its', 'run', 'runs', 'open', 'opens', 'create', 'fix', 'fixes', 'deliver',
  'tell', 'ping', 'post', 'email', 'notify', 'comment', 'but', 'so', 'only', 'using', 'via', 'at', 'for', 'of', 'after', 'before', 'once', 'until', 'while', 'where', 'we', 'i', 'us', 'you', 'they',
  'is', 'are', 'was', 'be', 'can', 'may', 'should', 'will', 'people', 'users', 'members', 'folks', 'anyone', 'everyone', 'let', 'have', 'has', 'get', 'gets', 'do', 'does', 'draft', 'pr', 'pull',
  'merge', 'push', 'commit', 'budget', 'approval', 'not', 'no', 'every', 'each', 'other', 'others', 'repo', 'repository', 'org', 'quick', 'quickly', 'carefully', 'thoroughly', 'fast', 'ask',
  'wait', 'review', 'reviews', 'the', 'and', 'or', 'plus',
]);
const GROUP_WORDS = new Set(['maintainers', 'admins', 'collaborators', 'core', 'staff', 'owners', 'committers', 'employees']);
const TRIAGE_WORDS = new Set(CATEGORY_WORDS.flatMap((word) => word.split(' ')));

/* ------------------------------------------------------------------ */
/* Readers, in the order they claim words                              */
/* ------------------------------------------------------------------ */

const MONEY = /(?:\b(?:with|and|on)\s+)?(?:\b(?:a|an|the|my|our)\s+)?(?:\b(daily|nightly|weekly|monthly|per[- ]run|per[- ]day)\s+)?(?:\b(?:budget|cap|limit|ceiling|spend(?:ing)?|max(?:imum)?|costs?)\s+(?:of\s+|at\s+|is\s+|to\s+)?)?(?:\b(?:stay(?:s|ing)?|keep(?:ing)? (?:it|costs?|spend(?:ing)?)|costing)\s+)?(?:\b(?:under|below|less than|at most|no more than|not more than|max(?:imum)?(?: of)?|up to|within|capped at|cap(?:ped)? at|for under|for less than)\s+)?(?:\$\s?(\d+(?:\.\d+)?)(k)?|\b(\d+(?:\.\d+)?)(k)?\s?(?:usd|dollars?|bucks)\b)(?:\s*(?:(?:per|a|an|each|every|\/)\s*(run|day|night|week|month|ticket|issue|task|job|fix|pr|attempt)s?\b|\s(daily|nightly|weekly|monthly)\b))?(?:\s+(?:max(?:imum)?|cap|limit|budget|ceiling|tops))?/g;

function readBudget(reader: Reader): BudgetRead | undefined {
  let budget: BudgetRead | undefined;
  for (const match of reader.find(MONEY)) {
    const amount = Number(match[2] ?? match[4]) * ((match[3] ?? match[5]) === undefined ? 1 : 1000);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    reader.takeMatch(match);
    let unit = (match[1] ?? match[6] ?? match[7] ?? '').replace(/[- ]/g, '');
    if (unit === '') {
      const before = reader.low.slice(Math.max(0, match.index - 30), match.index);
      unit = /\b(?:daily|per day|a day)\b/.test(before) ? 'day' : 'run';
    }
    budget ??= {};
    if (/day|daily|night/.test(unit)) budget.day = amount;
    else if (/week/.test(unit)) {
      budget.day = Math.max(1, Math.round(amount / 7));
      budget.from = `$${amount}/week`;
    } else if (/month/.test(unit)) {
      budget.day = Math.max(1, Math.round(amount / 30));
      budget.from = `$${amount}/month`;
    } else budget.run = amount;
  }
  const word = reader.first(/\b(?:(?:a|an|with a|with an|with)\s+)?(?:daily\s+|spending\s+)?budget(?:[- ](?:gate|capped|cap|limit))?\b|\b(?:cost|spend)[- ]capped\b|\bspending (?:cap|limit)\b/g);
  if (word !== undefined) {
    reader.takeMatch(word);
    budget ??= {};
  }
  const cheap = reader.first(/\b(?:cheap(?:ly)?|on a (?:tight )?budget|on a shoestring|frugal(?:ly)?|keep (?:it|costs?) (?:cheap|low|down))\b/g);
  if (cheap !== undefined) {
    reader.takeMatch(cheap);
    budget ??= {};
    budget.run ??= 2;
    budget.day ??= 10;
  }
  return budget;
}

function readTrigger(reader: Reader, mentions: Mention[], brand: Brand): TriggerRead {
  const canStart = (mention: Mention) => (getConnector(mention.connectorId)?.triggers.length ?? 0) > 0;

  // 1. "When …": the app named in that clause is what starts the workflow.
  for (const when of reader.find(WHEN)) {
    const zone: Span = [when.index, reader.clause(when.index + when[0].length)[1]];
    const mention = mentions.find((candidate) => candidate.start >= zone[0] && candidate.end <= zone[1] && canStart(candidate) && reader.isFree(candidate.start, candidate.end));
    const app = mention === undefined ? implicitApp(reader, zone) : { connectorId: mention.connectorId, span: [mention.start, mention.end] as Span };
    if (app === undefined) continue;
    reader.takeMatch(when);
    return appTrigger(reader, app.connectorId, app.span, zone, brand);
  }

  // 2. A time: "every weeknight at 2am", "hourly".
  const schedule = readSchedule(reader);
  if (schedule !== undefined) return schedule;

  // 3. A webhook.
  const webhook = reader.first(/\b(?:(?:on|from|via|through)\s+(?:a|an|the|any)\s+)?(?:(?:incoming|inbound)\s+)?(?:web ?hooks?|http (?:posts?|requests?|calls?)|api calls?)\b(?:\s+(?:fires?|arrives?|comes in|is received|hits))?|\bposts? to (?:a |an |our )?(?:url|endpoint)\b/g);
  const webhookDef = webhook === undefined ? undefined : coreNode('http', 'trigger', ['webhook']);
  if (webhook !== undefined && webhookDef !== undefined) {
    reader.takeMatch(webhook);
    return { def: webhookDef, config: defaultConfig(webhookDef), explicit: true, short: 'Webhook', label: `${webhookDef.connector.name} · ${webhookDef.name}` };
  }

  // 4. No "when": the first clause may still name the app, as in "New Sentry errors get a quick fix".
  const zone: Span = [0, reader.clause(0)[1]];
  const mention = mentions.find((candidate) => {
    if (candidate.start < zone[0] || candidate.end > zone[1] || !canStart(candidate) || !reader.isFree(candidate.start, candidate.end)) return false;
    const before = reader.low.slice(Math.max(0, candidate.start - 14), candidate.start);
    // "Fix the Slack notification bug" names an app as the thing to change, not as what starts the work.
    if (/\b(?:the|our|my|a|an|this|that)\s+$/.test(before)) return false;
    return reader.at(TRIGGER_NOUN, candidate.end) !== undefined || /\b(?:new|every|each|incoming|all|any)\s+$/.test(before);
  });
  if (mention !== undefined) return appTrigger(reader, mention.connectorId, [mention.start, mention.end], zone, brand);

  // 5. By hand, said or not.
  const manual = coreNode('logic', 'trigger', ['manual'])!;
  const said = reader.first(/\b(?:manual(?:ly)?|by hand|on demand|when i (?:click|press|hit|run|start|trigger|say)(?: (?:it|run|go|the button))?|from the (?:cli|dashboard|terminal|command line)|i(?:'ll| will)? (?:start|run|trigger) it(?: myself)?|(?:with |from )?a button)\b/g);
  for (const more of reader.find(/\b(?:manual(?:ly)?|by hand|on demand|myself)\b/g)) reader.takeMatch(more);
  reader.takeMatch(said);
  return { def: manual, config: defaultConfig(manual), explicit: said !== undefined, short: 'Manual run', label: 'Manual start' };
}

/** "When a PR is opened" names no app, but only one thing in this product opens pull requests. */
function implicitApp(reader: Reader, zone: Span): { connectorId: string; span: Span } | undefined {
  const rules: Array<[RegExp, string]> = [
    [/\b(?:ci|the build|a build|builds|nightly build|the tests|tests|test suite|checks|a check|workflow run)\b(?=[^,.;]*\b(?:fail|fails|failed|failing|break|breaks|broke|broken|red)\b)/g, 'github-actions'],
    // "When a PR is opened", not the "open a PR" that says how to deliver.
    [/\b(?:pull requests?|prs?)\s+(?:is\s+|are\s+|gets?\s+)?(?:opened|created|updated|merged|submitted)\b|\b(?:someone|somebody|anyone|a contributor|a user|renovate)\s+(?:opens|creates|raises|submits)\s+(?:a|an)\s+(?:pull request|pr)\b|\bnew (?:pull requests?|prs?)\b/g, 'github'],
    [/\b(?:issues?|tickets?)\b(?=[^,.;]*\b(?:label|labell?ed|tagged|assigned|opened|created|filed|new|comment|comments|commented|closed)\b)|\b(?:new|an?)\s+(?:issues?|tickets?)\b/g, 'github-issues'],
    [/\b(?:e-?mails?|mail)\b(?=[^,.;]*\b(?:arrives?|received|comes in|new|lands?)\b)|\bnew e-?mails?\b/g, 'gmail'],
  ];
  for (const [pattern, connectorId] of rules) {
    const match = reader.first(pattern, zone[0], zone[1]);
    if (match !== undefined && getConnector(connectorId) !== undefined) return { connectorId, span: [match.index, match.index + match[0].length] };
  }
  return undefined;
}

function appTrigger(reader: Reader, connectorId: string, span: Span, zone: Span, brand: Brand): TriggerRead {
  const zoneLow = reader.low.slice(zone[0], zone[1]);
  let connector = getConnector(connectorId)!;
  // "a GitHub issue" is GitHub Issues; "a GitHub pull request" stays GitHub.
  if (connector.id === 'github' && /\b(?:issues?|labels?|labell?ed|assigned|tickets?)\b/.test(zoneLow) && !/\b(?:pull requests?|prs?|push(?:es|ed)?|releases?|review)\b/.test(zoneLow)) {
    connector = getConnector('github-issues') ?? connector;
  }
  reader.take(span[0], span[1]);
  // "a Linear issue", "Sentry errors": the noun right after the app is part of the trigger too.
  reader.takeMatch(reader.at(TRIGGER_NOUN, span[1]));

  // Decide the event first and claim its words last: "labelled bug" has to
  // stay readable until the label itself has been captured.
  const families = EVENTS.map(([pattern, keywords]) => ({ hits: reader.find(pattern, zone[0], zone[1]), keywords, pattern }));
  const spec =
    families.map((family) => (family.hits.length === 0 ? undefined : strictPick(connector.triggers, family.keywords))).find((found) => found !== undefined) ??
    connector.triggers.find((trigger) => (trigger.outputs ?? []).some((port) => port.type === 'issue')) ??
    pickTrigger(connector, [])!;
  const def = getNodeType(nodeTypeId(connector.id, 'trigger', spec.id))!;
  const config = defaultConfig(def);
  const captured = captureTriggerFields(reader, zone);
  for (const family of families) {
    if (family.pattern !== HAPPENED && strictPick(connector.triggers, family.keywords) !== spec) continue;
    for (const hit of family.hits) if (reader.isFree(hit.index, hit.index + hit[0].length)) reader.takeMatch(hit);
  }
  const bot = `@${brand.slug}-bot`;
  const details: string[] = [];
  const set = (keys: string[], value: string | undefined, detail?: (value: string) => string) => {
    if (value === undefined) return;
    const key = keys.find((candidate) => hasField(def, candidate));
    if (key === undefined) return;
    config[key] = value;
    if (detail !== undefined) details.push(detail(value));
  };
  const isLabel = /label|tag/.test(def.specId);
  const isAssign = /assign|owner|member/.test(def.specId);
  set(['label', 'tag'], captured.label ?? (isLabel ? `${brand.slug}:go` : undefined), (value) => `: ${value}`);
  set(['assignee'], captured.assignee ?? (isAssign ? bot : undefined), (value) => ` to ${value}`);
  set(['mention'], captured.mention ?? (/mention|comment/.test(def.specId) && /\bmention/.test(zoneLow) ? bot : undefined), (value) => ` ${value}`);
  set(['state', 'status', 'section', 'list'], captured.state, (value) => ` → ${value}`);
  set(['environment'], captured.environment, (value) => ` in ${value}`);
  set(['channel'], captured.channel, (value) => ` in ${value}`);
  set(['branch'], captured.branch, (value) => ` on ${value}`);
  fillRequired(def, config, { slug: brand.slug });
  return { def, config, explicit: true, short: triggerShort(def), label: `${def.connector.name} · ${def.name}${details.join('')}`, zone };
}

function captureTriggerFields(reader: Reader, zone: Span): { label?: string; assignee?: string; mention?: string; state?: string; environment?: string; channel?: string; branch?: string } {
  const out: ReturnType<typeof captureTriggerFields> = {};
  const [from, to] = zone;
  const grab = (pattern: RegExp, index = 1) => {
    const match = reader.first(pattern, from, to);
    if (match === undefined) return undefined;
    const group = reader.group(match, index);
    if (group === undefined) return undefined;
    reader.takeMatch(match);
    return group.value;
  };
  const label =
    grab(new RegExp(`\\b(?:with|has|gets?|the)\\s+(?:the\\s+|a\\s+)?(?:label|tag)\\s+["'\`]?(${LABEL_VALUE})["'\`]?`, 'g')) ??
    grab(new RegExp(`\\b(?:label(?:l)?ed|tagged)\\s+(?:as\\s+|with\\s+)?(?:the\\s+)?(?:label\\s+|tag\\s+)?["'\`]?(${LABEL_VALUE})["'\`]?`, 'g')) ??
    grab(new RegExp(`["'\`](${LABEL_VALUE})["'\`]\\s+(?:label|tag)\\b`, 'g'));
  if (label !== undefined && !['by', 'as', 'with', 'it', 'and', 'then', 'in', 'on'].includes(label.toLowerCase())) out.label = label;
  const assignee = reader.first(/\bassigned\s+to\s+(?:the\s+|our\s+)?(@?[a-z0-9][\w.-]*)(\s+(?:bot|agent|account|user))?/g, from, to);
  if (assignee !== undefined) {
    const who = (assignee[1] ?? '').replace(/^@/, '');
    const original = reader.group(assignee, 1)?.value.replace(/^@/, '') ?? who;
    reader.takeMatch(assignee);
    out.assignee = assignee[2] !== undefined || ['bot', 'agent', 'ai', 'robot', 'relay'].includes(who) ? undefined : ['me', 'myself'].includes(who) ? '@me' : `@${original}`;
  }
  const mention = grab(/\bmentions?\s+(@[\w.-]+)/g);
  if (mention !== undefined) out.mention = mention;
  const state = reader.first(/\b(?:moved|moves|move|transitioned|transitions)\s+(?:in)?to\s+["']?([a-z][\w-]*(?:\s+[a-z][\w-]*){0,2}?)["']?(?=\s*(?:[,.;:]|$|\s(?:then|and|in|on|with|so)\b))/g, from, to);
  if (state !== undefined) {
    const group = reader.group(state, 1);
    reader.takeMatch(state);
    if (group !== undefined) out.state = group.value.replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
  const environment = reader.first(/\b(?:in|on|from)\s+(production|prod|staging)\b/g, from, to);
  if (environment !== undefined) {
    reader.takeMatch(environment);
    out.environment = environment[1] === 'staging' ? 'staging' : 'production';
  }
  const channel = grab(/\B(#[a-z0-9][\w-]*)/g);
  if (channel !== undefined) out.channel = channel;
  const branch = grab(/\b(?:on|to|in)\s+(?:the\s+)?`?(main|master|develop|dev|staging|trunk|release[\w/.-]*)`?(?:\s+branch)?\b/g);
  if (branch !== undefined) out.branch = branch;
  return out;
}

function triggerShort(def: NodeTypeDef): string {
  const nouns: Array<[RegExp, string]> = [
    [/fail/, 'failure'],
    [/(?:^|-)(?:pr|mr|patch)(?:-|$)|pull/, 'pull request'],
    [/incident/, 'incident'],
    [/alert|monitor/, 'alert'],
    [/ticket/, 'ticket'],
    [/conversation/, 'conversation'],
    [/task/, 'task'],
    [/card/, 'card'],
    [/story/, 'story'],
    [/email|mail/, 'email'],
    [/message|mention|slash/, 'message'],
    [/push/, 'push'],
    [/release/, 'release'],
    [/comment/, 'comment'],
    [/issue|work-item/, 'issue'],
  ];
  let noun = nouns.find(([pattern]) => pattern.test(def.specId))?.[1] ?? def.name.toLowerCase();
  if (noun === 'issue' && def.connector.category === 'observability') noun = 'error';
  return `${def.connector.name.replace(/\s+Issues$/, '')} ${noun}`;
}

interface ScheduleParts {
  dow: string;
  dom: string;
  days: number[];
  night: boolean;
  tod?: 'night' | 'morning' | 'afternoon' | 'evening' | 'noon' | 'midnight';
  weekly: boolean;
}

const DAYS = ['sun', 'mon', 'tues', 'wednes', 'thurs', 'fri', 'satur'];
const DAY_LABELS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const TIME_ZONES: Array<[RegExp, string, string]> = [
  [/^(?:utc|gmt)$/, 'UTC', 'UTC'],
  [/^(?:pst|pdt|pt|pacific(?: time)?)$/, 'America/Los_Angeles', 'Pacific'],
  [/^(?:est|edt|et|eastern(?: time)?|new york(?: time)?)$/, 'America/New_York', 'Eastern'],
  [/^(?:cst|cdt)$/, 'America/Chicago', 'Central'],
  [/^(?:cet|cest|berlin(?: time)?)$/, 'Europe/Berlin', 'Berlin'],
  [/^paris(?: time)?$/, 'Europe/Paris', 'Paris'],
  [/^(?:bst|london(?: time)?|uk time)$/, 'Europe/London', 'London'],
  [/^(?:jst|tokyo(?: time)?)$/, 'Asia/Tokyo', 'Tokyo'],
  [/^(?:aest|sydney(?: time)?)$/, 'Australia/Sydney', 'Sydney'],
  [/^(?:ist|india(?: time)?)$/, 'Asia/Kolkata', 'India'],
];

function readSchedule(reader: Reader): TriggerRead | undefined {
  const interval = reader.first(/\bevery\s+(\d+|a|one|two|three|four|five|six|ten|twelve|fifteen|twenty|thirty|forty-five|sixty)\s*(minutes?|mins?|hours?|hrs?)\b|\bevery\s+(minute|hour|half[- ]hour)\b|\b(hourly)\b/g);
  const periods = reader.find(/\b(?:every|each|on)\s+(week ?nights?|week ?days?|weekends?|nights?|evenings?|mornings?|afternoons?|days?|weeks?|months?|(?:mon|tues|wednes|thurs|fri|satur|sun)days?)\b|\b(nightly|daily|weekly|monthly|week ?nights|week ?days|weekends|(?:mon|tues|wednes|thurs|fri|satur|sun)days)\b|\b(monday (?:to|through|-) friday|mon ?- ?fri)\b/g);
  const generic = reader.first(/\b(?:on a (?:schedule|timer)|scheduled|(?:as a )?cron(?: job)?|periodically)\b/g);
  const clock = reader.first(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?![\w:])|\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\bat\s+(midnight|noon|midday)\b/g);
  const hasSchedule = interval !== undefined || periods.length > 0 || generic !== undefined;
  const clockCounts = clock !== undefined && (hasSchedule || clock[3] !== undefined || clock[6] !== undefined || clock[7] !== undefined);
  if (!hasSchedule && !clockCounts) return undefined;

  reader.takeMatch(interval);
  for (const period of periods) reader.takeMatch(period);
  reader.takeMatch(generic);
  if (clockCounts) reader.takeMatch(clock);
  const todWord = reader.first(/\b(?:in the\s+)?(mornings?|evenings?|nights?|afternoons?|midnight|noon|midday|lunchtime)\b/g);
  reader.takeMatch(todWord);
  const zoneWord = reader.first(/\b(utc|gmt|pst|pdt|pt|pacific(?: time)?|est|edt|et|eastern(?: time)?|cst|cdt|cet|cest|bst|jst|aest|ist|london(?: time)?|berlin(?: time)?|paris(?: time)?|new york(?: time)?|tokyo(?: time)?|sydney(?: time)?|india(?: time)?|uk time)\b/g);
  reader.takeMatch(zoneWord);
  const zone = zoneWord === undefined ? undefined : TIME_ZONES.find(([pattern]) => pattern.test(zoneWord[1] ?? ''));

  if (interval !== undefined) {
    const unit = interval[2] ?? interval[3] ?? interval[4] ?? '';
    const count = /half/.test(unit) ? 30 : (toNumber(interval[1]) ?? 1);
    if (/^(?:minutes?|mins?|minute|half[- ]hour)$/.test(unit)) {
      const def = coreNode('schedule', 'trigger', ['interval']);
      if (def !== undefined) {
        const minutes = Math.min(1440, Math.max(1, /half/.test(unit) ? 30 : count));
        const every = minutes === 1 ? 'every minute' : `every ${minutes} minutes`;
        return { def, config: { ...defaultConfig(def), minutes }, explicit: true, short: `E${every.slice(1)}`, label: `Schedule · ${every}` };
      }
    }
    const def = coreNode('schedule', 'trigger', ['cron'])!;
    const hours = Math.min(23, Math.max(1, count));
    const label = hours === 1 ? 'Hourly' : `Every ${hours} hours`;
    const cron = hours === 1 ? '0 * * * *' : `0 */${hours} * * *`;
    return { def, config: { ...defaultConfig(def), cron, timezone: zone?.[1] ?? 'UTC' }, explicit: true, short: label, label: `Schedule · ${label} (${cron})` };
  }

  const parts: ScheduleParts = { dow: '*', dom: '*', days: [], night: false, weekly: false };
  for (const period of periods) {
    const word = (period[1] ?? period[2] ?? period[3] ?? '').replace(/\s+/g, '');
    if (/^weeknights?$/.test(word)) {
      parts.dow = '1-5';
      parts.tod = 'night';
    } else if (/^weekdays?$|^mondayto|^mondaythrough|^monday-friday|^mon-?fri/.test(word)) parts.dow = '1-5';
    else if (/^weekends?$/.test(word)) parts.dow = '0,6';
    else if (/^(?:nights?|nightly)$/.test(word)) parts.tod = 'night';
    else if (/^mornings?$/.test(word)) parts.tod = 'morning';
    else if (/^afternoons?$/.test(word)) parts.tod = 'afternoon';
    else if (/^evenings?$/.test(word)) parts.tod = 'evening';
    else if (/^(?:weeks?|weekly)$/.test(word)) parts.weekly = true;
    else if (/^(?:months?|monthly)$/.test(word)) parts.dom = '1';
    else {
      const day = DAYS.findIndex((prefix) => word.startsWith(`${prefix}day`));
      if (day >= 0 && !parts.days.includes(day)) parts.days.push(day);
    }
  }
  const tod = todWord?.[1]?.replace(/s$/, '');
  if (tod === 'morning' || tod === 'afternoon' || tod === 'evening' || tod === 'night' || tod === 'noon' || tod === 'midnight') parts.tod = tod;
  else if (tod === 'midday' || tod === 'lunchtime') parts.tod = 'noon';
  if (parts.days.length > 0) parts.dow = [...parts.days].sort((a, b) => a - b).join(',');
  else if (parts.weekly && parts.dow === '*') {
    parts.days.push(1);
    parts.dow = '1';
  }

  let hour = { night: 2, midnight: 0, morning: 9, afternoon: 14, evening: 18, noon: 12 }[parts.tod ?? 'morning'] ?? 9;
  let minute = 0;
  if (clockCounts && clock !== undefined) {
    if (clock[7] !== undefined) hour = clock[7] === 'midnight' ? 0 : 12;
    else {
      const rawHour = Number(clock[1] ?? clock[4]);
      const meridiem = (clock[3] ?? clock[6] ?? '').replace(/\./g, '');
      minute = Math.min(59, Number(clock[2] ?? clock[5] ?? 0));
      hour = meridiem === 'pm' && rawHour < 12 ? rawHour + 12 : meridiem === 'am' && rawHour === 12 ? 0 : Math.min(23, rawHour);
    }
  }
  const def = coreNode('schedule', 'trigger', ['cron'])!;
  const cron = `${minute} ${hour} ${parts.dom} * ${parts.dow}`;
  const nightly = parts.tod === 'night' || parts.tod === 'midnight' || hour < 5;
  const when =
    parts.dom === '1' ? 'Monthly, on the 1st'
    : parts.dow === '1-5' ? (nightly ? 'Weeknights' : 'Weekdays')
    : parts.dow === '0,6' ? 'Weekends'
    : parts.days.length > 0 ? listOf(parts.days.map((day) => DAY_LABELS[day]!))
    : nightly ? 'Nightly'
    : 'Daily';
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const label = `${when} at ${time}${zone === undefined ? '' : ` ${zone[2]}`}`;
  return { def, config: { ...defaultConfig(def), cron, timezone: zone?.[1] ?? 'UTC' }, explicit: true, short: label, label: `Schedule · ${label} (${cron})` };
}

function readApproval(reader: Reader): { via: string; approvers: string[] } | undefined {
  const patterns = [
    /\b(?:only\s+)?(?:after|once|when|until|if)\s+(i|we|someone|somebody|a human|a person|a maintainer|a reviewer|a lead|the lead|the team|my team|our team|@?[a-z][\w-]*)\s+(?:has\s+|have\s+)?(?:approves?|approved|signs? off|signed off|okays?|okayed|gives? (?:the |a )?go-ahead|says? go|says? so|says? yes)\b(?:\s+(?:it|them|the (?:plan|run|change|fix|work)))?/g,
    /\b(?:with|needs?|requires?|requiring|wait(?:s|ing)?\s+for|asks?\s+for|gets?|getting|pending|behind|after|following)\s+(?:(?:a|an|my|our|the|human|manual|explicit)\s+)*(?:approval|sign[- ]?off|go[- ]ahead|human review)\b(?:\s+(?:from|by)\s+(@?[a-z][\w-]*(?:\s*(?:,|and|or)\s*@?[a-z][\w-]*)*))?/g,
    /\bhuman[- ]in[- ]the[- ]loop\b|\b(?:ask|check with)\s+(?:me|us)\s+(?:first|before\s+(?:it\s+)?(?:starts?|runs?|begins?|spends?))\b|\bask (?:me |us )?(?:for )?permission first\b/g,
    /\b(?:approv(?:al|e|ed|es)|sign[- ]?off)\b/g,
  ];
  for (const pattern of patterns) {
    const match = reader.first(pattern);
    if (match === undefined) continue;
    reader.takeMatch(match);
    const end = match.index + match[0].length;
    const via = /^\s*(?:(?:in|on|via|through|from|over|using)\s+(?:the\s+|a\s+)?)(slack|chat|microsoft teams|teams|discord|issue|comments?|github|dashboard|studio)\b/.exec(reader.low.slice(end));
    let channel = 'dashboard';
    if (via !== null && reader.isFree(end, end + via[0].length)) {
      reader.take(end, end + via[0].length);
      channel = /issue|comment|github/.test(via[1] ?? '') ? 'issue' : /dashboard|studio/.test(via[1] ?? '') ? 'dashboard' : 'chat';
    }
    const who = (match[1] ?? '').trim();
    const approvers =
      /\b(?:i|we|me|my|us|our)\b/.test(match[0]) || who === 'i' || who === 'we' ? ['you']
      : who !== '' && !/^(?:someone|somebody|a |the |my |our )/.test(who) ? who.split(/\s*(?:,|and|or)\s*/).map((name) => name.replace(/^@/, '')).filter(Boolean)
      : [];
    return { via: channel, approvers };
  }
  return undefined;
}

function readConcurrency(reader: Reader): number | undefined {
  const match = reader.first(/\b(?:at most|no more than|not more than|max(?:imum)?(?: of)?|up to|only|limit(?:ed)? to|cap(?:ped)? at)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a single)\s+(?:(?:runs?|jobs?|agents?|tasks?)\s+)?(?:at (?:once|a time|the same time)|concurrent(?:ly)?|in parallel|parallel|simultaneous(?:ly)?)\b|\b(one|1) at a time\b|\b(\d+|two|three|four|five|six|seven|eight|nine|ten) (?:runs? )?(?:at (?:once|a time)|concurrent(?:ly)?|in parallel)\b|\bconcurren(?:cy|t runs)(?: limit)?(?: of| to|:)?\s+(\d+)\b|\b(?:sequential(?:ly)?|serially|in series|no parallel runs)\b/g);
  if (match === undefined) return undefined;
  reader.takeMatch(match);
  return Math.min(10, Math.max(1, toNumber(match[1] ?? match[2] ?? match[3] ?? match[4]) ?? 1));
}

function readAllowlist(reader: Reader, org: string): { authors: string[]; teams: string[] } | undefined {
  const authors: string[] = [];
  const teams: string[] = [];
  const names = (from: number): number => {
    const re = /\s*(?:,|&|\+|\band\b|\bor\b)?\s*(?:the\s+)?(@?[a-z0-9][\w.-]*(?:\/[\w.-]+)?)(\s+teams?\b)?/y;
    let at = from;
    let count = 0;
    // "maintainers alice and bob": a group word followed by names only describes them.
    let group: string | undefined;
    const settle = () => {
      if (group !== undefined) teams.push(`${org}/${group}`);
      group = undefined;
    };
    for (;;) {
      re.lastIndex = at;
      const match = re.exec(reader.low);
      if (match === null) break;
      const word = (match[1] ?? '').replace(/^@/, '').replace(/\.$/, '');
      if (word === '' || NAME_STOP.has(word) || AGENT_WORDS.has(word) || TRIAGE_WORDS.has(word) || !reader.isFree(match.index, match.index + match[0].length)) break;
      const original = (reader.group(match, 1)?.value ?? word).replace(/^@/, '').replace(/\.$/, '');
      if (GROUP_WORDS.has(word) && match[2] === undefined) {
        settle();
        group = word;
      } else if (match[2] !== undefined || word.includes('/')) {
        settle();
        teams.push(word.includes('/') ? original : `${org}/${word}`);
      } else {
        group = undefined;
        authors.push(word === 'me' || word === 'myself' ? 'you' : original);
      }
      count += 1;
      at = match.index + match[0].replace(/\.$/, '').length;
      if (count >= 12) break;
    }
    settle();
    if (count > 0) reader.take(from, at);
    return count;
  };
  for (const match of reader.find(/\bonly\s+(?:from|by|for|(?:when|if)\s+(?:it(?:'s|\s+is|\s+was)\s+)?(?:opened|filed|created|labell?ed|assigned|triggered|started|requested|reported|written|submitted|raised|tagged)\s+by)\s+/g)) {
    if (names(match.index + match[0].length) > 0) reader.takeMatch(match);
  }
  // "labelled by alice": the verb may already belong to the trigger, so only "by …" is claimed here.
  for (const match of reader.find(/\bby\s+(?=@?[a-z])/g)) {
    if (!/\b(?:opened|filed|created|labell?ed|assigned|triggered|started|requested|reported|written|submitted|raised|tagged)\s*$/.test(reader.low.slice(Math.max(0, match.index - 14), match.index))) continue;
    if (names(match.index + match[0].length) > 0) reader.takeMatch(match);
  }
  for (const match of reader.find(/\b(?:(?:an?\s+|with\s+(?:an?\s+)?)?(?:author\s+)?allow ?list(?:ed)?|whitelist(?:ed)?|allowed(?:\s+(?:authors?|users?|people|logins?))?|trusted\s+(?:authors?|users?|people))\b\s*(?:of|is|are|:|to|only)?\s*/g)) {
    reader.takeMatch(match);
    names(match.index + match[0].length);
    if (authors.length === 0 && teams.length === 0) authors.push('you');
  }
  for (const match of reader.find(/\b(?:only\s+)?(?:members? of|people (?:in|on|from)|folks (?:in|on|from)|anyone (?:in|on|from))\s+(?:the\s+)?(@?[a-z0-9][\w-]*(?:\/[\w-]+)?)(?:\s+team)?\b/g)) {
    reader.takeMatch(match);
    const team = match[1] ?? '';
    teams.push(team.includes('/') ? team : `${org}/${team}`);
  }
  if (authors.length === 0 && teams.length === 0) return undefined;
  return { authors: [...new Set(authors)], teams: [...new Set(teams)] };
}

function readPipeline(reader: Reader, notes: string[]): PipelineRead {
  const read: PipelineRead = { fast: false, review: 'standard', roles: {}, runTests: true };
  const refused: Span[] = [];
  for (const [pattern, roles] of ROLE_PATTERNS) {
    for (const match of reader.find(pattern)) {
      const agent = agentOf(match.slice(1).find((group) => group !== undefined) ?? '');
      if (refused.some(([start, end]) => match.index < end && match.index + match[0].length > start)) continue;
      if (roles === 'bare') {
        reader.takeMatch(match);
        if (agent === 'gemini' || agent === 'aider') read.worker ??= agent;
        continue;
      }
      if (roles === 'generic') {
        reader.takeMatch(match);
        read.worker ??= agent;
        continue;
      }
      if (roles === 'all') {
        reader.takeMatch(match);
        if (agent === 'aider') {
          read.worker = 'aider';
          notes.push('Aider only implements: it has no read-only mode, so the reviews stay with Claude and Codex.');
        } else read.roles = { planner: agent, planReviewer: agent, implementer: agent, codeReviewer: agent };
        continue;
      }
      if (agent === 'aider' && roles.some((role) => role !== 'implementer')) {
        // Left unclaimed on purpose: the hint shows it, the note says why.
        notes.push('Aider cannot plan or review: it has no read-only mode. Those roles stay with Claude and Codex.');
        refused.push([match.index, match.index + match[0].length]);
        continue;
      }
      reader.takeMatch(match);
      for (const role of roles) read.roles[role] ??= agent;
    }
  }

  const fast = reader.first(/\b(?:(?:a|with a)\s+)?(?:quick(?:ly)?(?:[- ](?:fix(?:es|ed)?|run))?|fast(?:[- ]fix(?:es|ed)?|[- ]run| mode)?|no[- ]reviews?|without (?:a |any )?(?:code )?reviews?|skip(?:ping)? (?:the )?reviews?|single[- ]agent|one[- ]shot|in one (?:go|pass|session)|yolo)\b/g);
  const thorough = reader.first(/\b(?:(?:a|an|with a|with an)\s+)?(?:thorough(?:ly)?|careful(?:ly)?|rigorous(?:ly)?|extra[- ](?:careful|reviews?)|deep[- ]reviews?|three (?:review )?rounds|paranoid|strict(?:ly)?|belt and braces)(?:\s+reviews?|\s+reviewed)?\b/g);
  const light = reader.first(/\b(?:(?:a|with a)\s+)?(?:light(?:weight)?[- ]reviews?|light(?:ly)?[- ]reviewed|one review round|a single review|quick review)\b/g);
  if (thorough !== undefined) {
    reader.takeMatch(thorough);
    read.review = 'thorough';
  } else if (light !== undefined) {
    reader.takeMatch(light);
    read.review = 'light';
  }
  // "A quick fix with light review" still asked for a review: that is the light level, not the no-review run.
  if (fast !== undefined) {
    reader.takeMatch(fast);
    if (thorough === undefined && light === undefined) read.fast = true;
    else if (thorough === undefined) read.review = 'light';
  }
  reader.takeMatch(reader.first(/\b(?:(?:standard|normal|full)\s+reviews?|cross[- ]review(?:ed|s|ing)?|cross[- ]model|plans?,? reviews?,? (?:and )?implements?|review(?:ed)? (?:it|the (?:code|diff|change))|reviewed)\b/g));

  const noTests = reader.first(/\b(?:skip(?:ping)? (?:the )?tests?|without (?:running )?(?:the )?tests?|no tests|don'?t run (?:the )?tests?)\b/g);
  if (noTests !== undefined) {
    reader.takeMatch(noTests);
    read.runTests = false;
  }
  const command = reader.first(/\b(?:tests?|test suite|run|using|with)\s+(?:with\s+|using\s+|via\s+)?`([^`]+)`/g);
  if (command !== undefined) {
    reader.takeMatch(command);
    read.testCommand = command[1]?.trim();
  }
  reader.takeMatch(reader.first(/\b(?:(?:and\s+)?run(?:s|ning)?\s+(?:the\s+)?(?:test suite|tests?|specs)|(?:and\s+)?test(?:s|ed)? it|with tests)\b/g));
  const base = reader.first(/\b(?:against|into|off(?: of)?|onto|based on|targeting|target|from)\s+(?:the\s+)?`?([\w./-]+)`?(\s+branch)?\b/g);
  if (base !== undefined && (base[2] !== undefined || /^(?:main|master|develop|dev|staging|trunk|next|release[\w/.-]*)$/.test(base[1] ?? ''))) {
    reader.takeMatch(base);
    read.baseBranch = reader.group(base, 1)?.value;
  }
  return read;
}

function readDelivery(reader: Reader): DeliveryRead {
  const ranks: Record<Policy, number> = { none: 0, branch: 1, push: 2, pr: 3, merge: 4 };
  let policy: Policy | undefined;
  let draft: boolean | undefined;
  const consider = (next: Policy, match: RegExpExecArray | undefined) => {
    if (match === undefined) return;
    reader.takeMatch(match);
    if (policy === undefined || ranks[next] > ranks[policy]) policy = next;
  };
  consider('merge', reader.first(/\b(?:auto[- ]?merge(?:s|d)?(?:\s+(?:it|them))?|merge(?:s|d)?(?!\s+requests?)(?:\s+(?:it|them|the (?:pr|pull request|change|fix)s?))?(?:\s+(?:automatically|straight away|right away))?(?:\s+(?:when|once|if) (?:green|checks pass|ci passes|tests pass|it passes))?|ship (?:it )?(?:straight )?to (?:main|production|prod)|push (?:it )?straight to main|land it)\b/g));
  const ready = reader.first(/\b(?:(?:as\s+)?(?:a\s+)?ready[- ]for[- ]review(?:\s+(?:pr|pull request))?|non[- ]draft(?:\s+(?:pr|pull request))?|not (?:as )?a draft|a real (?:pr|pull request))\b/g);
  if (ready !== undefined) {
    draft = false;
    consider('pr', ready);
  }
  const drafted = reader.first(/\b(?:(?:open|opens|create|creates|raise|raises|file|submit|make|put up|puts up|with|as|deliver as|delivered as)\s+)?(?:(?:a|an)\s+)?draft(?:\s+(?:pr|pull request|mr|merge request)s?)?\b/g);
  if (drafted !== undefined) {
    draft = true;
    consider('pr', drafted);
  }
  consider('pr', reader.first(/\b(?:(?:open|opens|opening|create|creates|raise|raises|file|send|submit|make|put up|puts up|with|as|deliver as|delivered as)\s+(?:a\s+|an\s+|the\s+)?)?(?:pull requests?|prs?|merge requests?|mrs?)\b(?!\s+(?:is|are)\s+opened)/g));
  consider('push', reader.first(/\b(?:and\s+)?push(?:es|ed)?(?:\s+(?:it|them|the (?:work|change|changes|fix)|changes))?(?:\s+(?:up\s+)?(?:to\s+)?(?:a|the|its own|a new)?\s*(?:branch|remote|origin))?\b(?!\s+(?:straight\s+)?to\s+main)/g));
  consider('branch', reader.first(/\b(?:commit(?:s|ted)?(?:\s+(?:it|them|the (?:change|fix|work)))?\s+(?:to|on|onto)\s+(?:a\s+)?(?:new\s+|local\s+|separate\s+)?branch|(?:just|only)\s+commit(?:\s+(?:it|them))?|leave\s+(?:it|the (?:work|change|diff))\s+on\s+a\s+branch|(?:deliver\s+)?(?:on|to)\s+a\s+(?:new\s+|local\s+|separate\s+)?branch|local branch|commit(?:s|ted)? (?:it|them|the (?:change|fix|work))|a commit)\b/g));
  consider('none', reader.first(/\b(?:leave the diff|just the diff|(?:do not|don't|never) (?:commit|push|deliver)|no delivery|dry[- ]run)\b/g));

  const reviewers: string[] = [];
  for (const match of reader.find(/\b(?:request(?:ing)?\s+(?:a\s+)?reviews?\s+from|reviewers?:|(?:and\s+)?ask|(?:and\s+)?assign|cc)\s+(@?[a-z0-9][\w-]*(?:\s*(?:,|and|&)\s*@?[a-z0-9][\w-]*)*)(\s+(?:to review|for (?:a )?review|as reviewers?))?/g)) {
    if (!/^request|^reviewer/.test(match[0]) && match[2] === undefined) continue;
    const people = (reader.group(match, 1)?.value ?? '').split(/\s*(?:,|and|&)\s*/).map((name) => name.replace(/^@/, '')).filter((name) => name !== '' && !AGENT_WORDS.has(name.toLowerCase()));
    if (people.length === 0) continue;
    reader.takeMatch(match);
    reviewers.push(...people);
  }
  const label = reader.first(/\b(?:label|tag)\s+(?:the\s+)?(?:pr|pull request)\s+(?:with\s+|as\s+)?["'`]?([a-z0-9][\w:./-]*)|\b(?:pr|pull request)\s+(?:labell?ed|tagged)\s+["'`]?([a-z0-9][\w:./-]*)/g);
  reader.takeMatch(label);
  const labels = label === undefined ? undefined : (reader.group(label, label[1] === undefined ? 2 : 1)?.value ?? undefined);
  return {
    policy: policy ?? 'pr',
    draft: draft ?? true,
    ...(reviewers.length === 0 ? {} : { reviewers: reviewers.join(', ') }),
    ...(labels === undefined ? {} : { labels }),
  };
}

function readTriage(reader: Reader): TriageRead | undefined {
  const make = (word: string, match: RegExpExecArray): TriageRead => {
    const category = categoryFor(word);
    reader.takeMatch(match);
    return { ai: true, category: category.right, prompt: `${category.prompt}\n\n{{issue.title}}\n{{issue.body}}`, left: '{{issue.triage}}', op: 'contains', right: category.right, clause: reader.clause(match.index) };
  };
  const conditional = reader.first(new RegExp(`\\bif\\s+(?:it(?:'s|\\s+is)|it\\s+looks\\s+like|this\\s+is|that'?s|they(?:'re|\\s+are)|it\\s+turns\\s+out\\s+to\\s+be|the\\s+(?:issue|ticket|error|report)\\s+is)\\s+(?:(?:a|an|really|actually|likely|probably)\\s+)*(${CATEGORY_ALT})\\b(?:\\s+enough)?`, 'g'));
  if (conditional !== undefined) {
    reader.takeMatch(reader.first(/\b(?:have (?:a|the) model\s+|let (?:a|the) model\s+|ai\s+)?(?:triage|triages|triaged|classify|classifies|categori[sz]e)\b(?:\s+(?:it|them|the (?:issue|ticket|error|report|comment)s?))?(?:\s+first)?/g));
    return make(conditional[1] ?? 'bug', conditional);
  }
  const only = reader.first(new RegExp(`\\bonly\\s+(?:for\\s+|if\\s+it'?s\\s+|when\\s+it'?s\\s+)?(?:the\\s+)?(${CATEGORY_PLURALS})\\b|\\b(${CATEGORY_PLURALS})\\s+only\\b|\\b(?:fix|fixes)\\s+(${CATEGORY_PLURALS})\\b`, 'g'));
  if (only !== undefined) {
    const word = (only[1] ?? only[2] ?? only[3] ?? 'bugs').replace(/\s+(?:ones|issues|tickets|fixes|changes)$/, '');
    const singular = word === 'crashes' ? 'crash' : word.replace(/s$/, '');
    reader.takeMatch(reader.first(/\b(?:triage|triages|classify|categori[sz]e)\b(?:\s+(?:it|them))?(?:\s+first)?/g));
    return make(singular, only);
  }
  const priority = reader.first(/\bif\s+(?:the\s+|its\s+)?priority\s+is\s+(?:at least\s+|above\s+)?([\w-]+)/g);
  if (priority !== undefined) {
    reader.takeMatch(priority);
    const value = priority[1] ?? 'high';
    return { ai: false, category: `priority ${value}`, prompt: '', left: '{{issue.priority}}', op: 'equals', right: value, clause: reader.clause(priority.index) };
  }
  const labelled = reader.first(/\bif\s+(?:it(?:'s|\s+is)\s+|it\s+has\s+been\s+)?(?:labell?ed|tagged)\s+["'`]?([a-z0-9][\w:./-]*)|\bif\s+it\s+has\s+(?:the\s+|a\s+)?(?:label|tag)\s+["'`]?([a-z0-9][\w:./-]*)/g);
  if (labelled !== undefined) {
    reader.takeMatch(labelled);
    const value = reader.group(labelled, labelled[1] === undefined ? 2 : 1)?.value ?? 'bug';
    return { ai: false, category: `labelled ${value}`, prompt: '', left: '{{issue.labels}}', op: 'contains', right: value, clause: reader.clause(labelled.index) };
  }
  const estimate = reader.first(/\bif\s+(?:the\s+)?estimate\s+is\s+(?:under|below|less than|at most)\s+(\d+)/g);
  if (estimate !== undefined) {
    reader.takeMatch(estimate);
    return { ai: false, category: `estimate under ${estimate[1]}`, prompt: '', left: '{{issue.estimate}}', op: 'lt', right: estimate[1] ?? '3', clause: reader.clause(estimate.index) };
  }
  const triage = reader.first(/\b(?:have (?:a|the) model\s+|let (?:a|the) model\s+|ai\s+)?(?:triage|triages|triaged|classify|classifies|categori[sz]e|sort)\b(?:\s+(?:it|them|the (?:issue|ticket|error|report|comment)s?))?(?:\s+first)?/g);
  if (triage !== undefined) return make('bug', triage);
  return undefined;
}

function readTask(reader: Reader): string | undefined {
  for (const match of reader.find(TASK)) {
    const group = reader.group(match, 1);
    if (group === undefined) continue;
    const start = group.start;
    const [, clauseEnd] = reader.clause(start);
    let end = reader.nextUsed(start, clauseEnd);
    const cut = new RegExp(TASK_CUT.source, 'g');
    cut.lastIndex = start;
    const hit = cut.exec(reader.low);
    if (hit !== null && hit.index < end) end = hit.index;
    let text = reader.slice(start, end).replace(/[\s,.;:!?-]+$/, '');
    // "Upgrade our dependencies with a …": drop the words that only led into what was cut off.
    while (/\s(?:and|then|with|to|so|or|a|an|the|for|of|in|on|at|by|using|via|as)$/i.test(text)) text = text.replace(/\s+\S+$/, '').replace(/[\s,.;:!?-]+$/, '');
    text = text.trim();
    if (text.split(/\s+/).length < 2 || text.length > 120) continue;
    reader.take(start, start + text.length);
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  return undefined;
}

const NOTIFY_VERBS = /\b(?:tell|tells|ping|pings|notify|notifies|post(?:s|ed)?(?:\s+(?:it|a message|an update|the (?:pr|link|result|summary)))?|message|messages|announce|share|shares|send(?:s)?(?:\s+(?:a message|an update|it))?|alert|alerts|dm|update|let\s+\w+\s+know|drop a (?:note|message))(?:\s+(?:to|in|on|into|via|over))?(?:\s+the)?\b/g;
const TICKET_WORDS = /\b(?:open|opens|create|creates|file|files|log|logs|raise|raises|make|add|turn|turns|become|becomes|goes|go|track|tracked)\b(?:\s+(?:it|them|the rest|those))?(?:\s+(?:into|as|to|in))?(?:\s+(?:a|an|new))*|\b(?:ticket|tickets|issue|issues|task|tasks|card|cards|story|stories|bug reports?)\b(?:\s+(?:in|on|to))?/g;
const GENERIC_VERBS: Array<[RegExp, string[]]> = [
  [/\b(?:resolve|resolves|close|closes|mark (?:it |them )?(?:as )?(?:resolved|done|fixed)|complete|completes)\b/g, ['resolve', 'close', 'complete', 'solve']],
  [/\b(?:reply|replies|respond|responds|answer|answers)\b/g, ['reply', 'respond', 'comment']],
  [/\b(?:move|moves|transition|transitions|set (?:the )?(?:status|state))\b/g, ['state', 'status', 'transition', 'move']],
  [/\b(?:attach|attaches|link|links)\b/g, ['attach', 'link']],
  [/\b(?:deploy|deploys|ship|ships)\b/g, ['deploy', 'promote']],
  [/\b(?:release|releases|tag a release)\b/g, ['release']],
  [/\b(?:note|annotate|annotates)\b/g, ['note', 'annotat']],
  [/\b(?:log|logs|record|records|track|tracks)\b/g, ['log', 'record', 'metric', 'event']],
  [/\b(?:comment|comments)\b/g, ['comment', 'note']],
];

function readOutputs(reader: Reader, mentions: Mention[], trigger: TriggerRead, triage: TriageRead | undefined): OutputRead[] {
  const outputs: OutputRead[] = [];
  const otherwise = reader.find(/\b(?:otherwise|or else|else|if not|if it(?:'s| is)(?:n't| not)(?: a| an)?(?:\s+[a-z-]+)?|for (?:the rest|everything else|anything else|all (?:the )?others|non-[a-z]+)|the rest|everything else|anything else|non-(?:bugs?|regressions?))\b/g).map((match): Span => {
    reader.takeMatch(match);
    return [match.index, reader.clause(match.index + match[0].length, SENTENCE_BREAK)[1]];
  });
  const refused = reader.find(/\b(?:if|when|in case)\s+(?:it(?:'s|\s+is|\s+gets)\s+|a run is\s+|the run is\s+|they(?:'re|\s+are)\s+|it\s+)?(?:refused|rejected|blocked|denied|over (?:the )?budget|too expensive|not allowed|turned down)\b/g).map((match): Span => {
    reader.takeMatch(match);
    return reader.clause(match.index);
  });
  const branchAt = (at: number): Branch => (otherwise.some(([start, end]) => at >= start && at < end) ? 'false' : refused.some(([start, end]) => at >= start && at < end) ? 'refused' : 'main');
  const claimNear = (pattern: RegExp, at: number, reach = 45) => {
    const [clauseStart] = reader.clause(at);
    const from = Math.max(clauseStart, at - reach);
    const hits = reader.find(pattern, from, at);
    const last = hits[hits.length - 1];
    if (last !== undefined && reader.low.slice(last.index + last[0].length, at).trim().split(/\s+/).filter(Boolean).length <= 3) reader.takeMatch(last);
    return last !== undefined;
  };
  const channelIn = (span: Span): string | undefined => {
    const match = reader.first(/\B(#[a-z0-9][\w-]*)|\bthe\s+([\w-]+)\s+channel\b/g, span[0], span[1]);
    if (match === undefined) return undefined;
    reader.takeMatch(match);
    return match[1] !== undefined ? reader.group(match, 1)?.value : `#${match[2]}`;
  };
  const addressIn = (span: Span): string | undefined => {
    const match = reader.first(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, span[0], span[1]);
    if (match === undefined) return undefined;
    reader.takeMatch(match);
    return reader.slice(match.index, match.index + match[0].length);
  };
  const triggerConnector = trigger.def.connector;

  for (const mention of mentions) {
    if (!reader.isFree(mention.start, mention.end)) continue;
    const connector = getConnector(mention.connectorId);
    if (connector === undefined) continue;
    const clause = reader.clause(mention.start);
    const branch = branchAt(mention.start);
    const context = reader.low.slice(Math.max(clause[0], mention.start - 45), Math.min(clause[1], mention.end + 25));
    if (connector.category === 'chat' || connector.category === 'email') {
      reader.take(mention.start, mention.end);
      claimNear(NOTIFY_VERBS, mention.start);
      const dm = /\b(?:dm|direct message|privately)\b|\b(?:ping|tell|message|notify)\s+me\b/.test(context);
      reader.takeMatch(reader.first(/\b(?:ping|tell|message|notify|dm)\s+me\b|\bme\b/g, clause[0], clause[1]));
      const user = reader.first(/\B(@[a-z0-9][\w.-]*)/g, clause[0], clause[1]);
      reader.takeMatch(user);
      outputs.push({ role: 'notify', connectorId: connector.id, branch, keywords: dm ? ['dm', 'direct', 'chat'] : [], channel: channelIn(clause), to: addressIn(clause), user: user === undefined ? undefined : reader.group(user, 1)?.value, dm, at: mention.start });
      continue;
    }
    const tracker = connector.category === 'issues' || connector.id === 'github';
    if (tracker && /\b(?:open|opens|create|creates|file|files|log|logs|raise|raises|make|add|turn|turns|become|becomes|goes|track|tracked|into|ticket|tickets|issue|issues|task|tasks|card|cards|story|stories)\b/.test(context)) {
      const ticketConnector = connector.id === 'github' ? (getConnector('github-issues') ?? connector) : connector;
      reader.take(mention.start, mention.end);
      claimNear(TICKET_WORDS, mention.start);
      reader.takeMatch(reader.at(/\s*(?:ticket|tickets|issue|issues|task|tasks|card|cards|story|stories)\b(?:\s+for\s+(?:it|them|the rest))?/, mention.end));
      outputs.push({ role: 'ticket', connectorId: ticketConnector.id, branch, keywords: ['create', 'new', 'open', 'file'], at: mention.start });
      continue;
    }
    // Any other app: only when a verb says what to do with it, and never a guess.
    for (const [pattern, keywords] of GENERIC_VERBS) {
      if (!new RegExp(pattern.source).test(context)) continue;
      reader.take(mention.start, mention.end);
      claimNear(pattern, mention.start);
      reader.takeMatch(reader.first(pattern, mention.end, Math.min(clause[1], mention.end + 25)));
      outputs.push({ role: 'action', connectorId: connector.id, branch, keywords, at: mention.start });
      break;
    }
  }

  // No app named, but the intent is plain.
  for (const match of reader.find(/\b(?:e-?mail|mail)\s+(?:[\w.+-]+@[\w-]+(?:\.[\w-]+)+|me|us|the team|the reporter|them|oncall|on-call)\b(?:\s+(?:the|a)\s+(?:report|summary|results?|update|link))?|\bsend (?:me|us|them) an? e-?mail\b|\b(?:by|via|an?) e-?mail\b/g)) {
    const gmail = getConnector('gmail');
    if (gmail === undefined) break;
    reader.takeMatch(match);
    const clause = reader.clause(match.index);
    outputs.push({ role: 'notify', connectorId: gmail.id, branch: branchAt(match.index), keywords: [], to: addressIn(clause) ?? /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(match[0])?.[0], at: match.index });
  }
  for (const match of reader.find(/\b(?:post|posts|tell|ping|notify|message|announce|share|shares|drop a (?:note|message))\b[^.;,]{0,24}?(#[\w-]+)/g)) {
    const slack = getConnector('slack');
    if (slack === undefined) break;
    reader.takeMatch(match);
    outputs.push({ role: 'notify', connectorId: slack.id, branch: branchAt(match.index), keywords: [], channel: reader.group(match, 1)?.value, at: match.index });
  }
  for (const match of reader.find(/\b(?:comment(?:s|ing)?|reply|replies|report(?:s)? back|post(?:s)?(?: the)? (?:summary|result|update)s?|write back)\s+(?:back\s+)?(?:on|to|in)\s+(?:the\s+|that\s+)?(?:original\s+|source\s+)?(?:issue|ticket|thread|task|card|story|incident|error|conversation)s?\b|\bcomment(?:s)? (?:the )?summary(?:\s+(?:back\s+)?(?:on|to|in)\s+(?:the\s+)?(?:issue|ticket|thread|task|card|pr|pull request))?\b|\b(?:leave|add|post|write) a (?:comment|summary)(?: (?:on|to) (?:the )?(?:issue|ticket))?\b|\bcomment back\b/g)) {
    reader.takeMatch(match);
    outputs.push({ role: 'comment', connectorId: triggerConnector.id, branch: branchAt(match.index), keywords: ['comment', 'note', 'reply'], at: match.index });
  }
  for (const match of reader.find(/\b(?:reply|replies|respond|responds|write back|get back)\s+(?:to\s+)?(?:the\s+)?(?:customer|user|requester|reporter|sender|them)\b/g)) {
    reader.takeMatch(match);
    outputs.push({ role: 'reply', connectorId: triggerConnector.id, branch: branchAt(match.index), keywords: ['reply', 'respond', 'comment'], at: match.index });
  }
  for (const [start, end] of otherwise) {
    const label = reader.first(new RegExp(`\\b(?:label|tag)\\s+(?:it|them)\\s+(?:as\\s+|with\\s+)?["'\`]?(${LABEL_VALUE})`, 'g'), start, end);
    if (label !== undefined) {
      reader.takeMatch(label);
      outputs.push({ role: 'label', connectorId: triggerConnector.id, branch: 'false', keywords: ['label', 'tag'], label: reader.group(label, 1)?.value, at: label.index });
    }
    const ticket = reader.first(/\b(?:open|create|file|log|raise|make)\s+(?:a\s+|an\s+|new\s+)*(?:ticket|issue|task|bug report)\b/g, start, end);
    if (ticket !== undefined && !outputs.some((output) => output.role === 'ticket' && output.branch === 'false')) {
      reader.takeMatch(ticket);
      const own = triggerConnector.category === 'issues' && triggerConnector.actions.some((action) => /create/.test(action.id));
      outputs.push({ role: 'ticket', connectorId: own ? triggerConnector.id : 'github-issues', branch: 'false', keywords: ['create', 'new', 'open', 'file'], at: ticket.index });
    }
    reader.takeMatch(reader.first(/\b(?:ignore|skip|drop|leave|stop|do nothing|nothing|close)\b(?:\s+(?:it|them))?/g, start, end));
  }

  // A ticket filed next to triage belongs to the "no" side, unless it was asked for in the same breath as the question.
  if (triage !== undefined) {
    for (const output of outputs) {
      if (output.role === 'ticket' && output.branch === 'main' && !(output.at >= triage.clause[0] && output.at < triage.clause[1])) output.branch = 'false';
    }
  }
  return outputs.sort((a, b) => a.at - b.at);
}

/* ------------------------------------------------------------------ */
/* Building the graph                                                  */
/* ------------------------------------------------------------------ */

const COL = 320;
const ROW = 190;
const MAIN = 1;
const BELOW = 2.2;
/**
 * The ceiling a budget gate gets when nobody named one: the starter templates'
 * numbers. A typical full run costs about $5 and the long tail goes past $6, so
 * the per-run cap leaves room rather than stopping good runs halfway.
 */
const DEFAULT_BUDGET = { run: 8, day: 40 };

interface Port {
  id: string;
  handle?: string;
}

class Graph {
  readonly nodes: WorkflowNode[] = [];
  readonly edges: WorkflowEdge[] = [];
  readonly steps: Array<DescribedStep & { nodeId: string }> = [];
  private readonly rows = new Map<number, number[]>();

  /** The nearest free row at or below `row` in a column, so branches never overlap. */
  private slot(col: number, row: number): number {
    const used = this.rows.get(col) ?? [];
    let at = row;
    while (used.some((taken) => Math.abs(taken - at) < 0.95)) at += 1.1;
    used.push(at);
    this.rows.set(col, used);
    return at;
  }

  add(def: NodeTypeDef, col: number, row: number, config: Record<string, unknown>, step: { kind: DescribedStep['kind']; label: string }, title?: string): string {
    const id = `n_${nanoid(8)}`;
    const at = this.slot(col, row);
    this.nodes.push({
      id,
      type: 'wf',
      position: { x: 80 + col * COL, y: 120 + at * ROW },
      data: { typeId: def.id, config: { ...defaultConfig(def), ...config }, ...(title === undefined ? {} : { label: title }) },
    });
    this.steps.push({ ...step, typeId: def.id, nodeId: id });
    return id;
  }

  def(id: string): NodeTypeDef | undefined {
    return getNodeType(this.nodes.find((node) => node.id === id)?.data.typeId ?? '');
  }

  output(port: Port): { id: string; type: PortType } | undefined {
    const def = this.def(port.id);
    return def?.outputs.find((output) => output.id === port.handle) ?? def?.outputs[0];
  }

  feeds(port: Port, def: NodeTypeDef): boolean {
    const out = this.output(port);
    return out !== undefined && def.inputs.some((input) => portsCompatible(out.type, input.type));
  }

  /** Connects `from` to `to`, resolving handles against the real ports like the templates do. Refuses a pairing the validator would reject. */
  link(from: Port, to: string, targetHandle?: string): boolean {
    const out = this.output(from);
    const target = this.def(to);
    if (out === undefined || target === undefined) return false;
    const fits = (input: { type: PortType }) => portsCompatible(out.type, input.type);
    const input = target.inputs.find((candidate) => candidate.id === targetHandle && fits(candidate)) ?? target.inputs.find(fits);
    if (input === undefined) return false;
    this.edges.push({ id: `e_${nanoid(8)}`, source: from.id, target: to, sourceHandle: out.id, targetHandle: input.id });
    return true;
  }
}

interface Hints {
  slug: string;
  channel?: string;
  to?: string;
  user?: string;
}

/** A value for every required field nobody gave, so the validator has nothing to refuse and the inspector shows what to change. */
function fillRequired(def: NodeTypeDef, config: Record<string, unknown>, hints: Hints): void {
  for (const field of def.fields) {
    if (field.required !== true) continue;
    const value = config[field.key];
    if (value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '')) continue;
    config[field.key] = guess(field, hints);
  }
}

function guess(field: FieldSpec, hints: Hints): unknown {
  switch (field.key) {
    case 'channel':
      return hints.channel ?? '#eng';
    case 'space':
      return 'spaces/eng';
    case 'team':
      return 'Engineering';
    case 'to':
    case 'email':
      return hints.to ?? 'you@example.com';
    case 'from':
      return `${hints.slug}@example.com`;
    case 'user':
    case 'userId':
      return hints.user ?? '@you';
    case 'requester':
      return '{{issue.author}}';
    case 'authors':
      return 'you';
    case 'url':
      return 'https://example.com/hook';
    case 'workflow':
      return 'ci.yml';
    case 'service':
      return 'api';
    case 'cron':
      return '0 9 * * 1-5';
    default:
      break;
  }
  if (field.type === 'number') return field.default ?? field.min ?? 1;
  if (field.type === 'boolean') return field.default ?? false;
  if (field.type === 'select') return field.default ?? field.options?.[0]?.value ?? '';
  if (field.default !== undefined) return field.default;
  if (field.placeholder !== undefined && field.placeholder.length > 0 && !/^(?:optional|https?:\/\/|one per line)$/i.test(field.placeholder)) return field.placeholder;
  return 'set me';
}

/** Sets the first message-shaped field a node has, for branches whose default text would say the wrong thing. */
function setMessage(def: NodeTypeDef, config: Record<string, unknown>, text: string, subject?: string): void {
  const key = ['text', 'body', 'message', 'content', 'description'].find((candidate) => hasField(def, candidate));
  if (key !== undefined) config[key] = text;
  if (subject !== undefined && hasField(def, 'subject')) config['subject'] = subject;
}

function listOf(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function money(value: number): string {
  return `$${Number.isInteger(value) ? value : value.toFixed(2)}`;
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

const POLICY_LABELS: Record<Policy, string> = { none: 'leave the diff', branch: 'commit to a branch', push: 'push the branch', pr: 'pull request', merge: 'merge when checks pass' };

export function workflowFromDescription(text: string, brand: Brand, repository = 'acme/api'): DescriptionResult {
  const original = text.trim();
  const reader = new Reader(normalize(original));
  const notes: string[] = [];
  const org = repository.split('/')[0] || 'acme';
  const mentions = findMentions(reader);

  // Order matters: each reader claims its words, so later ones cannot misread them.
  const budgetRead = readBudget(reader);
  const trigger = readTrigger(reader, mentions, brand);
  const approval = readApproval(reader);
  const concurrency = readConcurrency(reader);
  const killSwitch = reader.first(/\b(?:(?:with|behind|and)\s+(?:a\s+|an\s+)?)?(?:kill[- ]?switch(?:[- ]guarded)?|off[- ]switch|panic button|big red button)\b/g);
  reader.takeMatch(killSwitch);
  const allowlist = readAllowlist(reader, org);
  const pipelineRead = readPipeline(reader, notes);
  const deliveryRead = readDelivery(reader);
  const triage = readTriage(reader);
  const needsTask = trigger.def.kind === 'trigger' && (trigger.def.connectorId === 'logic' || trigger.def.connectorId === 'schedule' || trigger.def.connectorId === 'http');
  const task = needsTask ? readTask(reader) : undefined;
  const outputs = readOutputs(reader, mentions, trigger, triage);
  // What is left that only says "do the work".
  for (const filler of reader.find(/\b(?:fix(?:es|ed|ing)?|implement(?:s|ed|ing)?|resolve[sd]?|handle[sd]?|work(?:s|ing)? on|tackle[sd]?|address(?:es)?|solve[sd]?|take care of|deal with|do(?:es)? (?:it|the work)|run (?:the |an? )?(?:agents?|agent pipeline|pipeline)|pipelines?|runs?|agents?|(?:the |a |our )?bot|automatically|auto|triage|when (?:it's |it is )?done)\b/g)) reader.takeMatch(filler);

  const graph = new Graph();
  const slug = brand.slug;

  // Trigger.
  const triggerConfig = { ...trigger.config };
  if (task !== undefined && trigger.def.connectorId === 'logic' && hasField(trigger.def, 'prompt')) triggerConfig['prompt'] = task;
  const triggerId = graph.add(trigger.def, 0, MAIN, triggerConfig, {
    kind: 'trigger',
    label: task !== undefined && trigger.def.connectorId === 'logic' ? `Manual start · “${task}”` : trigger.label,
  });
  const unattended = isUnattendedTrigger(graph.nodes[0]!);
  let tail: Port = { id: triggerId };
  let col = 1;
  const chain = (def: NodeTypeDef | undefined, config: Record<string, unknown>, step: { kind: DescribedStep['kind']; label: string }, next?: string, title?: string): string | undefined => {
    if (def === undefined || !graph.feeds(tail, def)) return undefined;
    const id = graph.add(def, col, MAIN, config, step, title);
    graph.link(tail, id);
    tail = { id, ...(next === undefined ? {} : { handle: next }) };
    col += 1;
    return id;
  };
  let refusedFrom: { port: Port; col: number } | undefined;

  // Guardrails that need nothing from the ticket go first.
  if (killSwitch !== undefined) chain(coreNode('gates', 'action', ['kill']), { enabled: true }, { kind: 'guardrail', label: 'Kill switch · re-read before every start' });
  if (concurrency !== undefined) chain(coreNode('gates', 'action', ['concurrency']), { maxConcurrentRuns: concurrency }, { kind: 'guardrail', label: `Concurrency limit · ${concurrency === 1 ? 'one at a time' : `${concurrency} at once`}` });
  if (allowlist !== undefined) {
    const def = coreNode('gates', 'action', ['allowlist']);
    const authors = allowlist.authors.length === 0 ? ['you'] : allowlist.authors;
    const at = col;
    const id = chain(def, { authors: authors.join('\n'), teams: allowlist.teams.join('\n') }, { kind: 'guardrail', label: `Author allowlist · ${listOf([...allowlist.authors, ...allowlist.teams])}` }, 'pass');
    if (id !== undefined) {
      refusedFrom = { port: { id, handle: 'refused' }, col: at };
      if (allowlist.authors.length === 0) notes.push('An allowlist needs at least one login, so “you” stands in: replace it with your GitHub login.');
    }
  }

  // Triage: a model answers, a condition routes on the answer.
  let falseFrom: { port: Port; col: number } | undefined;
  if (triage !== undefined) {
    if (triage.ai) chain(coreNode('logic', 'action', ['ai step']), { prompt: triage.prompt }, { kind: 'logic', label: `AI step · is it ${article(triage.category)}?` }, undefined, `Triage: ${triage.category}?`);
    const at = col;
    const id = chain(
      coreNode('logic', 'action', ['condition']),
      { left: triage.left, op: triage.op, right: triage.right },
      { kind: 'logic', label: `Condition · ${triage.ai ? `only ${triage.category === 'small' ? 'small tickets' : `${triage.category}s`} go on` : `only if ${triage.category}`}` },
      'true',
      triage.ai ? `Is it ${article(triage.category)}?` : `Only if ${triage.category}`,
    );
    if (id !== undefined) falseFrom = { port: { id, handle: 'false' }, col: at };
  }

  if (approval !== undefined) {
    const def = coreNode('gates', 'action', ['approval']);
    const approvers = approval.approvers.length === 0 ? ['you'] : approval.approvers;
    const where = approval.via === 'chat' ? 'in chat' : approval.via === 'issue' ? 'on the issue' : 'in the dashboard';
    chain(def, { via: approval.via, approvers: approvers.join('\n') }, { kind: 'guardrail', label: `Human approval · ${listOf(approvers)}, ${where}` }, 'approved');
  }

  // A budget whenever one was asked for, nobody is watching, or the ticket would otherwise not reach the pipeline intact.
  const pipelineDef = pipelineRead.fast ? coreNode('pipeline', 'action', ['fast']) : coreNode('pipeline', 'action', ['run the pipeline']);
  const mainTicket = outputs.find((output) => output.role === 'ticket' && output.branch === 'main');
  const scheduledTask = task !== undefined && trigger.def.connectorId !== 'logic';
  const needsBudget = budgetRead !== undefined || unattended || (pipelineDef !== undefined && mainTicket === undefined && !scheduledTask && !graph.feeds(tail, pipelineDef));
  if (needsBudget) {
    const def = coreNode('gates', 'action', ['budget']);
    let run = budgetRead?.run ?? DEFAULT_BUDGET.run;
    let day = budgetRead?.day ?? DEFAULT_BUDGET.day;
    if (budgetRead?.run !== undefined && budgetRead.day === undefined) day = Math.max(day, run);
    if (budgetRead?.day !== undefined && budgetRead.run === undefined) run = Math.min(run, day);
    if (budgetRead?.run !== undefined && budgetRead.day !== undefined) run = Math.min(run, day);
    const limits = `${money(run)}/run, ${money(day)}/day${budgetRead?.from === undefined ? '' : ` (from ${budgetRead.from})`}`;
    const said = budgetRead !== undefined;
    const at = col;
    const id = chain(def, { maxRunCostUsd: run, maxDailyCostUsd: day }, { kind: 'guardrail', label: said ? `Budget gate · ${limits}` : `Budget gate · added by default (${limits})` }, 'pass');
    if (id !== undefined) {
      refusedFrom = { port: { id, handle: 'refused' }, col: at };
      if (!said) {
        notes.push(
          unattended
            ? `Nobody watches an unattended run, so a Budget gate was added with the default limits (${limits}). Say “under $5” or “$20 a day” to set your own.`
            : `A Budget gate with the default limits (${limits}) sits in front of the pipeline. Say “under $5” or “$20 a day” to set your own.`,
        );
      }
    }
  }

  // The pipeline works from a ticket: one asked for here, or one made from the task a schedule or webhook runs.
  const ticketTitle = scheduledTask ? task : undefined;
  if (mainTicket !== undefined || ticketTitle !== undefined) {
    const connector = getConnector(mainTicket?.connectorId ?? 'github-issues');
    const def = connector === undefined ? undefined : actionFor(connector, ['create', 'new', 'open', 'file'], 'any', false);
    if (def !== undefined) {
      const config: Record<string, unknown> = {};
      if (ticketTitle !== undefined && hasField(def, 'title')) config['title'] = ticketTitle;
      if (hasField(def, 'body')) config['body'] = ticketTitle === undefined ? '{{issue.body}}' : `Opened by {{workflow.name}} so the agents have a ticket to work from.`;
      fillRequired(def, config, { slug });
      chain(def, config, { kind: 'action', label: `${def.connector.name} · ${def.name}${ticketTitle === undefined ? '' : `: “${ticketTitle}”`}` });
      if (ticketTitle !== undefined && mainTicket === undefined) notes.push(`The pipeline works from a ticket, so each ${trigger.def.connectorId === 'schedule' ? 'scheduled run' : 'webhook'} opens a GitHub issue for “${ticketTitle}” first.`);
    }
  }

  // The agents.
  const roles = resolveAgents(pipelineRead);
  let pipelineId: string | undefined;
  if (pipelineDef !== undefined) {
    const config: Record<string, unknown> = { runTests: pipelineRead.runTests };
    let label: string;
    if (pipelineRead.fast) {
      config['implementer'] = roles.implementer;
      label = `Fast run · ${AGENT_NAMES[roles.implementer]}, no reviews${pipelineRead.runTests ? '' : ', no tests'}`;
    } else {
      Object.assign(config, roles, { review: pipelineRead.review, branchPrefix: slug });
      if (pipelineRead.review === 'thorough') Object.assign(config, { maxPlanReviewRounds: 3, maxCodeReviewRounds: 3 });
      if (pipelineRead.review === 'light') Object.assign(config, { maxPlanReviewRounds: 1, maxCodeReviewRounds: 1 });
      if (pipelineRead.baseBranch !== undefined) config['baseBranch'] = pipelineRead.baseBranch;
      if (pipelineRead.testCommand !== undefined) config['testCommand'] = pipelineRead.testCommand;
      label = `Agent pipeline · ${whoDoesWhat(roles)}${pipelineRead.review === 'standard' ? '' : `, ${pipelineRead.review} review`}${pipelineRead.runTests ? '' : ', no tests'}`;
    }
    pipelineId = chain(pipelineDef, config, { kind: 'pipeline', label }, 'run');
  }

  // Delivery: never past a pull request when nobody is watching.
  let policy = deliveryRead.policy;
  let draft = deliveryRead.draft;
  let capped = false;
  if (policy === 'merge' && unattended) {
    policy = 'pr';
    draft = false;
    capped = true;
    notes.push('Unattended runs never merge, so this one stops at a pull request, ready for review, for a person to merge.');
  }
  let deliverId: string | undefined;
  const deliverCol = col;
  if (pipelineId !== undefined) {
    const def = coreNode('delivery', 'action', ['deliver']);
    const config: Record<string, unknown> = { policy, draft: policy === 'pr' ? draft : false };
    if (policy === 'pr' || policy === 'merge') config['labels'] = deliveryRead.labels ?? `${slug}, needs-review`;
    if (deliveryRead.reviewers !== undefined) config['reviewers'] = deliveryRead.reviewers;
    const what = policy === 'pr' ? (draft ? 'draft pull request' : 'pull request, ready for review') : POLICY_LABELS[policy];
    const against = pipelineRead.baseBranch === undefined ? '' : ` against ${pipelineRead.baseBranch}`;
    deliverId = chain(def, config, { kind: 'delivery', label: `Deliver · ${what}${against}${capped ? ' (merge capped: nobody is watching)' : ''}` }, 'change');
  }

  // What happens after: on the main line off the delivered change or the finished run, on the "no" side of triage, or when a gate refuses.
  const pipelinePort: Port | undefined = pipelineId === undefined ? undefined : { id: pipelineId, handle: 'run' };
  const deliverPort: Port | undefined = deliverId === undefined ? undefined : { id: deliverId, handle: 'change' };
  const falseChain: Port[] = [];
  let falseCol = (falseFrom?.col ?? 0) + 1;
  let refusedCol = (refusedFrom?.col ?? 0) + 1;
  const place = (output: OutputRead, def: NodeTypeDef, config: Record<string, unknown>, step: { kind: DescribedStep['kind']; label: string }, title?: string): boolean => {
    if (output.branch === 'main') {
      const source = [deliverPort, pipelinePort].find((port) => port !== undefined && graph.feeds(port, def));
      if (source === undefined) return false;
      const sideOfRun = source === pipelinePort;
      const id = graph.add(def, sideOfRun ? deliverCol : deliverCol + 1, sideOfRun ? BELOW : MAIN, config, step, title);
      return graph.link(source, id);
    }
    if (output.branch === 'false') {
      if (falseFrom === undefined) return false;
      const source = falseChain[falseChain.length - 1] ?? falseFrom.port;
      if (!graph.feeds(source, def)) return false;
      const id = graph.add(def, falseCol, BELOW, config, { ...step, label: `${step.label} · otherwise` }, title);
      falseCol += 1;
      falseChain.push({ id });
      return graph.link(source, id);
    }
    if (refusedFrom === undefined || !graph.feeds(refusedFrom.port, def)) return false;
    const id = graph.add(def, refusedCol, BELOW, config, { ...step, label: `${step.label} · if refused` }, title);
    refusedCol += 1;
    return graph.link(refusedFrom.port, id);
  };
  const fromType = (branch: Branch): PortType[] => (branch === 'main' ? (['change', 'run'] as PortType[]) : branch === 'false' ? ['any'] : ['event']);
  const pick = (connector: Connector, keywords: string[], branch: Branch, fallback: boolean): NodeTypeDef | undefined => {
    for (const type of fromType(branch)) {
      const def = actionFor(connector, keywords, type, false);
      if (def !== undefined) return def;
    }
    if (!fallback) return undefined;
    for (const type of fromType(branch)) {
      const def = actionFor(connector, keywords, type, true);
      if (def !== undefined) return def;
    }
    return undefined;
  };

  const categoryWord = triage === undefined ? 'a match' : triage.ai ? article(triage.category) : triage.category;
  for (const output of outputs) {
    if (output.role === 'ticket' && output.branch === 'main') continue;
    const connector = getConnector(output.connectorId);
    if (connector === undefined) continue;
    if (output.role === 'comment' && output.branch === 'main') {
      const def = coreNode('delivery', 'action', ['comment']);
      if (def !== undefined) place(output, def, {}, { kind: 'delivery', label: 'Delivery · comment the summary on the issue' });
      continue;
    }
    if (output.role === 'notify') {
      const keywords = output.dm ? ['dm', 'direct', 'chat'] : output.branch === 'main' ? (policy === 'pr' || policy === 'merge' ? ['share', 'post', 'send', 'message'] : ['summary', 'post', 'send', 'message']) : ['post', 'send', 'message'];
      const def = pick(connector, keywords, output.branch, true);
      if (def === undefined) continue;
      const config: Record<string, unknown> = {};
      if (output.channel !== undefined) for (const key of ['channel', 'space']) if (hasField(def, key)) config[key] = output.channel;
      if (output.to !== undefined && hasField(def, 'to')) config['to'] = output.to;
      if (output.user !== undefined && hasField(def, 'user')) config['user'] = output.user;
      if (output.branch === 'refused') setMessage(def, config, 'Refused before any agent started: {{issue.title}} ({{issue.url}}).', 'Refused: {{issue.title}}');
      else if (output.branch === 'false') setMessage(def, config, `Not ${categoryWord}, so no agent picked it up: {{issue.title}} {{issue.url}}`, `Needs a person: {{issue.title}}`);
      else if (def.inputs.every((input) => input.type === 'any')) setMessage(def, config, `Done: {{issue.title}}. ${policy === 'pr' || policy === 'merge' ? 'Pull request: {{run.prUrl}}' : 'Branch: {{run.branch}}'} (cost {{run.cost}}).`, 'Done: {{issue.title}}');
      fillRequired(def, config, { slug, ...(output.channel === undefined ? {} : { channel: output.channel }), ...(output.to === undefined ? {} : { to: output.to }), ...(output.user === undefined ? {} : { user: output.user }) });
      const target = String(config['channel'] ?? config['space'] ?? config['to'] ?? config['user'] ?? '');
      if (config['to'] === 'you@example.com') notes.push(`${connector.name} sends to you@example.com for now: put your address in the step's settings.`);
      place(output, def, config, { kind: 'notify', label: `${connector.name} · ${def.name}${target === '' ? '' : ` to ${target}`}` });
      continue;
    }
    const def = pick(connector, output.keywords, output.branch, false);
    if (def === undefined) continue;
    const config: Record<string, unknown> = {};
    if (output.role === 'label' && output.label !== undefined) for (const key of ['label', 'tag', 'tags']) if (hasField(def, key)) config[key] = output.label;
    if (output.role === 'comment' && output.branch === 'false') setMessage(def, config, `Triage says this is not ${categoryWord}, so no agent picked it up. A person will take a look.`);
    if (output.role === 'comment' && output.branch === 'refused') setMessage(def, config, 'Not started: this was refused by a guardrail before any agent ran.');
    if (output.role === 'ticket' && hasField(def, 'body')) config['body'] = '{{issue.body}}\n\n{{issue.url}}';
    fillRequired(def, config, { slug });
    place(output, def, config, { kind: 'action', label: `${connector.name} · ${def.name}${output.role === 'label' && output.label !== undefined ? `: ${output.label}` : ''}` });
  }

  const now = new Date().toISOString();
  const deliveryShort = policy === 'pr' ? (draft ? 'draft PR' : 'PR') : policy === 'merge' ? 'merge' : policy === 'push' ? 'pushed branch' : policy === 'branch' ? 'branch' : 'diff';
  const name =
    task !== undefined ? (trigger.def.connectorId === 'logic' ? task : `${task} · ${trigger.short.charAt(0).toLowerCase()}${trigger.short.slice(1)}`)
    : `${trigger.short} → ${triage === undefined ? '' : 'triage → '}${pipelineRead.fast ? 'fast fix → ' : ''}${deliveryShort}`;
  let workflow: Workflow = {
    id: `wf_${nanoid(10)}`,
    name: name.length > 64 ? `${name.slice(0, 63).trimEnd()}…` : name,
    description: original,
    nodes: graph.nodes,
    edges: graph.edges,
    enabled: false,
    createdAt: now,
    updatedAt: now,
    repository,
  };
  let steps = orderSteps(graph);

  // A last line of defence: whatever the reader built must validate. Anything
  // optional that does not is dropped (and said so); if the core does not, the
  // minimal workflow stands in, so a sentence can never produce a broken graph.
  let checked = validateWorkflow(workflow);
  if (!checked.ok) {
    const bad = new Set(checked.issues.filter((issue) => issue.level === 'error' && issue.nodeId !== undefined).map((issue) => issue.nodeId));
    const optional = new Set(graph.steps.filter((step) => step.kind === 'notify' || step.kind === 'action').map((step) => step.nodeId));
    const dropped = graph.steps.filter((step) => bad.has(step.nodeId) && optional.has(step.nodeId));
    const nodes = workflow.nodes.filter((node) => !dropped.some((step) => step.nodeId === node.id));
    const badEdges = new Set(checked.issues.filter((issue) => issue.level === 'error' && issue.edgeId !== undefined).map((issue) => issue.edgeId));
    const edges = workflow.edges.filter((edge) => !badEdges.has(edge.id) && nodes.some((node) => node.id === edge.source) && nodes.some((node) => node.id === edge.target));
    workflow = { ...workflow, nodes, edges };
    steps = steps.filter((step) => nodes.some((node) => node.id === step.nodeId));
    for (const step of dropped) notes.push(`Left out “${step.label}”: it could not be wired in safely. Add it from the palette.`);
    checked = validateWorkflow(workflow);
    if (!checked.ok) {
      const minimal = minimalWorkflow(brand, repository, original);
      workflow = minimal.workflow;
      steps = minimal.steps;
      notes.push('That sentence did not add up to a workflow that would pass its checks, so this is the simplest one that does.');
    }
  }

  const understood = measure(reader);
  return {
    workflow,
    steps: steps.map(({ kind, label, typeId }) => ({ kind, label, typeId })),
    unmatched: understood.unmatched,
    notes: [...new Set(notes)],
    confidence: original === '' ? 0 : Math.round(understood.coverage * (trigger.explicit || task !== undefined ? 1 : 0.6) * 100) / 100,
  };
}

function resolveAgents(read: PipelineRead): Record<Role, Agent> {
  const other = (agent: Agent): Agent => (agent === 'claude' ? 'codex' : 'claude');
  const roles: Partial<Record<Role, Agent>> = { ...read.roles };
  if (read.worker !== undefined) roles.implementer ??= read.worker;
  // Keep the cross-review: whoever writes a thing, the other agent reviews it.
  if (roles.implementer !== undefined && roles.codeReviewer === undefined) roles.codeReviewer = other(roles.implementer);
  if (roles.codeReviewer !== undefined && roles.implementer === undefined) roles.implementer = other(roles.codeReviewer);
  if (roles.planner !== undefined && roles.planReviewer === undefined) roles.planReviewer = other(roles.planner);
  if (roles.planReviewer !== undefined && roles.planner === undefined) roles.planner = other(roles.planReviewer);
  return { planner: roles.planner ?? 'claude', planReviewer: roles.planReviewer ?? 'codex', implementer: roles.implementer ?? 'codex', codeReviewer: roles.codeReviewer ?? 'claude' };
}

function whoDoesWhat(roles: Record<Role, Agent>): string {
  const name = (role: Role) => AGENT_NAMES[roles[role]];
  if (new Set(Object.values(roles)).size === 1) return `${name('planner')} does everything (no cross-review)`;
  if (roles.planner === roles.codeReviewer && roles.implementer === roles.planReviewer) return `${name('planner')} plans and reviews, ${name('implementer')} implements`;
  if (roles.planner === roles.implementer && roles.planReviewer === roles.codeReviewer) return `${name('planner')} plans and implements, ${name('codeReviewer')} reviews`;
  const reviews = roles.planReviewer === roles.codeReviewer ? `${name('codeReviewer')} reviews` : `${name('planReviewer')} reviews the plan, ${name('codeReviewer')} the code`;
  return `${name('planner')} plans, ${name('implementer')} implements, ${reviews}`;
}

/** Main line left to right, then each branch, the way a person reads the canvas. */
function orderSteps(graph: Graph): Array<DescribedStep & { nodeId: string }> {
  const position = new Map(graph.nodes.map((node) => [node.id, node.position]));
  const main = (id: string) => (position.get(id)?.y ?? 0) === 120 + MAIN * ROW;
  return [...graph.steps].sort((a, b) => {
    const pa = position.get(a.nodeId)!;
    const pb = position.get(b.nodeId)!;
    const ma = main(a.nodeId) ? 0 : 1;
    const mb = main(b.nodeId) ? 0 : 1;
    return ma - mb || pa.x - pb.x || pa.y - pb.y;
  });
}

function minimalWorkflow(brand: Brand, repository: string, description: string): { workflow: Workflow; steps: Array<DescribedStep & { nodeId: string }> } {
  const graph = new Graph();
  const manual = coreNode('logic', 'trigger', ['manual']);
  const pipeline = coreNode('pipeline', 'action', ['run the pipeline']);
  const deliver = coreNode('delivery', 'action', ['deliver']);
  const ids: string[] = [];
  if (manual !== undefined) ids.push(graph.add(manual, 0, MAIN, {}, { kind: 'trigger', label: 'Manual start' }));
  if (pipeline !== undefined) ids.push(graph.add(pipeline, 1, MAIN, { branchPrefix: brand.slug }, { kind: 'pipeline', label: 'Agent pipeline · Claude plans and reviews, Codex implements' }));
  if (deliver !== undefined) ids.push(graph.add(deliver, 2, MAIN, { policy: 'pr', draft: true }, { kind: 'delivery', label: 'Deliver · draft pull request' }));
  for (let index = 1; index < ids.length; index++) graph.link({ id: ids[index - 1]! }, ids[index]!);
  const now = new Date().toISOString();
  return {
    workflow: { id: `wf_${nanoid(10)}`, name: 'Manual run → draft PR', description, nodes: graph.nodes, edges: graph.edges, enabled: false, createdAt: now, updatedAt: now, repository },
    steps: graph.steps,
  };
}

/* ------------------------------------------------------------------ */
/* How much was understood                                             */
/* ------------------------------------------------------------------ */

const STOPWORDS = new Set(
  (
    "a an the it its it's is are was were be been being and or but then than to of on in at for with from by as into onto over up out off so if when whenever while once each every any all some this that " +
    "these those there here me my mine i i'm i'd i'll we we're our us you your they them their he she his her him who whom which what where how please just also only very really new should would " +
    'will can could may might must do does did done get gets got have has had let lets make makes sure again always one first next finally after before until else otherwise not no yes via per ' +
    'someone somebody anyone something anything thing things way ok okay kindly want need needs like same too still now soon right away'
  ).split(/\s+/),
);

function measure(reader: Reader): { coverage: number; unmatched: string[] } {
  const words = [...reader.low.matchAll(/[a-z0-9$#@][\w'$#@./:-]*/g)];
  let total = 0;
  let understood = 0;
  const phrases: string[] = [];
  let current: { start: number; end: number } | undefined;
  const flush = () => {
    if (current !== undefined) phrases.push(reader.slice(current.start, current.end).replace(/[.,;:!?]+$/, ''));
    current = undefined;
  };
  for (const word of words) {
    const start = word.index ?? 0;
    const token = word[0].replace(/[.,;:!?]+$/, '');
    const end = start + token.length;
    const used = reader.isUsed(start) || !reader.isFree(start, end);
    const stop = STOPWORDS.has(token) || token.length < 2;
    if (!stop) {
      total += 1;
      if (used) understood += 1;
    }
    if (used) {
      flush();
      continue;
    }
    if (stop) continue;
    // One run of unread words per clause: a comma or "then" starts a new phrase.
    if (current !== undefined && /[,;.!?:→]|\bthen\b/.test(reader.low.slice(current.end, start))) flush();
    if (current === undefined) current = { start, end };
    else current.end = end;
  }
  flush();
  return { coverage: total === 0 ? 0 : understood / total, unmatched: [...new Set(phrases.filter((phrase) => phrase.length > 1))].slice(0, 6) };
}
