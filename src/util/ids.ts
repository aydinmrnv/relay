import { randomUUID, randomBytes } from 'node:crypto';

const SHORT_ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/**
 * Short, lowercase, filesystem- and branch-name-safe identifier.
 * Ambiguous characters (l/1/o/0) are excluded so ids survive being read aloud
 * or copied out of a terminal.
 */
export function shortId(length = 6): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += SHORT_ID_ALPHABET[bytes[i]! % SHORT_ID_ALPHABET.length];
  }
  return out;
}

export function uuid(): string {
  return randomUUID();
}

/** Run ids sort lexicographically by creation time: `20260811T160530-a3f9kq`. */
export function createRunId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('Z', '');
  return `${stamp}-${shortId()}`;
}

const RUN_ID_PATTERN = /^[0-9]{8}T[0-9]{6}-[a-z0-9]{4,12}$/;

export function isRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value);
}
