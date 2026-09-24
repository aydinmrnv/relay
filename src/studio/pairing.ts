import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The pairing secret between this machine and a studio.
 *
 * The companion can start agents that write code, so whoever holds this can do
 * that. It is 256 random bits, kept in a file only this user can read, and it
 * travels to the studio once — in the fragment of the pairing link, which a
 * browser never sends to a server. Rotating it (`relay connect --new-token`)
 * unpairs every studio that had the old one.
 */

interface PairingFile {
  token: string;
  createdAt: string;
}

export function relayHome(): string {
  const home = process.env['RELAY_HOME'];
  return home !== undefined && home.length > 0 ? home : join(homedir(), '.relay');
}

export function pairingPath(): string {
  return join(relayHome(), 'studio.json');
}

export function createToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The saved token, or a new one written in its place. */
export async function loadPairingToken(options: { rotate?: boolean } = {}): Promise<{ token: string; created: boolean }> {
  const path = pairingPath();
  if (options.rotate !== true) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<PairingFile>;
      if (typeof parsed.token === 'string' && parsed.token.length >= 32) return { token: parsed.token, created: false };
    } catch (error) {
      // Missing is the first run; unreadable or malformed is replaced rather
      // than trusted.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }
  const token = createToken();
  const body: PairingFile = { token, createdAt: new Date().toISOString() };
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, path);
  // `mode` only applies to a file the write created; tighten one that existed.
  await chmod(path, 0o600).catch(() => undefined);
  return { token, created: true };
}

/** Compares in constant time, so the answer's timing says nothing about the token. */
export function tokensMatch(expected: string, presented: string | null | undefined): boolean {
  if (presented === null || presented === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** The link that pairs a studio: the token rides in the fragment, which never reaches a server. */
export function pairingUrl(studioUrl: string, port: number, token: string): string {
  const base = studioUrl.replace(/\/+$/, '');
  const fragment = new URLSearchParams({ port: String(port), token }).toString();
  return `${base}/connect#${fragment}`;
}
