import { Help, type Command } from 'commander';
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

export function commandDoc(command: Command): CommandDoc {
  const help = new Help();
  const path = command.name() === 'relay' ? 'relay' : `relay ${command.name()}`;
  return {
    name: command.name(), aliases: command.aliases(),
    synopsis: `${path}${command.registeredArguments.map((arg) => ` ${arg.required ? `<${arg.name()}>` : `[${arg.name()}]`}`).join('')}`,
    description: command.description(), prose: COMMAND_PROSE[command.name()] ?? command.description(),
    arguments: command.registeredArguments.map((arg) => ({ term: arg.required ? `<${arg.name()}>` : `[${arg.name()}]`, description: arg.description, defaultValue: arg.defaultValue })),
    options: help.visibleOptions(command).map((option) => ({ flags: option.flags, description: option.description, defaultValue: option.defaultValue })),
  };
}

export function commandDocs(program: Command): CommandDoc[] {
  return program.commands.filter((command) => !command.name().startsWith('__')).map(commandDoc);
}

/** Human help and the man page deliberately consume the same derived model. */
export function formatCommandDoc(command: Command): string {
  const doc = commandDoc(command);
  const sections = [
    `Usage: ${doc.synopsis}`,
    doc.prose,
    ...(doc.aliases.length === 0 ? [] : [`Aliases:\n  ${doc.aliases.join(', ')}`]),
    ...(doc.arguments.length === 0 ? [] : [
      `Arguments:\n${doc.arguments.map((arg) => `  ${arg.term.padEnd(20)}${arg.description}${arg.defaultValue === undefined ? '' : ` (default: ${String(arg.defaultValue)})`}`).join('\n')}`,
    ]),
    ...(doc.options.length === 0 ? [] : [
      `Options:\n${doc.options.map((option) => `  ${option.flags.padEnd(28)}${option.description}${option.defaultValue === undefined ? '' : ` (default: ${String(option.defaultValue)})`}`).join('\n')}`,
    ]),
  ];
  return `${sections.join('\n\n')}\n`;
}
