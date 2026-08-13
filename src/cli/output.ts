import { isRelayError, errorMessage } from '../util/errors.ts';
import { asciiSafe, detectTheme, glyphs, paint, type Theme } from '../ui/theme.ts';
import { layoutWidth, panel, table, type Column, type PanelOptions } from '../ui/box.ts';
import { relayLogo } from '../ui/logo.ts';

let cachedTheme: Theme | undefined;

export function theme(): Theme {
  cachedTheme ??= detectTheme(humanStream);
  return cachedTheme;
}

/** Tests drive the primitives against a known theme instead of the real terminal. */
export function setTheme(next: Theme | undefined): void {
  cachedTheme = next;
}

/**
 * Where everything meant for a person goes. Stdout, until `--json` claims it:
 * a document being piped into `jq` cannot share a stream with the prose, frames
 * and advice printed around it, and diverting the sink once — here — is the
 * only version of that promise every existing call site keeps for free.
 */
let humanStream: NodeJS.WriteStream = process.stdout;

export function divertHumanOutput(): void {
  humanStream = process.stderr;
}

/** Tests run both modes in one process; the real CLI never goes back. */
export function restoreHumanOutput(): void {
  humanStream = process.stdout;
}

/**
 * Relay's own chrome: headings, rows, prose, hints. Downgraded to ASCII when
 * the terminal cannot show typographic characters, so `RELAY_ASCII=1` and
 * `TERM=dumb` really are ASCII without every sentence having to remember.
 */
export function out(text = ''): void {
  humanStream.write(`${asciiSafe(text, theme())}\n`);
}

/**
 * Content Relay is passing through unchanged — a patch, a JSON document, an
 * agent's plan. Never downgraded and never coloured: a rewritten patch does not
 * apply and rewritten JSON does not parse.
 */
export function raw(text: string): void {
  humanStream.write(`${text}\n`);
}

// ---------------------------------------------------------------------------
// Colourizers. These return strings so they can be composed inside a line.
// ---------------------------------------------------------------------------

export function dim(text: string): string {
  return paint(theme(), 'gray', text);
}

export function bold(text: string): string {
  return paint(theme(), 'bold', text);
}

export function success(text: string): string {
  return paint(theme(), 'green', text);
}

export function failure(text: string): string {
  return paint(theme(), 'red', text);
}

export function warning(text: string): string {
  return paint(theme(), 'yellow', text);
}

// ---------------------------------------------------------------------------
// Printers. Every command formats through these, so a heading, a key/value row
// or a hint looks the same whichever command produced it.
// ---------------------------------------------------------------------------

export function heading(text: string): void {
  out(bold(text));
}

// ---------------------------------------------------------------------------
// Chrome: the banner, frames and tables that make a command read as a screen.
//
// The division of labour with the plain printers above is deliberate. A frame
// is structure — it survives `cat`, it carries meaning about what belongs with
// what, and so it is drawn whether or not anything is watching. The banner is
// decoration, and decoration is drawn only for a person: a log collector does
// not need five rows of block letters at the top of every file.
// ---------------------------------------------------------------------------

/** Columns the current terminal lays out to. */
export function width(): number {
  return layoutWidth(process.stdout);
}

/**
 * The wordmark, at the top of the commands a session starts with. Prints
 * nothing when the output is not a terminal, so a piped `relay doctor` still
 * begins with its first real line.
 */
export function banner(tagline?: string): void {
  if (!theme().interactive) return;

  out();
  for (const line of relayLogo({
    theme: theme(),
    width: width(),
    ...(tagline === undefined ? {} : { tagline }),
  })) {
    out(line);
  }
  out();
}

/** A framed block. Takes everything `panel()` does except the theme and width. */
export function box(options: Omit<PanelOptions, 'theme' | 'width'> & { width?: number }): void {
  const { width: given, ...rest } = options;
  for (const line of panel({ ...rest, theme: theme(), width: given ?? width() })) out(line);
}

/**
 * Aligned columns, as lines. Returned rather than printed so a table can be a
 * panel's body as easily as it can be a block of its own.
 */
export function gridLines(columns: readonly Column[], data: ReadonlyArray<readonly string[]>): string[] {
  return table(theme(), columns, data);
}

/** A secondary heading inside a block, e.g. `Phases` above a list. */
export function section(text: string): void {
  out();
  out(bold(text));
}

export interface Row {
  label: string;
  value: string;
}

/**
 * Aligned key/value rows. The label column is sized from the group rather than
 * a global constant, so a block never pads to a width nothing in it needs.
 */
export function rows(entries: ReadonlyArray<Row | undefined | false>, indent = '  '): void {
  const present = entries.filter((entry): entry is Row => typeof entry === 'object' && entry !== null);
  if (present.length === 0) return;

  const width = Math.max(...present.map((entry) => entry.label.length));
  for (const entry of present) out(`${indent}${entry.label.padEnd(width)}  ${entry.value}`);
}

/** A single key/value row, for the cases where a group would be overkill. */
export function row(label: string, value: string, indent = '  '): void {
  rows([{ label, value }], indent);
}

export function ok(text: string): void {
  out(`${success(glyphs(theme()).ok)} ${text}`);
}

export function warn(text: string): void {
  out(`${warning('!')} ${text}`);
}

export function fail(text: string): void {
  out(`${failure(glyphs(theme()).failed)} ${text}`);
}

export function bullet(text: string, indent = '  '): void {
  out(`${indent}${dim(glyphs(theme()).bullet)} ${text}`);
}

/** Advice, never a result. Dimmed and indented so it reads as secondary. */
export function hint(text: string, indent = '  '): void {
  out(dim(`${indent}${text}`));
}

/** A command the user can copy, printed under a hint. */
export function command(text: string, indent = '  '): void {
  out(`${indent}${text}`);
}

/**
 * What a command prints when it has nothing to show. A bare header tells a new
 * user nothing, so an empty state always names the command that fills it.
 */
/** `+40 −7`. One spelling of a diff count, wherever the CLI shows one. */
export function changeCount(additions: number, deletions: number): string {
  return `+${additions} −${deletions}`;
}

/** Joins facts on one line: `main · 4m 2s · plan 2r`. */
export function facts(parts: ReadonlyArray<string | undefined | false>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join('  ·  ');
}

export function emptyState(message: string, next: readonly string[] = []): void {
  out(message);
  if (next.length === 0) return;
  out();
  for (const entry of next) command(entry);
}

/**
 * Prints an error with its actionable hint. RelayError carries the next step;
 * anything else is reported plainly rather than dressed up as advice.
 */
export function reportError(error: unknown): void {
  const message = errorMessage(error);
  process.stderr.write(`\n${failure('Error')} ${message}\n`);

  if (isRelayError(error) && error.hint !== undefined) {
    process.stderr.write(`\n${error.hint}\n`);
  }
  process.stderr.write('\n');
}
