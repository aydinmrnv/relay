/**
 * One argument for a command somebody is going to paste into a terminal.
 *
 * A workflow's name and its label are whatever a person typed, or whatever
 * came in with an import or a shared workflow, and they end up inside
 * commands the studio shows to be copied. In single quotes a POSIX shell
 * reads nothing: no `$(…)`, no backticks, no `!`. A plain word needs none.
 */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value) && !value.startsWith('-')) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A folder to `cd` into, which must not be read as an option when it starts with a dash. */
export function shellPath(name: string): string {
  return shellQuote(name.startsWith('-') ? `./${name}` : name);
}
