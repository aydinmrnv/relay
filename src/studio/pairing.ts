import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Pairing this machine with a studio.
 *
 * The companion can start agents that write code, so whoever can talk to it
 * can do that. Two secrets are involved, and only one of them ever leaves
 * this machine:
 *
 *   - **The machine's secret**: 256 random bits in a file only this user can
 *     read (`~/.relay/studio.json`). It never goes to a browser. It is how a
 *     second `relay connect` recognises the first, and it is the key the
 *     session token is derived from. `relay connect --new-token` replaces it.
 *   - **The session token**: what a paired studio presents. It is derived
 *     from the machine's secret and a nonce this process made when it
 *     started, so it is different for every start of `relay connect` and
 *     stops being good the moment that process ends. It travels to the studio
 *     once, in the fragment of the pairing link, which a browser never sends
 *     to a server, and the studio keeps it in its own storage.
 *
 * The studio's copy used to be the machine's secret itself, good for ever: a
 * token lifted from a browser's storage — by a script injected into the
 * studio, or by whoever later holds the studio's hostname — would drive this
 * machine whenever `relay connect` was running, for as long as the file was
 * not rotated by hand. A lifted session token is good until `relay connect`
 * next stops, and the first run it asks for is confirmed in the terminal
 * (`confirm.ts`).
 */

interface PairingFile {
  token: string;
  createdAt: string;
}

/** Made once per process. What makes this start's session token different from every other start's. */
const START_NONCE = randomBytes(32);

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

/**
 * The machine's secret: the saved one, or a new one written in its place.
 *
 * `created` says whether a studio has to be paired: always, now, because the
 * token a studio holds is this start's session token and no earlier pairing
 * survives a restart. (`relay connect` opens the pairing page at once when it
 * is true.) `written` says whether the file itself was made or replaced.
 */
export async function loadPairingToken(options: { rotate?: boolean } = {}): Promise<{ token: string; created: boolean; written: boolean }> {
  const path = pairingPath();
  if (options.rotate !== true) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<PairingFile>;
      if (typeof parsed.token === 'string' && parsed.token.length >= 32) return { token: parsed.token, created: true, written: false };
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
  return { token, created: true, written: true };
}

/**
 * The token a studio presents to the companion in this process: an HMAC of
 * this start's nonce under the machine's secret. Knowing one start's token
 * says nothing about the secret or about the next start's.
 */
export function sessionToken(secret: string): string {
  return createHmac('sha256', secret).update('relay-companion-session:').update(START_NONCE).digest('base64url');
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

/**
 * The link that pairs a studio. `secret` is the machine's secret; what rides
 * in the link is this start's session token, never the secret, and it rides
 * in the fragment, which never reaches a server.
 */
export function pairingUrl(studioUrl: string, port: number, secret: string): string {
  const base = studioUrl.replace(/\/+$/, '');
  const fragment = new URLSearchParams({ port: String(port), token: sessionToken(secret) }).toString();
  return `${base}/connect#${fragment}`;
}

/* ------------------------------------------------------------------ */
/* Opening the pairing link without putting it on a command line       */
/* ------------------------------------------------------------------ */

/**
 * The pairing link holds the session token, and opening a link means handing
 * it to another program as an argument: `open <url>`, `xdg-open <url>`. An
 * argument is readable by every user on the machine for as long as that
 * program runs, and on Linux the browser itself can end up holding it for
 * hours. So the link is not what is opened. The companion keeps the link
 * under a random, single-use ticket and the browser is sent to
 * `http://127.0.0.1:<port>/pair/<ticket>`, which answers with a redirect to
 * the real link. What shows in `ps` is a ticket that has already been spent.
 */

const TICKET_TTL_MS = 2 * 60_000;
const tickets = new Map<string, { url: string; expiresAt: number }>();
/** Ports a companion in this process is listening on: the only ones a ticket can be redeemed at. */
const listening = new Set<number>();

export function companionListening(port: number, on: boolean): void {
  if (on) listening.add(port);
  else listening.delete(port);
}

/**
 * If `url` is a pairing link for a companion in this process, the loopback
 * address to open in its place; otherwise null, and the caller opens `url`.
 */
export function pairingTicketUrl(url: string, now: number = Date.now()): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ''));
  const port = Number(fragment.get('port'));
  if (!fragment.has('token') || !Number.isInteger(port) || !listening.has(port)) return null;
  for (const [ticket, entry] of tickets) if (entry.expiresAt <= now) tickets.delete(ticket);
  const ticket = randomBytes(24).toString('base64url');
  tickets.set(ticket, { url, expiresAt: now + TICKET_TTL_MS });
  return `http://127.0.0.1:${port}/pair/${ticket}`;
}

/** The link a ticket stands for, once: a second ask for the same ticket gets nothing. */
export function redeemPairingTicket(ticket: string, now: number = Date.now()): string | null {
  const entry = tickets.get(ticket);
  if (entry === undefined) return null;
  tickets.delete(ticket);
  return entry.expiresAt > now ? entry.url : null;
}
