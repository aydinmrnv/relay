import type { Command } from 'commander';
import { EXIT, EXIT_MEANINGS } from '../exit.ts';
import { commandDocs, describeDefault } from '../help/commandDoc.ts';

function roff(value: unknown): string {
  return String(value).replaceAll('\\', '\\\\').replaceAll('-', '\\-').replace(/^\./gm, '\\&.');
}

export interface ManPageOptions {
  /** The version the page documents, for its footer. */
  version?: string;
  /** When the page was generated. Injectable so a test can pin it. */
  date?: Date;
}

/** `October 2026`: the form `man` shows in the footer of every page. */
function monthAndYear(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * The manual page, generated from the same command model `--help` prints.
 *
 * The date and the version in the title line are the build's own: a page that
 * carried a date somebody typed would be describing a release that shipped
 * months ago by the second time anybody packed it.
 */
export function generateManPage(program: Command, options: ManPageOptions = {}): string {
  const version = options.version === undefined || options.version === 'unknown' ? 'Relay' : `Relay ${options.version}`;
  const commands = commandDocs(program).map((doc) => {
    const args = doc.arguments.map((arg) => `.TP\n\\fB${roff(arg.term)}\\fR\n${roff(arg.description)}`).join('\n');
    const flags = doc.options.map((option) => {
      const fallback = describeDefault(option.defaultValue);
      return `.TP\n\\fB${roff(option.flags)}\\fR\n${roff(option.description)}${fallback === undefined ? '' : ` Default: ${roff(fallback)}.`}`;
    }).join('\n');
    return `.SS ${roff(doc.name)}\n.B ${roff(doc.synopsis)}\n.PP\n${roff(doc.prose)}${doc.aliases.length ? `\nAliases: ${roff(doc.aliases.join(', '))}.` : ''}\n${args}\n${flags}`;
  }).join('\n');
  const exits = (Object.keys(EXIT) as Array<keyof typeof EXIT>)
    .map((name) => `.TP\n.B ${EXIT[name]}\n${roff(EXIT_MEANINGS[name])}`)
    .join('\n');
  return `.TH RELAY 1 "${monthAndYear(options.date ?? new Date())}" "${roff(version)}" "User Commands"
.SH NAME
relay \\- coordinate coding agents
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
Use ASCII\\-only interface characters. Unset, empty, 0 or false leaves them on.
.TP
.B RELAY_STUDIO_URL
The studio relay connect pairs with, instead of the hosted one.
.TP
.B RELAY_COMPANION_PORT
The port relay connect listens on, instead of 4477.
.TP
.B RELAY_NO_OS_SANDBOX
Set to 1 to stop wrapping read\\-only agent turns in the operating system's sandbox.
.TP
.B LINEAR_API_KEY
The personal API key Relay reads when an issue lives in Linear.
.TP
.B NO_COLOR
Disable colored output.
.SH EXIT STATUS
${exits}
`;
}
