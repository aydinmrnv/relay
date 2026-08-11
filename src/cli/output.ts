import { isRelayError, errorMessage } from '../util/errors.ts';
import { detectTheme, paint, type Theme } from '../ui/theme.ts';

let cachedTheme: Theme | undefined;

export function theme(): Theme {
  cachedTheme ??= detectTheme(process.stdout);
  return cachedTheme;
}

export function out(text = ''): void {
  process.stdout.write(`${text}\n`);
}

export function heading(text: string): void {
  out(paint(theme(), 'bold', text));
}

export function dim(text: string): string {
  return paint(theme(), 'gray', text);
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
