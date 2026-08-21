import type { Command, Option } from 'commander';
import { repositoryRoot } from '../../git/repository.ts';
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

export async function completionCandidates(program: Command, words: readonly string[]): Promise<string[]> {
  const deadline = withDeadline();
  try {
    const commandToken = words[0] ?? '';
    const command = program.commands.find(
      (item) => item.name() === commandToken || item.aliases().includes(commandToken),
    );
    if (command === undefined) return program.commands.filter((item) => !item.name().startsWith('__')).flatMap((item) => [item.name(), ...item.aliases()]).filter((x) => x.startsWith(commandToken));

    let current = words.at(-1) ?? '';
    if (current.startsWith('-') && !current.includes('=')) {
      return command.options
        .flatMap((item) => [item.short, item.long])
        .filter((item): item is string => item !== undefined && item.startsWith(current));
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
