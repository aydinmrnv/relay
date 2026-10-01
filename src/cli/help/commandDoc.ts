import { Help, type Argument, type Command } from 'commander';
import { COMMAND_PROSE } from './prose.ts';

export interface CommandDoc {
  name: string;
  aliases: string[];
  synopsis: string;
  description: string;
  prose: string;
  arguments: { term: string; description: string; defaultValue?: unknown }[];
  options: { flags: string; description: string; defaultValue?: unknown }[];
}

/** `relay`, `relay connect`, `relay hub serve`: the words that reach a command. */
function commandPath(command: Command): string {
  const names: string[] = [];
  for (let current: Command | null = command; current !== null; current = current.parent) names.unshift(current.name());
  return names[0] === 'relay' ? names.join(' ') : ['relay', ...names].join(' ');
}

/** `<run-id>`, `[run-id]`, `[issue...]` — the argument as it is typed. */
function argumentTerm(arg: Argument): string {
  const name = `${arg.name()}${arg.variadic ? '...' : ''}`;
  return arg.required ? `<${name}>` : `[${name}]`;
}

/**
 * A default worth printing, or undefined when there is nothing to say.
 *
 * A repeatable flag collects into an array that starts empty, and "(default: )"
 * is what printing that array produces: a default that is the absence of one.
 * Only a default somebody could act on is shown.
 */
export function describeDefault(value: unknown): string | undefined {
  if (value === undefined || value === null || value === false) return undefined;
  if (Array.isArray(value)) return value.length === 0 ? undefined : value.map(String).join(', ');
  const text = String(value);
  return text.length === 0 ? undefined : text;
}

export function commandDoc(command: Command): CommandDoc {
  const help = new Help();
  const path = commandPath(command);
  return {
    name: command.name(), aliases: command.aliases(),
    synopsis: `${path}${command.registeredArguments.map((arg) => ` ${argumentTerm(arg)}`).join('')}`,
    description: command.description(), prose: COMMAND_PROSE[command.name()] ?? command.description(),
    arguments: command.registeredArguments.map((arg) => ({ term: argumentTerm(arg), description: arg.description, defaultValue: arg.defaultValue })),
    options: help.visibleOptions(command).map((option) => ({ flags: option.flags, description: option.description, defaultValue: option.defaultValue })),
  };
}

/**
 * The commands a person is shown: everything registered except the ones
 * marked hidden — Relay's own plumbing, and the hub, which only whoever hosts
 * Relay Cloud ever runs — and Commander's implicit `help`.
 */
export function visibleCommands(command: Command): Command[] {
  return new Help().visibleCommands(command).filter((child) => child.name() !== 'help');
}

export function commandDocs(program: Command): CommandDoc[] {
  return visibleCommands(program).map(commandDoc);
}

/**
 * One `term  description` row, wrapped to the terminal with the continuation
 * lines hanging under the description — the layout Commander gives its own
 * help, so the two read as one tool at any width.
 */
export function helpRow(term: string, description: string, termWidth: number, width: number): string {
  const row = `${term.padEnd(termWidth + 2)}${description}`;
  return new Help().wrap(row, Math.max(40, width) - 2, termWidth + 2).replace(/^/gm, '  ');
}

function rows(entries: ReadonlyArray<readonly [string, string]>, width: number): string {
  const termWidth = Math.max(...entries.map(([term]) => term.length));
  return entries.map(([term, description]) => helpRow(term, description, termWidth, width)).join('\n');
}

/** Human help and the man page deliberately consume the same derived model. */
export function formatCommandDoc(command: Command, width = 80): string {
  const doc = commandDoc(command);
  const children = visibleCommands(command);
  const withDefault = (description: string, value: unknown): string => {
    const fallback = describeDefault(value);
    return fallback === undefined ? description : `${description} (default: ${fallback})`;
  };
  const sections = [
    `Usage: ${doc.synopsis}${children.length > 0 ? ' <command>' : ''}`,
    new Help().wrap(doc.prose, Math.max(40, width), 0),
    ...(children.length === 0 ? [] : [`Commands:\n${rows(children.map((child) => [child.name(), child.description()] as const), width)}`]),
    ...(doc.aliases.length === 0 ? [] : [`Aliases:\n  ${doc.aliases.join(', ')}`]),
    ...(doc.arguments.length === 0 ? [] : [
      `Arguments:\n${rows(doc.arguments.map((arg) => [arg.term, withDefault(arg.description, arg.defaultValue)] as const), width)}`,
    ]),
    ...(doc.options.length === 0 ? [] : [
      `Options:\n${rows(doc.options.map((option) => [option.flags, withDefault(option.description, option.defaultValue)] as const), width)}`,
    ]),
  ];
  return `${sections.join('\n\n')}\n`;
}
