import { divertHumanOutput, setTheme } from './output.ts';
import { detectTheme } from '../ui/theme.ts';
import { errorMessage, isRelayError } from '../util/errors.ts';
import { redact } from '../util/redact.ts';

/**
 * Machine-readable output.
 *
 * Two rules hold for every `--json` invocation, and everything in this file
 * exists to keep them.
 *
 * **Stdout carries the document and nothing else.** No banner, no frame, no
 * progress, no colour, no advice — those all move to stderr — so
 * `relay run --json | jq` works while the run is still printing.
 *
 * **Every document carries `schema`.** The point of machine-readable output is
 * that something depends on it, and the moment something does, the shape is a
 * contract. `schema` is the version of that contract.
 */

/**
 * Bumped when a field is removed, renamed, or changes meaning. Adding a field
 * is not a bump: a consumer that ignores unknown keys survives it, and one that
 * does not was never going to survive any change at all.
 */
export const SCHEMA_VERSION = 1;

/** What every Relay JSON document leads with, whatever command produced it. */
export interface JsonEnvelope {
  schema: number;
  /** The command that produced it, so a stream of mixed lines is self-describing. */
  command: string;
}

export type JsonDocument<T> = JsonEnvelope & T;

/** Wraps a payload in the envelope. The version leads; the body follows. */
export function jsonDocument<T extends object>(command: string, body: T): JsonDocument<T> {
  return { schema: SCHEMA_VERSION, command, ...body };
}

let active = false;

/** Whether this invocation was asked for JSON. */
export function jsonMode(): boolean {
  return active;
}

/**
 * Turns JSON mode on for the rest of the process.
 *
 * Relay's own chrome moves to stderr, and the theme is pinned to
 * non-interactive so nothing tries to redraw in place or ask a question behind
 * a document that is being piped into something.
 */
export function enterJsonMode(): void {
  if (active) return;
  active = true;
  divertHumanOutput();
  setTheme({ color: false, unicode: detectTheme(process.stderr).unicode, interactive: false });
}

/** Tests run many invocations in one process; the real CLI never leaves it. */
export function exitJsonMode(): void {
  active = false;
}

/**
 * One document, pretty-printed, for a command that reports once and exits.
 * Written straight to stdout rather than through `output.ts`: indented JSON is
 * not Relay's chrome and must never be downgraded, coloured or wrapped.
 */
export function emitJson<T extends object>(command: string, body: T): void {
  process.stdout.write(`${JSON.stringify(jsonDocument(command, body), null, 2)}\n`);
}

/**
 * One line of a stream, for a command that reports as it goes. Newline-
 * delimited and never indented, so a reader can parse each line the moment it
 * arrives instead of waiting for a run to finish.
 */
export function emitJsonLine<T extends object>(command: string, body: T): void {
  process.stdout.write(`${JSON.stringify(jsonDocument(command, body))}\n`);
}

/** What a command that failed under `--json` puts on stdout. */
export interface ErrorJson {
  type: 'error';
  /** The code the command is about to exit with, from the documented table. */
  exitCode: number;
  error: {
    /** Stable and machine-readable: `RUN_NOT_FOUND`, `BAD_CONFIG`, … */
    code: string;
    message: string;
    /** The next step, when Relay knows one. */
    hint: string | null;
  };
}

/**
 * A failure, as a document.
 *
 * Under `--json` stdout is the only stream a consumer parses, and a command
 * that failed used to leave it empty: the reason was prose on stderr, and what
 * was piped into `jq` was nothing at all. The prose still goes to stderr for
 * whoever is reading the log; this is the same failure for whatever is reading
 * the pipe. One line, so it parses as the last record of a stream and as the
 * whole document of a command that reports once.
 */
export function errorToJson(error: unknown, exitCode: number): ErrorJson {
  const relay = isRelayError(error) ? error : undefined;
  return {
    type: 'error',
    exitCode,
    error: {
      code: relay?.code ?? 'ERROR',
      message: redact(errorMessage(error)),
      hint: relay?.hint === undefined ? null : redact(relay.hint),
    },
  };
}
