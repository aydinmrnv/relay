import type { Command } from 'commander';
import { EXIT } from '../exit.ts';
import { commandDocs } from '../help/commandDoc.ts';

function roff(value: unknown): string {
  return String(value).replaceAll('\\', '\\\\').replaceAll('-', '\\-').replace(/^\./gm, '\\&.');
}

export function generateManPage(program: Command): string {
  const commands = commandDocs(program).map((doc) => {
    const args = doc.arguments.map((arg) => `.TP\n\\fB${roff(arg.term)}\\fR\n${roff(arg.description)}`).join('\n');
    const options = doc.options.map((option) => `.TP\n\\fB${roff(option.flags)}\\fR\n${roff(option.description)}${option.defaultValue === undefined ? '' : ` Default: ${roff(option.defaultValue)}.`}`).join('\n');
    return `.SS ${roff(doc.name)}\n.B ${roff(doc.synopsis)}\n.PP\n${roff(doc.prose)}${doc.aliases.length ? `\nAliases: ${roff(doc.aliases.join(', '))}.` : ''}\n${args}\n${options}`;
  }).join('\n');
  const exits = Object.entries(EXIT).map(([name, code]) => `.TP\n.B ${code}\n${roff(name)}`).join('\n');
  return `.TH RELAY 1 "August 2026" "Relay" "User Commands"
.SH NAME
relay \- coordinate coding agents
.SH SYNOPSIS
.B relay
command [options]
.SH DESCRIPTION
${roff(program.description())}
.SH COMMANDS
${commands}
.SH CONFIGURATION
Repository configuration is stored in .relay/config.json.
.SH ENVIRONMENT
.TP
.B RELAY_HOME
Override Relay's data directory.
.TP
.B RELAY_ASCII
Use ASCII-only interface characters.
.TP
.B NO_COLOR
Disable colored output.
.SH EXIT STATUS
${exits}
`;
}
