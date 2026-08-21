/**
 * What you can type at Relay, and what each of those things means.
 *
 * The session used to ask one question — "next issue?" — and accept one kind of
 * answer. But a run has never needed a tracker: `--prompt` and `--editor` have
 * always been able to start one from a sentence. The prompt was the only thing
 * still insisting on a ticket, which made the shortest path to "just do this
 * for me" a flag nobody discovers.
 *
 * So the prompt takes what you have. An issue number is an issue, a path is a
 * spec file, a slash is a command, and anything else is the task itself. The
 * classification is pure and lives here rather than in the loop, because it is
 * also what the composer's caption reads back while you type — the interpretation
 * is shown before Enter, not discovered after it.
 */
import { parseIssueRef } from '../github/provider.ts';
import { looksLikePath } from '../issues/local.ts';
import { DELIVERY_POLICIES, isDeliveryPolicy } from '../storage/config.ts';
import { AGENT_PROVIDERS, isAgentProvider } from '../agents/index.ts';
import { REVIEW_LEVELS, describeReview, isReviewLevel, reviewProfile, type ReviewLevel } from '../reviews/level.ts';
import type { PromptSession } from '../ui/prompt.ts';
import type { RunOptions } from './commands/run.ts';
import { statusCommand } from './commands/inspect.ts';
import { bold, dim, gridLines, out, warning } from './output.ts';

/** Typed instead of a task when you are done for now. Enter does the same. */
const QUIT = new Set(['q', 'quit', 'exit', ':q']);

export type ChatIntent =
  | { kind: 'exit' }
  | { kind: 'issue'; ref: string }
  | { kind: 'file'; path: string }
  | { kind: 'task'; text: string }
  | { kind: 'command'; name: string; argument: string };

/**
 * Reads one line of chat input.
 *
 * The order is the interesting part. A tracker reference wins over a file that
 * happens to share its name, and both win over prose — the same precedence
 * `relay run` has applied to its argument since the first release, so a thing
 * you could type there means the same thing here.
 */
export function parseChatInput(input: string): ChatIntent {
  const text = input.trim();
  if (text.length === 0 || QUIT.has(text.toLowerCase())) return { kind: 'exit' };

  if (text.startsWith('/')) {
    const [name = '', ...rest] = text.slice(1).split(/\s+/);
    return { kind: 'command', name: name.toLowerCase(), argument: rest.join(' ').trim() };
  }

  // A reference or a path is a whole answer, never part of one. The test is
  // whitespace rather than shape: `looksLikePath` accepts anything containing a
  // slash, which is true of "fix the retry in src/net/retry.ts" — a task
  // description, and the exact sentence this prompt exists to accept.
  if (!/\s/.test(text)) {
    if (isTrackerRef(text)) return { kind: 'issue', ref: text };
    if (looksLikePath(text)) return { kind: 'file', path: text };
  }
  return { kind: 'task', text };
}

