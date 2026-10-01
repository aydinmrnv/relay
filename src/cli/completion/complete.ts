import type { Command, Option } from 'commander';
import { repositoryRoot } from '../../git/repository.ts';
import { visibleCommands } from '../help/commandDoc.ts';
import { agentNames, deliveryPolicies, localBranches, mergeMethods, reviewLevels, runRefs } from './candidates.ts';
import { withDeadline } from './deadline.ts';

const RUN_COMMANDS = new Set(['resume', 'deliver', 'status', 'watch', 'diff', 'plan', 'logs', 'stop']);

function valueOption(command: Command, token: string): Option | undefined {
  const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
  return command.options.find((option) => option.long === name || option.short === name);
}

async function beforeDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('completion deadline exceeded');
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new Error('completion deadline exceeded'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

/**
 * Stands in for the word being typed when it is empty.
 *
 * Every shell tells `__complete` what is being completed by passing it as the
 * last word, empty when the cursor is on a fresh one — `relay status ` asks for
 * every run, `relay status la` asks for the ones starting `la`. Windows
 * PowerShell drops empty arguments on their way to a native command, so that
 * distinction does not survive the trip and `relay status ` would arrive
 * looking like `relay status`, asking for runs named "status". The generated
 * PowerShell script sends this instead of an empty word; nothing else does,
 * and no real command line contains it.
 */
export const EMPTY_WORD = '--relay-empty-word';

/** The flags a command answers to, minus the ones it deliberately does not advertise. */
export function commandFlags(command: Command): string[] {
  return [
    ...command.options.filter((option) => !option.hidden).flatMap((option) => [option.short, option.long]),
    // Commander answers `--help` on every command without listing it as an option.
    '-h',
    '--help',
  ].filter((flag): flag is string => flag !== undefined);
}

/**
 * The commands that may follow `command`, by every name they answer to.
 *
 * A hidden command is left out of the list it would be discovered from and is
 * still walked into when somebody types it: `relay <TAB>` does not offer `hub`,
 * and `relay hub <TAB>` completes its subcommands.
 */
export function subcommandNames(command: Command): string[] {
  return visibleCommands(command).flatMap((child) => [child.name(), ...child.aliases()]);
}

export async function completionCandidates(
  program: Command,
  rawWords: readonly string[],
): Promise<string[]> {
  const words = rawWords.map((word) => (word === EMPTY_WORD ? '' : word));
  // No words at all is the cursor on a fresh first word, from a shell that
  // drops an empty argument on its way here.
  if (words.length === 0) words.push('');
  const deadline = withDeadline();
  try {
    let current = words.at(-1) ?? '';

    // Walk down through every command already typed. The last word is the one
    // being completed, so it is never consumed as a command name: `relay hub`
    // with the cursor still on `hub` is asking for commands that start "hub".
    let command = program;
    let depth = 0;
    for (; depth < words.length - 1; depth += 1) {
      const token = words[depth];
      const next = command.commands.find((item) => item.name() === token || item.aliases().includes(token ?? ''));
      if (next === undefined) break;
      command = next;
    }

    if (current.startsWith('-') && !current.includes('=')) {
      return commandFlags(command).filter((flag) => flag.startsWith(current));
    }

    // Every word before the cursor named a command, and the one reached
    // dispatches to others: the candidates are those commands. This is what
    // answers `relay <TAB>` and `relay hub <TAB>` alike.
    if (depth === words.length - 1 && command.commands.length > 0) {
      return subcommandNames(command).filter((name) => name.startsWith(current));
    }

    let optionToken: string | undefined;
    if (current.startsWith('--') && current.includes('=')) {
      optionToken = current;
      current = current.slice(current.indexOf('=') + 1);
    } else {
      const previous = words.at(-2);
      if (previous !== undefined && valueOption(command, previous)?.required === true) optionToken = previous;
    }

    let candidates: string[] = [];
    const option = optionToken === undefined ? undefined : valueOption(command, optionToken);
    if (option?.long === '--planner' || option?.long === '--implementer') candidates = agentNames();
    else if (option?.long === '--deliver' || option?.long === '--to') candidates = deliveryPolicies();
    else if (option?.long === '--merge-method') candidates = mergeMethods();
    else if (option?.long === '--review') candidates = reviewLevels();
    else {
      const needsRepo = option?.long === '--base' || RUN_COMMANDS.has(command.name());
      if (!needsRepo) return [];
      const root = await repositoryRoot(process.cwd(), { signal: deadline.signal, timeoutMs: deadline.remaining() });
      candidates = option?.long === '--base'
        ? await localBranches(root, { signal: deadline.signal, timeoutMs: deadline.remaining() })
        : await beforeDeadline(runRefs(root), deadline.signal);
    }
    return [...new Set(candidates)].filter((candidate) => candidate.startsWith(current));
  } catch {
    return [];
  } finally {
    deadline.dispose();
  }
}

export async function completeCommand(program: Command, words: readonly string[]): Promise<void> {
  try {
    const candidates = await completionCandidates(program, words);
    if (candidates.length > 0) process.stdout.write(`${candidates.join('\n')}\n`);
  } catch {
    // Completion is deliberately silent and successful in every failure mode.
  }
}