function isTrackerRef(text: string): boolean {
  try {
    parseIssueRef(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The caption under the composer: what pressing Enter would do right now.
 *
 * Short, because it is redrawn on every keystroke and read out of the corner of
 * an eye. Its whole job is to catch the two mistakes this prompt makes possible
 * — a mistyped issue number quietly becoming a task description, and a slash
 * command that does not exist — before they cost a run.
 */
export function describeChatInput(input: string): string {
  const text = input.trim();
  if (text.length === 0) return '';

  const intent = parseChatInput(text);
  switch (intent.kind) {
    case 'exit':
      return 'leave';
    case 'issue':
      return `issue ${intent.ref.startsWith('#') || /^\d+$/.test(intent.ref) ? `#${intent.ref.replace(/^#/, '')}` : intent.ref}`;
    case 'file':
      return `spec file ${intent.path}`;
    case 'command': {
      const command = findCommand(intent.name);
      return command === undefined ? `unknown command /${intent.name} — /help lists them` : `/${command.name} — ${command.summary}`;
    }
    case 'task': {
      const words = text.split(/\s+/).length;
      return `new task · ${words} word${words === 1 ? '' : 's'} · no ticket needed`;
    }
  }
}

// ---------------------------------------------------------------------------
// Commands.
//
// A command changes what the *next* run does, or shows something, and then
// hands the prompt back. Nothing here starts work by itself except by asking
// the loop to, which is what keeps the loop the only place a run begins.
// ---------------------------------------------------------------------------

export type ChatAction =
  | { kind: 'prompt' }
  /** Redraw the home screen before asking again: something on it changed. */
  | { kind: 'screen' }
  | { kind: 'run'; issueRef?: string; options?: Partial<RunOptions> }
  | { kind: 'exit' };

export interface ChatContext {
  /** The flags every run in this session starts with. Commands edit it in place. */
  options: RunOptions;
  prompter: PromptSession;
}

export interface ChatCommand {
  name: string;
  /** Shown after the name in `/help`, e.g. `[level]`. */
  argument?: string;
  summary: string;
  run(argument: string, context: ChatContext): Promise<ChatAction> | ChatAction;
}

export const CHAT_COMMANDS: readonly ChatCommand[] = [
  {
    name: 'help',
    summary: 'everything you can type here',
    run: () => {
      printChatHelp();
      return { kind: 'prompt' };
    },
  },
  {
    name: 'review',
    argument: '[level]',
    summary: 'how hard the agents look at the work',
    run: async (argument, context) => reviewCommand(argument, context),
  },
  {
    name: 'agents',
    argument: '[planner] [implementer]',
    summary: 'which CLI plans, and which one implements',
    run: async (argument, context) => agentsCommand(argument, context),
  },
  {
    name: 'deliver',
    argument: '[policy]',
    summary: 'how far a finished run carries its own work',
    run: async (argument, context) => deliverCommand(argument, context),
  },
  {
    name: 'issues',
    summary: 'pick from the open issues instead of typing one',
    run: () => ({ kind: 'run' }),
  },
  {
    name: 'editor',
    summary: 'write the task in $EDITOR, the way `git commit` does',
    run: () => ({ kind: 'run', options: { editor: true } }),
  },
  {
    name: 'verbose',
    summary: 'stream raw agent events during a run',
    run: (_argument, context) => {
      context.options.verbose = context.options.verbose !== true;
      out(dim(`  Raw agent events ${context.options.verbose === true ? 'on' : 'off'} for the next run.`));
      return { kind: 'prompt' };
    },
  },
  {
    name: 'status',
    summary: 'what the runs in this repository did',
    run: async () => {
      await statusCommand();
      return { kind: 'prompt' };
    },
  },
  {
    name: 'clear',
    summary: 'clear the screen and draw it again',
    run: () => {
      // Home and cursor, then erase everything below: the same two sequences
      // `clear(1)` writes, without shelling out to find out.
      process.stdout.write('\u001B[H\u001B[2J\u001B[3J');
      return { kind: 'screen' };
    },
  },
  {
    name: 'exit',
    summary: 'leave — `relay` opens this screen again',
    run: () => ({ kind: 'exit' }),
  },
];

export function findCommand(name: string): ChatCommand | undefined {
  const normalized = name.toLowerCase();
  if (normalized === 'quit' || normalized === 'q') return CHAT_COMMANDS.find((command) => command.name === 'exit');
  return CHAT_COMMANDS.find((command) => command.name === normalized);
}

/** What Tab offers: every command, spelled the way it is typed. */
export function chatCompletions(): string[] {
  return CHAT_COMMANDS.map((command) => `/${command.name}`);
}

export async function runChatCommand(
  name: string,
  argument: string,
  context: ChatContext,
): Promise<ChatAction> {
  const command = findCommand(name);
  if (command === undefined) {
    out(warning(`  /${name} is not a command.`));
    out(dim('  /help lists them.'));
    return { kind: 'prompt' };
  }
  return command.run(argument, context);
}

/**
 * `/review` — the dial, from the prompt.
 *
 * With no argument it offers the levels rather than demanding one be
 * remembered: this is the setting most worth changing per task, and a menu of
 * five is faster to read than the documentation for one flag.
 */
async function reviewCommand(argument: string, context: ChatContext): Promise<ChatAction> {
  let level: ReviewLevel | undefined;

  if (argument.length === 0) {
    const current = (context.options.review ?? 'standard') as ReviewLevel;
    const items = REVIEW_LEVELS.map((candidate) => ({
      value: candidate,
      label: candidate.padEnd(10),
      hint: reviewProfile(candidate).headline,
    }));
    const index = REVIEW_LEVELS.indexOf(current);
    level = await context.prompter.select('  How hard should the agents look?', items, index < 0 ? 2 : index);
  } else if (isReviewLevel(argument.toLowerCase())) {
    level = argument.toLowerCase() as ReviewLevel;
  } else {
    out(warning(`  "${argument}" is not a review level.`));
    out(dim(`  One of: ${REVIEW_LEVELS.join(', ')}.`));
    return { kind: 'prompt' };
  }

  context.options.review = level;
  // `--fast` and `--review` mean the same dial, and a session that carries both
  // would refuse its own next run.
  delete context.options.fast;

  const profile = reviewProfile(level);
  out(`  Review ${bold(level)} ${dim(`— ${profile.headline}`)}`);
  // The level's own numbers, because setting a level is what just happened —
  // the screen redrawn underneath reports the effective ones, including
  // anything the repository tuned on top.
  out(
    dim(
      `  ${describeReview({
        review: level,
        plan: profile.plan,
        reviewCode: profile.reviewCode,
        maxPlanReviewRounds: profile.maxPlanReviewRounds,
        maxCodeReviewRounds: profile.maxCodeReviewRounds,
      })}`,
    ),
  );
  return { kind: 'screen' };
}

/** `/agents claude codex` — who plans, and who writes it. */
async function agentsCommand(argument: string, context: ChatContext): Promise<ChatAction> {
  const [planner, implementer] = argument.split(/\s+/).filter((part) => part.length > 0);

  if (planner === undefined) {
    const items = AGENT_PROVIDERS.map((name) => ({ value: name, label: name }));
    const chosen = await context.prompter.select('  Which agent plans and reviews the code?', items, 0);
    context.options.planner = chosen;
    const others = items.filter((item) => item.value !== chosen);
    context.options.implementer = await context.prompter.select(
      '  Which agent implements and reviews the plan?',
      others.length > 0 ? others : items,
      0,
    );
  } else {
    for (const [value, flag] of [[planner, 'planner'], [implementer, 'implementer']] as const) {
      if (value === undefined) continue;
      if (!isAgentProvider(value)) {
        out(warning(`  "${value}" is not an installed agent.`));
        out(dim(`  One of: ${AGENT_PROVIDERS.join(', ')}.`));
        return { kind: 'prompt' };
      }
      context.options[flag] = value;
    }
  }

  if (context.options.planner === context.options.implementer) {
    out(warning('  The same agent now plans and implements, so it reviews its own work.'));
  }
  return { kind: 'screen' };
}

/** `/deliver pr` — how far the next run carries what it produced. */
async function deliverCommand(argument: string, context: ChatContext): Promise<ChatAction> {
  let policy = argument.trim().toLowerCase();

  if (policy.length === 0) {
    policy = await context.prompter.select(
      '  How far should a finished run carry its work?',
      DELIVERY_POLICIES.map((candidate) => ({
        value: candidate as string,
        label: candidate.padEnd(7),
        hint: deliveryHint(candidate),
      })),
      DELIVERY_POLICIES.indexOf('branch'),
    );
  }

  if (!isDeliveryPolicy(policy)) {
    out(warning(`  "${argument}" is not a delivery policy.`));
    out(dim(`  One of: ${DELIVERY_POLICIES.join(', ')}.`));
    return { kind: 'prompt' };
  }

  context.options.deliver = policy;
  out(dim(`  Delivery ${policy}: ${deliveryHint(policy)}.`));
  return { kind: 'screen' };
}

function deliveryHint(policy: string): string {
  switch (policy) {
    case 'none':
      return 'leaves the diff in the worktree';
    case 'branch':
      return 'commits to the run branch and stops';
    case 'push':
      return 'commits and pushes the run branch';
    case 'pr':
      return 'commits, pushes and opens a pull request';
    default:
      return 'commits, pushes, opens a pull request and merges it';
  }
}

export function printChatHelp(): void {
  out();
  out(bold('  Type the work'));
  for (const line of gridLines(
    [{ header: '' }, { header: '' }],
    [
      ['a sentence', 'starts a run from what you typed — no ticket needed'],
      ['142, owner/repo#142', 'starts a run from that issue'],
      ['./spec.md', 'starts a run from a markdown file'],
    ],
  )) {
    out(`    ${line}`);
  }

  out();
  out(bold('  Commands'));
  for (const line of gridLines(
    [{ header: '' }, { header: '' }],
    CHAT_COMMANDS.map((command) => [
      `/${command.name}${command.argument === undefined ? '' : ` ${command.argument}`}`,
      command.summary,
    ]),
  )) {
    out(`    ${line}`);
  }

  out();
  out(bold('  Keys'));
  for (const line of gridLines(
    [{ header: '' }, { header: '' }],
    [
      ['Enter', 'start — on an empty line, leave'],
      ['Tab', 'complete a /command'],
      ['Up / Down', 'what you typed before'],
      ['Ctrl-C', 'leave'],
    ],
  )) {
    out(`    ${line}`);
  }
  out();
}
